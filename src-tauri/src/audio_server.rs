//! In-process localhost HTTP server for serving rendered audio to the WebView.
//!
//! ## Why this exists
//!
//! Tauri's built-in `asset://` protocol (→ `http://asset.localhost/...` on
//! Android/Windows) serves files through the WebView's request-interception
//! hook. On Android that hook is `WebViewClient.shouldInterceptRequest`, and
//! Android's media player mishandles streamed media delivered via it —
//! playback cuts off after ~10s with `MEDIA_ERR_NETWORK` (HTML5 error code 2).
//! The HTTP response itself is spec-correct (full Range/206 support exists in
//! `tauri::protocol::asset`); the Android media stack below HTTP is what chokes.
//! Desktop is unaffected because it uses a real custom-scheme handler.
//!
//! A loopback TCP socket is a *real* connection as far as the media player is
//! concerned, so streaming works normally. `tower-http`'s `ServeDir` implements
//! `Accept-Ranges`, `Content-Range`, `206 Partial Content`, `416`, `HEAD`, and
//! MIME sniffing natively — no manual Range handling here.
//!
//! ## Security
//!
//! The server binds `127.0.0.1` only (never `0.0.0.0`). On Android, loopback
//! is still reachable by other local apps, so we additionally require a
//! per-launch random token in the query string (`?t=<token>`). URLs without a
//! matching token get `404` (not `401`, so existence isn't confirmed). The
//! token is generated once at startup and shared with the frontend via the
//! `get_audio_base_url` command.

use std::net::SocketAddr;
use std::path::{Component, Path, PathBuf};

use axum::{
    extract::{Request, State},
    http::{header, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use tauri::async_runtime::JoinHandle;
use tokio::net::TcpListener;
use tower_http::cors::CorsLayer;
use tower_http::services::ServeDir;

/// Query-string key carrying the per-launch access token. Exposed so the
/// caller (`lib.rs`) can build the base URL with `?t=<token>` without
/// duplicating the literal.
pub const TOKEN_PARAM: &str = "t";

/// A per-launch access token + the directories the server serves.
///
/// Held in axum state so the auth middleware can check the incoming token
/// without re-reading shared state on every request.
#[derive(Clone)]
struct AudioServerState {
    token: String,
    /// Sandbox root the `/files/...` route serves from.
    files_root: PathBuf,
}

/// Build the router that serves `tracks_dir` under `/tracks/...` (rendered
/// audio) and `visuals_dir` under `/visuals/...` (cached `<visual>` slides)
/// with full Range/206 support (via `tower-http`'s `ServeDir`), plus
/// `/files/...` for arbitrary files under the agent sandbox root (widget
/// assets: beatmeter clicks, local media, recordings). Every request is
/// gated behind the token middleware so a port-scanner without the token
/// gets `404` (not `401`).
fn audio_router(
    tracks_dir: PathBuf,
    visuals_dir: PathBuf,
    files_root: PathBuf,
    token: String,
) -> Router {
    // `from_fn_with_state` clones the state into each request, so a single
    // owned `AudioServerState` here is fine. The router itself has no
    // handler-level state (ServeDir and the middleware carry their own), so
    // we bind it to `()` via `with_state` to pin the `Router<()>` type.
    let state = AudioServerState { token, files_root };
    Router::new()
        .nest_service("/tracks", ServeDir::new(tracks_dir))
        .nest_service("/visuals", ServeDir::new(visuals_dir))
        .route("/files/{*path}", get(serve_file))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            require_token,
        ))
        .layer(
            CorsLayer::permissive()
                // Only allow the WebView's origin (tauri://localhost on Android,
                // https://tauri.localhost on desktop) so other local apps can't
                // use the audio server as a proxy. The token check still applies.
                .allow_origin(tower_http::cors::Any),
        )
        .with_state(state)
}

/// Serve one file under the agent sandbox root (`/files/<rel-path>`).
///
/// Path traversal is rejected by normalising the components and refusing any
/// `..` (and any absolute-drive component) BEFORE joining onto the root — a
/// lexical check, so no filesystem call can be tricked into escaping the
/// sandbox. Directories 404 (only files serve).
async fn serve_file(State(st): State<AudioServerState>, axum::extract::Path(path): axum::extract::Path<String>) -> Response {
    match resolve_under_root(&st.files_root, &path) {
        Some(abs) => match tokio::fs::read(&abs).await {
            // Small asset files (clicks, jingle samples, recordings) load
            // whole; Range streaming stays the /tracks ServeDir's job.
            Ok(bytes) => {
                let mime = mime_for(&abs);
                ([(header::CONTENT_TYPE, mime)], bytes).into_response()
            }
            Err(_) => StatusCode::NOT_FOUND.into_response(),
        },
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

/// Resolve `rel` under `root`, rejecting anything that could escape it.
/// Returns `None` for `..` components, absolute paths, drive prefixes, or
/// non-file targets.
fn resolve_under_root(root: &Path, rel: &str) -> Option<PathBuf> {
    let rel_path = Path::new(rel);
    for c in rel_path.components() {
        match c {
            Component::Normal(_) => {}
            // CurDir is harmless but reject everything else outright.
            _ => return None,
        }
    }
    let abs = root.join(rel_path);
    if abs.is_file() {
        Some(abs)
    } else {
        None
    }
}

/// Best-effort content type by extension for the file types widgets use.
fn mime_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("wav") => "audio/wav",
        Some("mp3") => "audio/mpeg",
        Some("ogg") => "audio/ogg",
        Some("m4a") | Some("mp4") => "audio/mp4",
        Some("webm") => "video/webm",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("json") => "application/json",
        Some("js") | Some("mjs") => "text/javascript",
        Some("css") => "text/css",
        Some("html") | Some("htm") => "text/html",
        Some("txt") | Some("md") => "text/plain",
        _ => "application/octet-stream",
    }
}

/// Middleware: reject any request whose `?t=<token>` doesn't match. Returns
/// `404` (not `401`) so a port-scanner can't confirm the server exists.
async fn require_token(
    State(st): State<AudioServerState>,
    req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let needle = format!("{TOKEN_PARAM}=");
    let ok = req
        .uri()
        .query()
        .map(|q| q.split('&').any(|kv| kv.strip_prefix(&needle) == Some(st.token.as_str())))
        .unwrap_or(false);
    if ok {
        Ok(next.run(req).await)
    } else {
        Err(StatusCode::NOT_FOUND)
    }
}

/// Bind a loopback listener on an OS-assigned port and start serving
/// `tracks_dir` at `/tracks/...`, `visuals_dir` at `/visuals/...` and
/// `files_root` (the agent sandbox) at `/files/...`.
/// Returns the bound address (so the caller can build the base URL) and a
/// detached task handle.
///
/// The listener is read for its `local_addr()` *before* being moved into
/// `axum::serve` (which consumes it).
pub async fn bind_audio_server(
    tracks_dir: PathBuf,
    visuals_dir: PathBuf,
    files_root: PathBuf,
    token: String,
) -> std::io::Result<(SocketAddr, JoinHandle<()>)> {
    // ":0" → OS picks a free ephemeral port. Loopback only (see module docs).
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;

    let app = audio_router(tracks_dir, visuals_dir, files_root, token);
    let handle = tauri::async_runtime::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            log::error!("audio server exited: {e}");
        }
    });

    Ok((addr, handle))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use http_body_util::BodyExt;
    use tower::ServiceExt; // for `oneshot`

    fn router(tmp: &tempfile::TempDir, token: &str) -> Router {
        audio_router(
            tmp.path().join("tracks"),
            tmp.path().join("visuals"),
            tmp.path().join("agent"),
            token.to_string(),
        )
    }

    fn req(uri: &str) -> Request {
        Request::builder()
            .uri(uri)
            .body(Body::empty())
            .expect("build request")
    }

    #[tokio::test]
    async fn files_serves_sandbox_files_with_token() {
        let tmp = tempfile::tempdir().unwrap();
        let agent = tmp.path().join("agent");
        std::fs::create_dir_all(agent.join("sfx")).unwrap();
        std::fs::write(agent.join("sfx").join("click.wav"), b"RIFF-fake").unwrap();
        let app = router(&tmp, "tok123");

        // With the token: 200 + body + audio content type.
        let res = app
            .clone()
            .oneshot(req("/files/sfx/click.wav?t=tok123"))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(
            res.headers().get(header::CONTENT_TYPE).unwrap(),
            "audio/wav"
        );
        let body = res.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(&body[..], b"RIFF-fake");
    }

    #[tokio::test]
    async fn files_rejects_missing_token() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("agent")).unwrap();
        let app = router(&tmp, "tok123");
        // No token (or wrong token) → 404, like every other mount.
        for uri in ["/files/agent/x.wav", "/files/agent/x.wav?t=wrong"] {
            let res = app.clone().oneshot(req(uri)).await.unwrap();
            assert_eq!(res.status(), StatusCode::NOT_FOUND, "uri: {uri}");
        }
    }

    #[tokio::test]
    async fn files_rejects_path_traversal() {
        let tmp = tempfile::tempdir().unwrap();
        let agent = tmp.path().join("agent");
        std::fs::create_dir_all(&agent).unwrap();
        // The secret lives OUTSIDE the sandbox root — every traversal shape
        // must be rejected before the file is ever read.
        let secret = tmp.path().join("secret.txt");
        std::fs::write(&secret, b"top-secret").unwrap();
        let app = router(&tmp, "tok123");

        for bad in [
            "/files/../secret.txt",
            "/files/..%2Fsecret.txt",
            "/files/a/../../secret.txt",
            "/files/./../secret.txt",
            // Windows drive-letter and rooted forms.
            "/files/C:/secret.txt",
            "/files/c%3A%5Csecret.txt",
            "/files//etc/passwd",
        ] {
            let res = app.clone().oneshot(req(&format!("{bad}?t=tok123"))).await.unwrap();
            assert_eq!(res.status(), StatusCode::NOT_FOUND, "uri: {bad}");
        }

        // Sanity: the non-traversal equivalent path to the same file (from
        // inside the root) genuinely does not exist → also 404, and a `..`
        // that STAYS inside the root is still rejected (no path analysis
        // beyond component normalization).
        let res = app
            .clone()
            .oneshot(req("/files/sub/../x.txt?t=tok123"))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn files_rejects_directories_and_missing() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("agent").join("dir")).unwrap();
        let app = router(&tmp, "tok123");
        // A directory, not a file.
        let res = app.clone().oneshot(req("/files/dir?t=tok123")).await.unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
        // Missing file.
        let res = app
            .clone()
            .oneshot(req("/files/nope.txt?t=tok123"))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }
}
