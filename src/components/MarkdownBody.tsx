/**
 * Styled markdown renderer used by Rules / Routines / Journal / Voice.
 *
 * In-app link clicks (e.g. `conditioning/foo.json`) are handled centrally
 * by `useGlobalAppLinkNavigation` in `App`; external URLs fall through to
 * the browser / Tauri opener plugin.
 */

import { Streamdown } from "streamdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";

interface MarkdownBodyProps {
  children: string;
  className?: string;
}

export function MarkdownBody({ children, className }: MarkdownBodyProps) {
  return (
    <div
      className={
        "max-w-none text-sm text-[var(--color-foreground)] " +
        BASE_MARKDOWN_STYLES +
        (className ? " " + className : "")
      }
    >
      <Streamdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        linkSafety={{ enabled: false }}
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
const BASE_MARKDOWN_STYLES =
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
