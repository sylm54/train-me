/**
 * Markdown renderer that intercepts clicks on `<a>` tags and routes
 * in-app paths (e.g. `conditioning/foo.json`) via `setView`.
 *
 * External URLs (http/https/mailto/etc.) are left to the browser /
 * Tauri opener plugin.
 */

import { useCallback, type ReactNode } from "react";
import { Streamdown } from "streamdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";

import { resolveAppPath } from "@/lib/links";
import type { View } from "@/lib/views";

interface MarkdownBodyProps {
  children: string;
  className?: string;
  /** Called when an in-app link is clicked, with the resolved target view. */
  onNavigate: (view: View) => void;
}

/**
 * Markdown body wrapper used by Rules / Routines / Journal / Voice.
 * Captures clicks on `<a>` tags and routes recognised in-app paths via
 * `onNavigate`; falls through to default behaviour for external URLs.
 */
export function MarkdownBody({
  children,
  className,
  onNavigate,
}: MarkdownBodyProps) {
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // Only handle plain left-clicks without modifiers.
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
        return;
      }
      const a = (e.target as HTMLElement | null)?.closest("a");
      if (!a) return;
      const href = a.getAttribute("href") ?? "";
      if (!href) return;
      const link = resolveAppPath(href);
      if (!link) return;
      // It's an in-app link: navigate and suppress default navigation.
      e.preventDefault();
      onNavigate(link.view);
    },
    [onNavigate],
  );

  return (
    <div
      onClick={handleClick}
      className={
        "max-w-none text-sm text-[var(--color-foreground)] " +
        BASE_MARKDOWN_STYLES +
        (className ? " " + className : "")
      }
    >
      <Streamdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
      >
        {children}
      </Streamdown>
    </div>
  );
}

/**
 * Shared Tailwind utility classes for markdown bodies rendered inside
 * cards. Kept here so every feature view renders markdown consistently.
 */
export const BASE_MARKDOWN_STYLES =
  "[&_a]:text-[var(--color-pink-700)] [&_a]:underline [&_a:hover]:text-[var(--color-pink-900)] [&_a]:cursor-pointer " +
  "[&_h1]:font-semibold [&_h1]:text-base [&_h1]:mt-4 [&_h1]:mb-2 " +
  "[&_h2]:font-semibold [&_h2]:text-base [&_h2]:mt-4 [&_h2]:mb-2 " +
  "[&_h3]:font-semibold [&_h3]:mt-3 [&_h3]:mb-1.5 " +
  "[&_h4]:font-semibold [&_h4]:mt-3 [&_h4]:mb-1 " +
  "[&_strong]:text-[var(--color-pink-900)] " +
  "[&_blockquote]:border-l-2 [&_blockquote]:border-[var(--color-pink-300)] [&_blockquote]:pl-3 [&_blockquote]:text-[var(--color-muted-foreground)] " +
  "[&_code]:bg-[var(--color-pink-50)] [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded " +
  "[&_ul]:list-disc [&_ul]:pl-5 " +
  "[&_ol]:list-decimal [&_ol]:pl-5 " +
  "[&_li]:my-0.5 " +
  "[&_hr]:border-[var(--color-border)] [&_hr]:my-4 " +
  "[&_table]:border-collapse " +
  "[&_th]:border [&_th]:border-[var(--color-border)] [&_th]:px-2 [&_th]:py-1 [&_th]:bg-[var(--color-pink-50)] " +
  "[&_td]:border [&_td]:border-[var(--color-border)] [&_td]:px-2 [&_td]:py-1";

/** Convenience: the plain class string used by views that just want the
 *  shared style bundle without rendering markdown themselves. */
export function markdownClass(extra?: string): string {
  return BASE_MARKDOWN_STYLES + (extra ? " " + extra : "");
}

// Re-export ReactNode so consumers can type their props without importing
// from "react" separately.
export type { ReactNode };
