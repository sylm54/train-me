/**
 * In-app link resolution for markdown content.
 *
 * Markdown bodies rendered in Rules / Routines / Today may contain
 * links like:
 *
 *   [item](inventory/items#42)
 *   [routine](routines/morning.md)
 *
 * This module resolves such paths to a {view, anchor?} pair so the
 * renderer can call `setView(view)` and (optionally) scroll to a fragment.
 */

import { useEffect, useRef } from "react";

import type { View } from "./views";

export interface AppLink {
  view: View;
  /** Optional fragment (e.g. an item id or filename stem). */
  anchor?: string;
}

/**
 * Resolve an in-app path to an AppLink, or null if the path is external /
 * unrecognised. Recognised prefixes (relative, no leading slash):
 *
 *   routines/       → "today"
 *   inventory/      → "inventory"
 */
export function resolveAppPath(href: string): AppLink | null {
  // Strip whitespace and a leading "./".
  let h = href.trim();
  if (h.startsWith("./")) h = h.slice(2);

  // Reject anything that's clearly an external URL.
  if (/^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith("//")) {
    return null;
  }

  // Split off any "#fragment".
  let anchor: string | undefined;
  const hashIdx = h.indexOf("#");
  if (hashIdx !== -1) {
    anchor = h.slice(hashIdx + 1).trim() || undefined;
    h = h.slice(0, hashIdx);
  }
  // Strip a trailing filename — we route by directory, not by file.
  // (e.g. "rules/foo.md" → view "rules", anchor "foo".)
  h = h.trim();

  // Bare feature name → that view.
  switch (h) {
    case "inventory":
    case "inventory/items":
      return { view: "inventory", anchor };
    case "routines":
    case "rules":
    case "today":
      return { view: "today", anchor };
  }

  // Directory-prefixed path. Use the first segment to pick the view;
  // if there's a second segment, derive a stable anchor from its stem.
  const segs = h.split(/[\\/]+/).filter(Boolean);
  if (segs.length === 0) return null;

  const head = segs[0].toLowerCase();
  let view: View | null = null;
  switch (head) {
    case "routines":
    case "routine":
    case "rules":
    case "rule":
      view = "today";
      break;
    case "inventory":
      view = "inventory";
      break;
  }

  if (!view) return null;

  // Derive anchor from filename stem if one is present and no #fragment
  // was given.
  if (!anchor && segs.length >= 2) {
    const file = segs[segs.length - 1];
    const stem = file.replace(/\.[^.]+$/, "");
    if (stem) anchor = stem;
  }

  return { view, anchor };
}

/**
 * Install a single, app-wide click interceptor that routes in-app `<a>`
 * links (see `resolveAppPath`) to `onNavigate`, suppressing the default
 * navigation that would otherwise trigger Tauri's "Open external link?"
 * confirmation.
 *
 * Uses the **capture** phase so the handler runs before the Tauri opener
 * plugin's bubble-phase listener (which respects `defaultPrevented`) and
 * before the webview initiates any navigation. This catches links no
 * matter which renderer produced them (MarkdownBody, MessageResponse, …)
 * without each component having to wire up its own `onClick`.
 *
 * External / unrecognised links are left untouched.
 */
export function useGlobalAppLinkNavigation(onNavigate: (view: View) => void) {
  // Keep the latest callback without re-registering the listener.
  const ref = useRef(onNavigate);
  ref.current = onNavigate;

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      // Only handle plain left-clicks without modifiers.
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
        return;
      }
      const target = e.target;
      if (!(target instanceof Element)) return;
      const a = target.closest("a");
      if (!a) return;
      const href = a.getAttribute("href") ?? "";
      if (!href) return;
      const link = resolveAppPath(href);
      if (!link) return;
      // It's an in-app link: navigate and suppress default navigation.
      e.preventDefault();
      ref.current(link.view);
    };

    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);
}
