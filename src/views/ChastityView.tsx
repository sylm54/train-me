/**
 * Chastity view: lock state, hidden secret, countdown timer.
 *
 * The state lives outside the agent's writable area (in `<app_data>/state/`).
 * We read and write it through dedicated Tauri commands — the agent cannot
 * touch this file directly. We poll it every second so the countdown stays
 * current.
 *
 * UX:
 *   - User can lock (with a secret string).
 *   - The user CANNOT self-unlock — only the agent (via the `chastity unlock`
 *     bash builtin) or the countdown auto-unlock can release the lock.
 *   - When the countdown expires we call `chastity_auto_unlock`, which
 *     clears the lock and reveals the previously-hidden secret.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertCircle,
  Eye,
  EyeOff,
  Loader2,
  Lock,
  Unlock,
  RefreshCw,
  Timer,
  TimerOff,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { tauriErrorToString } from "@/lib/types";
import { logActivity } from "@/lib/activity";

// ──────────────────────────────────────────────────────────────────────────
// State shape (matches the Rust `ChastityState` in builtins.rs)
// ──────────────────────────────────────────────────────────────────────────

interface ChastityState {
  locked: boolean;
  hidden_string: string | null;
  locked_at: string | null;
  countdown_end: string | null;
  countdown_active: boolean;
}

const DEFAULT_STATE: ChastityState = {
  locked: false,
  hidden_string: null,
  locked_at: null,
  countdown_end: null,
  countdown_active: false,
};

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function parseIso(s: string | null): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return "00:00:00";
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  if (days > 0) {
    return `${days}d ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  }
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

function formatTimestamp(s: string | null): string {
  if (!s) return "—";
  const t = parseIso(s);
  if (t === null) return s;
  try {
    return new Date(t).toLocaleString();
  } catch {
    return s;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Component
// ──────────────────────────────────────────────────────────────────────────

export function ChastityView() {
  const [state, setState] = useState<ChastityState>(DEFAULT_STATE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Lock form
  const [secret, setSecret] = useState("");
  const [revealSecret, setRevealSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionFlash, setActionFlash] = useState<string | null>(null);

  // Track whether the auto-unlock rewrite for the *current* lock has already
  // been issued, so we don't fight the user's manual edits in a loop.
  const lastAutoUnlockAtRef = useRef<string | null>(null);

  // ── Load ──────────────────────────────────────────────────────────────

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    if (!silent) setError(null);
    try {
      const parsed = await invoke<ChastityState>("get_chastity_state");
      setState({ ...DEFAULT_STATE, ...parsed });
    } catch (e) {
      setError(tauriErrorToString(e));
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // ── Live tick (for the countdown) ────────────────────────────────────

  useEffect(() => {
    if (!state.countdown_active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [state.countdown_active]);

  // ── Derived countdown state ──────────────────────────────────────────

  const countdownEnd = parseIso(state.countdown_end);
  const countdownRemaining = countdownEnd !== null ? countdownEnd - now : null;
  const countdownExpired =
    state.countdown_active && countdownEnd !== null && now >= countdownEnd;

  // ── Auto-unlock when countdown expires ──────────────────────────────

  useEffect(() => {
    if (!countdownExpired) return;
    // Only trigger once per `locked_at` so we don't loop if the write fails
    // or the user re-locks afterwards.
    if (lastAutoUnlockAtRef.current === state.locked_at) return;
    lastAutoUnlockAtRef.current = state.locked_at;

    (async () => {
      try {
        const next = await invoke<ChastityState>("chastity_auto_unlock");
        setState(next);
        setActionFlash("Countdown expired — unlocked.");
        await logActivity("chastity", "auto_unlock", "countdown expired");
      } catch (e) {
        setActionError(`Auto-unlock failed: ${tauriErrorToString(e)}`);
      }
    })();
  }, [countdownExpired, state]);

  // ── Actions ──────────────────────────────────────────────────────────

  const flash = (msg: string) => {
    setActionFlash(msg);
    setActionError(null);
    window.setTimeout(() => setActionFlash(null), 2500);
  };

  const handleLock = useCallback(async () => {
    const trimmed = secret.trim();
    if (!trimmed) {
      setActionError("Enter a secret string first.");
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      const next = await invoke<ChastityState>("chastity_lock", {
        secret: trimmed,
      });
      lastAutoUnlockAtRef.current = next.locked_at ?? null;
      setState(next);
      setSecret("");
      flash("Locked.");
      await logActivity("chastity", "lock");
    } catch (e) {
      setActionError(tauriErrorToString(e));
    } finally {
      setBusy(false);
    }
  }, [secret]);

  // ── Derived flags ────────────────────────────────────────────────────

  const lockTime = formatTimestamp(state.locked_at);
  const showSecret = !state.locked;
  const headline = useMemo(() => {
    if (state.locked) {
      if (state.countdown_active && countdownRemaining !== null) {
        if (countdownExpired) return "Countdown expired";
        return "Locked";
      }
      return "Locked";
    }
    return "Unlocked";
  }, [
    state.locked,
    state.countdown_active,
    countdownRemaining,
    countdownExpired,
  ]);

  // ── Render ───────────────────────────────────────────────────────────

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-2xl mx-auto p-6 space-y-6">
        <header className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="size-10 rounded-xl bg-[var(--color-pink-100)] grid place-items-center text-[var(--color-pink-600)]">
              <Lock size={18} />
            </div>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">
                Chastity
              </h1>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refresh()}
            disabled={loading}
          >
            {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            Refresh
          </Button>
        </header>

        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-[var(--color-danger)] bg-[var(--color-pink-50)] p-3 text-sm text-[var(--color-danger)]">
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            <div className="flex-1">
              <div className="font-medium">Couldn't load state</div>
              <div className="text-xs opacity-90 break-words">{error}</div>
            </div>
          </div>
        )}

        {/* ── Status card ────────────────────────────────────────────── */}
        <section className="border border-[var(--color-border)] rounded-lg bg-[var(--color-surface)] overflow-hidden">
          <header className="flex items-center justify-between gap-3 px-5 py-3 border-b border-[var(--color-border)] bg-[var(--color-pink-50)]">
            <div className="flex items-center gap-2">
              {state.locked ? (
                <Lock size={16} className="text-[var(--color-pink-600)]" />
              ) : (
                <Unlock
                  size={16}
                  className="text-[var(--color-muted-foreground)]"
                />
              )}
              <h2 className="text-base font-semibold">{headline}</h2>
            </div>
            <Badge
              variant={state.locked ? "default" : "secondary"}
              className="shrink-0"
            >
              {state.locked ? "Locked" : "Unlocked"}
            </Badge>
          </header>

          <div className="px-5 py-4 space-y-3">
            <Row label="Locked since" value={lockTime} />

            {state.countdown_active && countdownRemaining !== null && (
              <Row
                label="Countdown"
                value={
                  <span
                    className={
                      countdownExpired
                        ? "font-mono text-[var(--color-muted-foreground)]"
                        : "font-mono"
                    }
                  >
                    {countdownExpired
                      ? "expired"
                      : formatRemaining(countdownRemaining)}
                  </span>
                }
                icon={
                  countdownExpired ? (
                    <TimerOff
                      size={14}
                      className="text-[var(--color-muted-foreground)]"
                    />
                  ) : (
                    <Timer size={14} className="text-[var(--color-pink-600)]" />
                  )
                }
              />
            )}

            {state.countdown_active && state.countdown_end && (
              <Row
                label="Countdown ends"
                value={formatTimestamp(state.countdown_end)}
              />
            )}

            <Row
              label="Secret"
              value={
                showSecret && state.hidden_string ? (
                  <span className="font-mono text-[var(--color-foreground)]">
                    {revealSecret
                      ? state.hidden_string
                      : "•".repeat(Math.min(state.hidden_string.length, 12))}
                  </span>
                ) : state.locked ? (
                  <span className="text-[var(--color-muted-foreground)]">
                    hidden
                  </span>
                ) : (
                  <span className="text-[var(--color-muted-foreground)]">
                    —
                  </span>
                )
              }
              extra={
                showSecret && state.hidden_string ? (
                  <button
                    type="button"
                    onClick={() => setRevealSecret((v) => !v)}
                    className="text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
                    aria-label={revealSecret ? "Hide" : "Reveal"}
                  >
                    {revealSecret ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                ) : null
              }
            />
          </div>

          {/* ── Locked actions ──────────────────────────────────────── */}
          {state.locked && (
            <div className="border-t border-[var(--color-border)] px-5 py-3 bg-[var(--color-surface-muted)] flex flex-wrap gap-2">
              <p className="text-xs text-[var(--color-muted-foreground)] w-full">
                Only the agent can unlock you.
              </p>
            </div>
          )}
        </section>

        {/* ── Lock form (only when unlocked) ────────────────────────── */}
        {!state.locked && (
          <section className="border border-[var(--color-border)] rounded-lg bg-[var(--color-surface)] overflow-hidden">
            <header className="px-5 py-3 border-b border-[var(--color-border)] bg-[var(--color-pink-50)]">
              <h2 className="text-base font-semibold">
                Lock with a new secret
              </h2>
            </header>
            <div className="px-5 py-4 flex flex-wrap items-end gap-3">
              <div className="flex-1 min-w-[200px] space-y-1.5">
                <label className="text-xs text-[var(--color-muted-foreground)]">
                  Code
                </label>
                <Input
                  type={revealSecret ? "text" : "password"}
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder="Lockbox pin"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleLock();
                    }
                  }}
                />
              </div>
              <Button
                onClick={handleLock}
                disabled={busy || !secret.trim()}
                size="sm"
              >
                {busy ? <Loader2 className="animate-spin" /> : <Lock />}
                Lock
              </Button>
            </div>
          </section>
        )}

        {/* ── Inline status ─────────────────────────────────────────── */}
        {actionError && (
          <div className="flex items-start gap-2 text-sm text-[var(--color-danger)]">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <span className="break-words">{actionError}</span>
          </div>
        )}
        {actionFlash && (
          <div className="text-xs text-[var(--color-muted-foreground)]">
            {actionFlash}
          </div>
        )}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Row helper
// ──────────────────────────────────────────────────────────────────────────

interface RowProps {
  label: string;
  value: React.ReactNode;
  icon?: React.ReactNode;
  extra?: React.ReactNode;
}

function Row({ label, value, icon, extra }: RowProps) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="text-xs uppercase tracking-wider text-[var(--color-muted-foreground)] w-32 shrink-0 flex items-center gap-1.5">
        {icon}
        {label}
      </span>
      <span className="text-sm flex-1 min-w-0 break-words">{value}</span>
      {extra}
    </div>
  );
}
