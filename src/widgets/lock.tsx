/**
 * `lock` — the chastity gate (the old v2 chastity feature as a widget).
 *
 * Props: `state` — `"locked"` or `"unlocked"`. The gate wraps the
 * chastity commands: if the device is already in the required state,
 * the widget auto-fulfills (`await w.done` resolves the reached state
 * string); otherwise the transition happens right on the stage:
 *
 *   locked   → the user locks themselves here with a secret code; the
 *              code is hidden (the agent never sees it) and only an
 *              unlock releases the device.
 *   unlocked → the lock releases and the hidden code is revealed (the
 *              agent sanctioned the release by showing this gate). Also
 *              recovers a code left hidden by a headless `chastity
 *              unlock`.
 *
 * The revealed code is shown in the widget and logged to the activity
 * log (recoverable if the reveal screen is missed) — it never crosses
 * back to the script.
 */

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { logActivity } from "@/lib/activity";
import type { WidgetComponentProps } from "@/widgets/registry";

export type LockState = "locked" | "unlocked";

export interface LockWidgetProps {
  state: LockState;
}

export function validateLockProps(
  props: Record<string, unknown>,
): LockWidgetProps {
  if (props.state !== "locked" && props.state !== "unlocked") {
    throw new Error(`props.state must be "locked" or "unlocked"`);
  }
  return { state: props.state };
}

/** Mirrors src-tauri/src/chastity.rs `ChastityState`. */
interface ChastityState {
  locked: boolean;
  hidden_string: string | null;
  revealed: boolean;
  locked_at: string | null;
}

export function LockWidget({
  props,
  control,
}: WidgetComponentProps<LockWidgetProps>) {
  const required = props.state;
  const [state, setState] = useState<ChastityState | null>(null);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Code revealed by an unlock, shown so the user can open the device. */
  const [revealedCode, setRevealedCode] = useState<string | null>(null);
  /** Set once this widget instance has fulfilled (first resolution wins). */
  const [fulfilled, setFulfilled] = useState(false);

  const load = useCallback(() => {
    invoke<ChastityState>("get_chastity_state")
      .then(setState)
      .catch(() => setState(null));
  }, []);
  useEffect(load, [load]);

  const deviceState: LockState | null =
    state === null ? null : state.locked ? "locked" : "unlocked";
  const matches = deviceState === required;
  // Already in the required state (and nothing left to reveal) → fulfilled.
  const autoFulfilled =
    state !== null &&
    matches &&
    (required === "locked" || !state.hidden_string || state.revealed);

  const fulfill = useCallback(
    (value: LockState) => {
      if (fulfilled) return;
      setFulfilled(true);
      control.complete(value);
    },
    [control, fulfilled],
  );

  // Auto-fulfill as soon as the loaded state satisfies the gate.
  useEffect(() => {
    if (state !== null && autoFulfilled) fulfill(required);
  }, [state, autoFulfilled, fulfill, required]);

  const lock = async () => {
    const trimmed = secret.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      const next = await invoke<ChastityState>("chastity_lock", {
        secret: trimmed,
      });
      setState(next);
      setSecret("");
      await logActivity("chastity", "lock", "lock widget");
      fulfill("locked");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const unlock = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await invoke<ChastityState>("chastity_unlock");
      setState(next);
      setRevealedCode(next.hidden_string);
      // The code goes into the activity log too — if the reveal screen is
      // missed, the code stays recoverable from Activity.
      await logActivity(
        "chastity",
        "unlock",
        next.hidden_string
          ? `lock widget — code: ${next.hidden_string}`
          : "lock widget",
      );
      fulfill("unlocked");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col justify-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-background)] p-4">
      {revealedCode !== null ? (
        <div className="rounded-md border border-[var(--color-pink-400)] bg-[var(--color-pink-50)] p-3 text-sm">
          Unlocked — your code:{" "}
          <span className="font-mono font-semibold">{revealedCode}</span>
        </div>
      ) : state === null ? (
        <Spinner className="size-4" />
      ) : autoFulfilled ? (
        <div className="text-sm text-[var(--color-muted-foreground)]">
          Device is already {required} — nothing to do.
        </div>
      ) : required === "locked" ? (
        <div className="space-y-2">
          <div className="text-xs text-[var(--color-muted-foreground)]">
            Put the device on and set the code it will lock with. The app
            hides the code; only an unlock releases it.
          </div>
          <div className="flex gap-2">
            <Input
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="Lock code"
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void lock();
                }
              }}
            />
            <Button size="sm" disabled={busy || !secret.trim()} onClick={() => void lock()}>
              Lock
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="text-xs text-[var(--color-muted-foreground)]">
            {state.locked
              ? "The gate releases the lock and shows you the code."
              : "Your last lock's code hasn't been revealed yet."}
          </div>
          <Button size="sm" disabled={busy} onClick={() => void unlock()}>
            {state.locked ? "Unlock" : "Show my code"}
          </Button>
        </div>
      )}
      {error && <div className="text-xs text-[var(--color-danger)]">{error}</div>}
    </div>
  );
}
