/**
 * Build localhost URLs for rendered audio files.
 *
 * On Android, Tauri's built-in `asset://` protocol routes through the
 * WebView's `shouldInterceptRequest`, which Android's media player mishandles
 * for streamed media — playback cuts off after ~10s with `MEDIA_ERR_NETWORK`.
 * The backend instead runs a tiny loopback HTTP server (`audio_server.rs`)
 * that serves `tracks_dir` at `/tracks/...` with full Range/206 support, and
 * the media player fetches from it as a real network socket. This module turns
 * the absolute track paths the backend emits into URLs on that server.
 *
 * The base URL (with the per-launch `?t=<token>`) is fetched once from the
 * `get_audio_base_url` command and cached for the app's lifetime.
 */

import { invoke } from "@tauri-apps/api/core";

let cachedBase: string | null = null;
let pendingBase: Promise<string> | null = null;

/**
 * The cached base URL of the audio server, e.g.
 * `http://127.0.0.1:43219?t=<token>`. The first call fetches it from the
 * backend via `get_audio_base_url`; subsequent calls return the memoized
 * value. Concurrent callers share the in-flight promise.
 */
export async function audioBaseUrl(): Promise<string> {
  if (cachedBase) return cachedBase;
  if (pendingBase) return pendingBase;
  pendingBase = (async () => {
    const url = await invoke<string>("get_audio_base_url");
    cachedBase = url;
    pendingBase = null;
    console.log(`[audioUrl] base URL: ${url}`);
    return url;
  })();
  return pendingBase;
}

/**
 * Synchronously return the cached base URL, or null if it hasn't been
 * fetched yet. Useful for debug displays that don't want to await.
 */
export function getCachedBaseUrl(): string | null {
  return cachedBase;
}

/**
 * The path segment the server serves `tracks_dir` under. Must match the
 * `nest_service("/tracks", ...)` call in `audio_server.rs`.
 */
const TRACKS_MOUNT = "/tracks/";

/**
 * Turn an absolute track path (as emitted by the backend's
 * `read_manifest` / `list_tracks`) into a URL on the audio server.
 *
 * Example:
 *   in:  /data/user/0/com.sylm54.train/tracks/hypnos_x/seg-000.wav
 *   out: http://127.0.0.1:43219?t=<token>/tracks/hypnos_x/seg-000.wav
 *
 * The backend always emits absolute paths under `tracks_dir`, so we strip
 * everything up to and including the `/tracks/` segment and append the
 * remainder (path-encoded) to the base URL. The leading `?t=<token>` query
 * is preserved; the remainder is appended as a path before the query.
 */
export async function audioUrlForPath(absPath: string): Promise<string> {
  const base = await audioBaseUrl();
  // Locate the `/tracks/` segment and keep everything after it (relative to
  // the served dir). Normalize both separators in case of Windows-style paths.
  const normalized = absPath.replace(/\\/g, "/");
  const idx = normalized.indexOf(TRACKS_MOUNT);
  const rel = idx >= 0 ? normalized.slice(idx + TRACKS_MOUNT.length) : normalized;
  // The base already ends with `?t=<token>`. Insert the path BEFORE the query
  // so the final URL is `<base>/tracks/<rel>?<query>` — well-formed (path
  // before query) and the token stays intact.
  const [beforeQuery, query = ""] = base.split("?", 2);
  const pathPart = `${TRACKS_MOUNT}${rel
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
  const url = query ? `${beforeQuery}${pathPart}?${query}` : `${beforeQuery}${pathPart}`;
  console.log(`[audioUrl] ${absPath} → ${url}`);
  return url;
}
