/**
 * Foreground tracking for the app window.
 *
 * The engine delivers immediate feedback (in-app notice overlays, script
 * jingles) only while the user is actually in the app; otherwise it falls
 * back to OS notifications. "In app" combines three signals, since no
 * single one is reliable across desktop and mobile:
 *
 *   - `document.hasFocus()` — false on desktop when the window loses focus
 *     (even while visible), false on mobile when the activity pauses.
 *   - `document.visibilityState` — the WebView reports `hidden` when the
 *     app is backgrounded on Android/iOS.
 *   - Tauri's window focus events — mirrors the native window focus.
 *
 * The hook returns a stable getter (not state) so event listeners can read
 * the value at delivery time without re-subscribing.
 */

import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

export function useAppForeground(): () => boolean {
  const foreground = useRef(true);
  const tauriFocused = useRef<boolean | null>(null);

  useEffect(() => {
    const sync = () => {
      foreground.current =
        document.hasFocus() &&
        document.visibilityState === "visible" &&
        tauriFocused.current !== false;
    };
    sync();
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);
    document.addEventListener("visibilitychange", sync);
    let un: (() => void) | undefined;
    void getCurrentWindow()
      .onFocusChanged(({ payload }) => {
        tauriFocused.current = payload;
        sync();
      })
      .then((f) => {
        un = f;
      })
      .catch(() => {
        // Not a windowed environment — the document signals suffice.
      });
    return () => {
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
      document.removeEventListener("visibilitychange", sync);
      un?.();
    };
  }, []);

  return () => foreground.current;
}
