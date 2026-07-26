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
use std::path::PathBuf;

use axum::{
    extract::{Request, State},
    http::StatusCode,
    middleware::Next,
    response::Response,
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

/// A per-launch access token + the `tracks/` directory the server serves.
///
/// Held in axum state so the auth middleware can check the incoming token
/// without re-reading shared state on every request.
#[derive(Clone)]
struct AudioServerState {
    token: String,
}

/// Build the router that serves `tracks_dir` under `/tracks/...` with full
/// Range/206 support (via `tower-http`'s `ServeDir`). Every request is gated
/// behind the token middleware so a port-scanner without the token gets `404`
/// (not `401`).
fn audio_router(tracks_dir: PathBuf, token: String) -> Router {
    // `from_fn_with_state` clones the state into each request, so a single
    // owned `AudioServerState` here is fine. The router itself has no
    // handler-level state (ServeDir and the middleware carry their own), so
    // we bind it to `()` via `with_state` to pin the `Router<()>` type.
    Router::new()
        .nest_service("/tracks", ServeDir::new(tracks_dir))
        .layer(axum::middleware::from_fn_with_state(
            AudioServerState { token },
            require_token,
        ))
        .layer(
            CorsLayer::permissive()
                // Only allow the WebView's origin (tauri://localhost on Android,
                // https://tauri.localhost on desktop) so other local apps can't
                // use the audio server as a proxy. The token check still applies.
                .allow_origin(tower_http::cors::Any),
        )
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

/// Bind a loopback listener on an OS-assigned port and start serving `tracks_dir`
/// at `/tracks/...`. Returns the bound address (so the caller can build the
/// base URL) and a detached task handle.
///
/// The listener is read for its `local_addr()` *before* being moved into
/// `axum::serve` (which consumes it).
pub async fn bind_audio_server(
    tracks_dir: PathBuf,
    token: String,
) -> std::io::Result<(SocketAddr, JoinHandle<()>)> {
    // ":0" → OS picks a free ephemeral port. Loopback only (see module docs).
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;

    let app = audio_router(tracks_dir, token);
    let handle = tauri::async_runtime::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            log::error!("audio server exited: {e}");
        }
    });

    Ok((addr, handle))
}
