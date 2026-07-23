/**
 * Public surface for the voice-training metrics system.
 */

export type {
  AudioFrame,
  FrameCallback,
  TrackerConfig,
  TrackerSummary,
  TrackerComponentProps,
  VoiceTracker,
} from "./types";
export { parseVoiceConfig, resolveTrackers, specToConfig } from "./config";
export type {
  TrackerSpec,
  LessonConfig,
  VoiceConfig,
} from "./config";
export { FrameBus, useVoiceSession } from "./audio";
export type { VoiceSession, VoiceSessionState } from "./audio";
export { TRACKERS, TRACKER_LIST, getTracker } from "./registry";
