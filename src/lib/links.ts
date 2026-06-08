/**
 * In-app link resolution for markdown content.
 *
 * Markdown bodies rendered in Rules / Routines / Journal / Voice Training
 * may contain links like:
 *
 *   [foo](conditioning/foo.json)
 *   [item](inventory/items#42)
 *   [rule](rule/dress_code.md)
 *   [routine](routines/morning.md)
 *   [journal](journal/2025-06-05-1030.md)
 *   [voice](voice/breathing.md)
 *   [chastity](chastity)
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
 *   conditioning/   → "conditioning"
 *   rule/           → "rules"
 *   rules/          → "rules"
 *   routines/       → "routines"
 *   journal/        → "journal"
 *   voice/          → "voice"
 *   inventory/      → "inventory"
 *   chastity        → "chastity"
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
  // (e.g. "conditioning/foo.json" → view "conditioning", anchor "foo".)
  h = h.trim();

  // Bare feature name → that view.
  switch (h) {
    case "chastity":
      return { view: "chastity", anchor };
    case "inventory":
    case "inventory/items":
      return { view: "inventory", anchor };
    case "conditioning":
      return { view: "conditioning", anchor };
    case "rules":
    case "rule":
      return { view: "rules", anchor };
    case "routines":
      return { view: "routines", anchor };
    case "journal":
      return { view: "journal", anchor };
    case "voice":
      return { view: "voice", anchor };
  }

  // Directory-prefixed path. Use the first segment to pick the view;
  // if there's a second segment, derive a stable anchor from its stem.
  const segs = h.split(/[\\/]+/).filter(Boolean);
  if (segs.length === 0) return null;

  const head = segs[0].toLowerCase();
  let view: View | null = null;
  switch (head) {
    case "conditioning":
      view = "conditioning";
      break;
    case "rule":
    case "rules":
      view = "rules";
      break;
    case "routines":
    case "routine":
      view = "routines";
      break;
    case "journal":
      view = "journal";
      break;
    case "voice":
      view = "voice";
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
