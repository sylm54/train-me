/**
 * Pocket-tts checkpoint catalog + engine commands.
 *
 * The speech engine (Kyutai pocket-tts) loads one "checkpoint" — a language
 * config with its own weights, tokenizer, and voice exports on the Hugging
 * Face Hub. The catalog is embedded in the binary; the active checkpoint id
 * lives in settings (`audio.ttsCheckpoint`) and the engine reloads when it
 * changes. Downloaded files cache under the app's model directory.
 */

import { invoke } from "@tauri-apps/api/core";

/** One selectable checkpoint, as `list_tts_checkpoints` returns it. */
export interface CheckpointInfo {
  id: string;
  label: string;
  description: string;
  /** Rough download size of weights + tokenizer + voices, in bytes. */
  approxBytes: number;
  /** Needs a build with SentencePiece support (the tiny distilled models). */
  requiresSentencepiece: boolean;
  /** Whether everything this checkpoint needs is already on disk. */
  downloaded: boolean;
}

/** `get_model_status` — checkpoint-aware engine state. */
export interface ModelStatus {
  downloaded: boolean;
  loaded: boolean;
  checkpoint: string;
  missing_files: string[];
  speakers: string[];
}

/** `render_test_track` — the onboarding/settings test render result. */
export interface TestRenderResult {
  name: string;
  filename: string;
  path: string;
  duration: number;
  created: string;
  size_bytes: number;
  /** Pure synthesis wall time in ms (engine load excluded). */
  render_ms: number;
  /** Seconds of audio produced. */
  audio_seconds: number;
}

export function listTtsCheckpoints(): Promise<CheckpointInfo[]> {
  return invoke<CheckpointInfo[]>("list_tts_checkpoints");
}

export function getModelStatus(): Promise<ModelStatus> {
  return invoke<ModelStatus>("get_model_status");
}

/** Download a checkpoint (default: the active one). Resolves when done. */
export function downloadCheckpoint(checkpoint?: string): Promise<string> {
  return invoke<string>("download_model", { checkpoint: checkpoint ?? null });
}

/** Load (or reload) the engine for the active checkpoint. */
export function loadModel(): Promise<string> {
  return invoke<string>("load_model");
}

/** Select the checkpoint future engine loads use. Unloads the engine. */
export function setTtsCheckpoint(checkpoint: string): Promise<void> {
  return invoke<void>("set_tts_checkpoint", { checkpoint });
}

/** Render the static test script; returns the track plus render timing. */
export function renderTestTrack(): Promise<TestRenderResult> {
  return invoke<TestRenderResult>("render_test_track");
}
