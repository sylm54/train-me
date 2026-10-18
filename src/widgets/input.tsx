/**
 * `input` — free text with a submit button.
 *
 * Props: `submit` (the button text, required), optional `label`,
 * `placeholder`, `multiline` (default false — a one-line Input; true
 * renders a Textarea). Every keystroke emits `change` with the draft
 * and mirrors it into `w.state.text`. Submitting (button click, or
 * Enter in the one-line field) completes the widget — `await w.done`
 * resolves to the submitted text; further edits keep emitting `change`.
 */

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { WidgetComponentProps } from "@/widgets/registry";

export interface InputWidgetProps {
  submit: string;
  label?: string;
  placeholder?: string;
  multiline?: boolean;
}

export function validateInputProps(
  props: Record<string, unknown>,
): InputWidgetProps {
  if (typeof props.submit !== "string" || props.submit.length === 0) {
    throw new Error("props.submit must be a non-empty string (button text)");
  }
  if (props.label !== undefined && typeof props.label !== "string") {
    throw new Error("props.label must be a string when present");
  }
  if (props.placeholder !== undefined && typeof props.placeholder !== "string") {
    throw new Error("props.placeholder must be a string when present");
  }
  if (props.multiline !== undefined && typeof props.multiline !== "boolean") {
    throw new Error("props.multiline must be a boolean when present");
  }
  return {
    submit: props.submit,
    multiline: props.multiline ?? false,
    ...(props.label === undefined ? {} : { label: props.label }),
    ...(props.placeholder === undefined ? {} : { placeholder: props.placeholder }),
  };
}

export function InputWidget({
  props,
  control,
}: WidgetComponentProps<InputWidgetProps>) {
  const [draft, setDraft] = useState("");

  const change = (text: string) => {
    setDraft(text);
    control.setState({ text });
    control.emit("change", text);
  };

  const submit = () => control.complete(draft);

  return (
    <div className="flex h-full flex-col gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-background)] p-4">
      {props.label !== undefined && (
        <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-muted-foreground)]">
          {props.label}
        </h2>
      )}
      {props.multiline ? (
        <Textarea
          value={draft}
          placeholder={props.placeholder}
          onChange={(e) => change(e.target.value)}
          className="min-h-0 flex-1 resize-none"
        />
      ) : (
        <Input
          value={draft}
          placeholder={props.placeholder}
          onChange={(e) => change(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
      )}
      <Button className="w-full" onClick={submit}>
        {props.submit}
      </Button>
    </div>
  );
}
