/**
 * Stepper for the framework onboarding flow (setup-wizard step).
 *
 * Renders one screen at a time — the leading text blocks plus the next
 * visible unresolved question — asking the backend for the next screen
 * after every answer, so `showIf` conditionals hide/show live without
 * any duplicated logic on this side. Optional questions may be skipped
 * (stored as `null`). When the flow completes it saves the session
 * (which regenerates `agent_data/USER.md`) and calls `onFinish`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownBody } from "@/components/MarkdownBody";
import {
  fetchOnboardingStep,
  saveOnboardingAnswers,
  type AnswerMap,
  type AnswerValue,
  type OnboardingStep,
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

export function OnboardingFlow({ onFinish }: Props) {
  const [step, setStep] = useState<OnboardingStep | null>(null);
  const [session, setSession] = useState<AnswerMap>({});
  /** Ids answered this session, in order — powers Back. */
  const [history, setHistory] = useState<string[]>([]);
  const [draft, setDraft] = useState<AnswerValue | undefined>(undefined);
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
      const q = next.question;
      setDraft(q ? answers[q.id] : undefined);
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
    setSession(next);
    setHistory((h) => [...h.filter((id) => id !== q.id), q.id]);
    setBusy(true);
    setError(null);
    try {
      const nextStep = await fetchOnboardingStep(next);
      setStep(nextStep);
      setDraft(nextStep.question ? next[nextStep.question.id] : undefined);
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
