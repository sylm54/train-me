/**
 * `text` — the reference display widget.
 *
 * Props: `text` (markdown, rendered via MarkdownBody), optional `title`.
 * Completes immediately on mount: `await w.done` resolves `true`, so a
 * script that only displays it doesn't have to wait on anything. The
 * card stays on the stage until the script hides or removes it.
 */

import { useEffect } from "react";
import { MarkdownBody } from "@/components/MarkdownBody";
import type { WidgetComponentProps } from "@/widgets/registry";

export interface TextWidgetProps {
  text: string;
  title?: string;
}

export function validateTextProps(
  props: Record<string, unknown>,
): TextWidgetProps {
  if (typeof props.text !== "string") {
    throw new Error("props.text must be a string (markdown)");
  }
  if (props.title !== undefined && typeof props.title !== "string") {
    throw new Error("props.title must be a string when present");
  }
  return props.title === undefined
    ? { text: props.text }
    : { text: props.text, title: props.title };
}

export function TextWidget({ props, control }: WidgetComponentProps<TextWidgetProps>) {
  useEffect(() => {
    control.complete(true);
  }, [control]);

  return (
    <div className="h-full overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-background)] p-4">
      {props.title !== undefined && (
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-muted-foreground)]">
          {props.title}
        </h2>
      )}
      <MarkdownBody>{props.text}</MarkdownBody>
    </div>
  );
}
