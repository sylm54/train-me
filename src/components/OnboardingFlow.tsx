/**
 * Stepper for the framework onboarding flow (setup-wizard step).
 *
 * Renders one screen at a time — the leading text blocks plus the next
 * visible unresolved question — asking the backend for the next screen
 * after every answer, so `showIf` conditionals hide/show live without
 * any duplicated logic on this side. Optional questions may be skipped
 * (stored as `null`). Non-open questions (choice, rating, ranking) also
 * get an optional free-text clarification, stored under the `note:<id>`
 * answer key and only kept alongside an actual answer. When the flow
 * completes it saves the session (which regenerates `agent_data/USER.md`)
 * and calls `onFinish`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownBody } from "@/components/MarkdownBody";
import {
  fetchOnboardingStep,
  noteKey,
  saveOnboardingAnswers,
  type AnswerMap,
  type AnswerValue,
  type OnboardingStep,
  type QuestionItem,
} from "@/lib/onboarding";

interface Props {
  onFinish: () => void;
}

function isAnswered(answer: AnswerValue | undefined): boolean {
  if (answer === undefined || answer === null) return false;
  if (typeof answer === "string") return answer.trim().length > 0;
  if (Array.isArray(answer)) return answer.length > 0;
  return true;
}

/**
 * The ranking a `ranking` question is currently showing: the draft array
 * when it's a full permutation of the choices, otherwise the choices in
 * their listed order (the default ranking).
 */
function rankingOrder(
  q: QuestionItem,
  draft: AnswerValue | undefined,
): string[] {
  const choices = q.choices ?? [];
  if (
    Array.isArray(draft) &&
    draft.length === choices.length &&
    draft.every((c) => choices.includes(c))
  ) {
    return draft;
  }
  return choices;
}

export function OnboardingFlow({ onFinish }: Props) {
  const [step, setStep] = useState<OnboardingStep | null>(null);
  const [session, setSession] = useState<AnswerMap>({});
  /** Ids answered this session, in order — powers Back. */
  const [history, setHistory] = useState<string[]>([]);
  const [draft, setDraft] = useState<AnswerValue | undefined>(undefined);
  /** Clarification for non-open questions (stored under `note:<id>`). */
  const [noteDraft, setNoteDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const load = useCallback(async (answers: AnswerMap) => {
    setBusy(true);
    setError(null);
    try {
      const next = await fetchOnboardingStep(answers);
      setStep(next);
      // Pre-fill the draft when re-visiting an answered question (Back).
      // Ranking questions also pre-fill on first visit: a ranking is always
      // a complete answer, so it starts as the choices' listed order.
      const q = next.question;
      if (!q) {
        setDraft(undefined);
      } else if (q.id in answers) {
        setDraft(answers[q.id]);
      } else if (q.answer === "ranking") {
        setDraft(q.choices ?? []);
      } else {
        setDraft(undefined);
      }
      const note = q && q.answer !== "open" ? answers[noteKey(q.id)] : undefined;
      setNoteDraft(typeof note === "string" ? note : "");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const advance = async (answer: AnswerValue | undefined) => {
    const q = step?.question;
    if (!q) return;
    const next = { ...sessionRef.current };
    // `undefined` = the user skipped an optional question — store the
    // explicit `null` so the backend counts it as resolved (not answered).
    next[q.id] = answer === undefined ? null : answer;
    // Non-open questions carry an optional clarification under `note:<id>`;
    // it only makes sense alongside an actual answer.
    const key = noteKey(q.id);
    const note =
      q.answer !== "open" && answer !== undefined ? noteDraft.trim() : "";
    if (note) next[key] = note;
    else delete next[key];
    setSession(next);
    setHistory((h) => [...h.filter((id) => id !== q.id), q.id]);
    setBusy(true);
    setError(null);
    try {
      const nextStep = await fetchOnboardingStep(next);
      setStep(nextStep);
      setDraft(nextStep.question ? next[nextStep.question.id] : undefined);
      // Reset the clarification draft for the new question — otherwise the
      // previous question's note lingers in the textarea and gets saved
      // under the next question's `note:<id>` key. Pre-fill when the next
      // question was already answered (Back then forward again).
      const nq = nextStep.question;
      const nextNote =
        nq && nq.answer !== "open" ? next[noteKey(nq.id)] : undefined;
      setNoteDraft(typeof nextNote === "string" ? nextNote : "");
      if (nextStep.question === null && nextStep.remaining === 0) {
        setSaving(true);
        try {
          await saveOnboardingAnswers(next);
          onFinish();
        } catch (e) {
          setError(String(e));
        } finally {
          setSaving(false);
        }
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const goBack = async () => {
    const last = history[history.length - 1];
    if (!last) return;
    const next = { ...sessionRef.current };
    delete next[last];
    setSession(next);
    setHistory((h) => h.slice(0, -1));
    await load(next);
  };

  if (error) {
    return (
      <div className="space-y-3">
        <div className="text-sm text-[var(--color-danger)]">{error}</div>
        <Button variant="outline" size="sm" onClick={() => void load(sessionRef.current)}>
          Retry
        </Button>
      </div>
    );
  }
  if (!step || busy || saving) {
    return (
      <div className="grid place-items-center py-10">
        <Spinner className="size-6" />
      </div>
    );
  }

  const q = step.question;
  const answeredCount = step.total - step.remaining + (q ? 1 : 0);

  /** Swap a ranking entry with its neighbour (delta −1 = up, +1 = down). */
  const moveChoice = (index: number, delta: number) => {
    if (!q || q.answer !== "ranking") return;
    const order = rankingOrder(q, draft);
    const j = index + delta;
    if (j < 0 || j >= order.length) return;
    const next = [...order];
    [next[index], next[j]] = [next[j], next[index]];
    setDraft(next);
  };

  return (
    <div className="space-y-5">
      {step.total > 0 && (
        <div className="text-xs text-muted-foreground">
          Question {Math.min(answeredCount, step.total)} of {step.total}
        </div>
      )}

      {step.texts.map((text, i) => (
        <MarkdownBody key={i}>{text}</MarkdownBody>
      ))}

      {q ? (
        <div className="rounded-lg border border-[var(--color-border)] p-4 space-y-3">
          <div className="text-sm font-medium">
            {q.prompt}
            {q.optional && (
              <span className="ml-2 text-xs font-normal text-muted-foreground">(optional)</span>
            )}
          </div>
          {q.hint && <div className="text-xs text-muted-foreground">{q.hint}</div>}

          {q.answer === "open" && (
            <Textarea
              value={typeof draft === "string" ? draft : ""}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Your answer…"
              className="min-h-24"
            />
          )}

          {q.answer === "choice" && !q.multiple && (
            <div className="flex flex-wrap gap-2">
              {(q.choices ?? []).map((choice) => (
                <Button
                  key={choice}
                  variant="outline"
                  size="sm"
                  className={draft === choice ? "border-[var(--color-pink-400)]" : ""}
                  onClick={() => setDraft(choice)}
                >
                  {draft === choice && <Check className="size-3.5" />}
                  {choice}
                </Button>
              ))}
            </div>
          )}

          {q.answer === "choice" && q.multiple && (
            <div className="flex flex-wrap gap-2">
              {(q.choices ?? []).map((choice) => {
                const list = Array.isArray(draft) ? draft : [];
                const on = list.includes(choice);
                return (
                  <Button
                    key={choice}
                    variant="outline"
                    size="sm"
                    className={on ? "border-[var(--color-pink-400)]" : ""}
                    onClick={() =>
                      setDraft(on ? list.filter((c) => c !== choice) : [...list, choice])
                    }
                  >
                    {on && <Check className="size-3.5" />}
                    {choice}
                  </Button>
                );
              })}
            </div>
          )}

          {q.answer === "rating" && (
            <div className="flex flex-wrap gap-2">
              {Array.from(
                { length: (q.max ?? 10) - (q.min ?? 1) + 1 },
                (_, i) => (q.min ?? 1) + i,
              ).map((value) => (
                <Button
                  key={value}
                  variant="outline"
                  size="sm"
                  className={`h-8 w-8 p-0 ${draft === value ? "border-[var(--color-pink-400)]" : ""}`}
                  onClick={() => setDraft(value)}
                >
                  {value}
                </Button>
              ))}
            </div>
          )}

          {q.answer === "ranking" && (
            <div className="space-y-1">
              <div className="flex flex-col gap-1">
                {rankingOrder(q, draft).map((choice, i, order) => (
                  <div
                    key={choice}
                    className="flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5"
                  >
                    <span className="w-5 shrink-0 text-center text-xs tabular-nums text-muted-foreground">
                      {i + 1}.
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm">{choice}</span>
                    <span className="flex shrink-0 flex-col">
                      <button
                        type="button"
                        onClick={() => moveChoice(i, -1)}
                        disabled={i === 0}
                        aria-label={`Move ${choice} up`}
                        title="Move up"
                        className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-[var(--color-pink-100)] hover:text-[var(--color-foreground)] disabled:opacity-25"
                      >
                        <ChevronUp className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => moveChoice(i, 1)}
                        disabled={i === order.length - 1}
                        aria-label={`Move ${choice} down`}
                        title="Move down"
                        className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-[var(--color-pink-100)] hover:text-[var(--color-foreground)] disabled:opacity-25"
                      >
                        <ChevronDown className="size-3.5" />
                      </button>
                    </span>
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">
                Order by preference — use the arrows. The current order is
                your answer.
              </p>
            </div>
          )}

          {q.answer !== "open" && (
            <Textarea
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              placeholder="Anything to add or clarify? (optional)"
              className="min-h-16"
            />
          )}

          <div className="flex items-center gap-2 pt-1">
            {history.length > 0 && (
              <Button variant="ghost" size="sm" onClick={() => void goBack()}>
                <ArrowLeft className="size-3.5" /> Back
              </Button>
            )}
            <Button
              size="sm"
              disabled={!isAnswered(draft) && !q.optional}
              onClick={() => void advance(isAnswered(draft) ? draft : undefined)}
            >
              {isAnswered(draft) ? "Continue" : "Skip"}
              <ArrowRight className="size-3.5" />
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Check className="size-4 text-[var(--color-pink-500)]" />
          <span className="text-sm">All set — your profile has been saved.</span>
        </div>
      )}
    </div>
  );
}
