/**
 * Framework onboarding flow bindings (see src-tauri/src/onboarding.rs).
 *
 * The flow engine — conditional visibility (`showIf`), step screens,
 * save-time pruning — lives entirely in Rust; the frontend only steps
 * through `onboarding_step` screens: the text blocks leading up to the
 * next visible unanswered question, plus that question. Answers are sent
 * back each step so conditional hiding reacts live. Saving writes
 * `agent_data/USER.md` on the agent filesystem and emits
 * `prompt-inputs-changed`, which rebuilds the system prompt — so prompts
 * that `{{include './USER.md'}}` pick up the new answers without a
 * restart. Nothing is auto-added to any prompt.
 */

import { invoke } from "@tauri-apps/api/core";

export type AnswerKind = "open" | "choice" | "rating";

export interface QuestionItem {
  id: string;
  answer: AnswerKind;
  prompt: string;
  /** `choice` answers only. */
  choices?: string[];
  /** `choice` answers only — collect several. */
  multiple?: boolean;
  /** `rating` answers only (default 1..=10). */
  min?: number;
  max?: number;
  hint?: string | null;
}

/** One screen of the flow. `question: null` means the flow is complete. */
export interface OnboardingStep {
  /** Visible text blocks preceding the question (markdown). */
  texts: string[];
  question: QuestionItem | null;
  /** Unanswered visible questions, including the current one. */
  remaining: number;
  /** Total visible questions. */
  total: number;
}

export type AnswerValue = string | number | string[];
export type AnswerMap = Record<string, AnswerValue>;

export interface OnboardingState {
  pending_count: number;
}

export function fetchOnboardingState(): Promise<OnboardingState> {
  return invoke("onboarding_questions");
}

/** Next screen given this session's answers so far (merged over stored). */
export function fetchOnboardingStep(session: AnswerMap): Promise<OnboardingStep> {
  return invoke("onboarding_step", { session });
}

export function saveOnboardingAnswers(session: AnswerMap): Promise<OnboardingState> {
  return invoke("save_onboarding_answers", { session });
}
