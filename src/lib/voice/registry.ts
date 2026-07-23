/**
 * Tracker registry.
 *
 * Every built-in tracker is registered here by id. New metrics are added by
 * implementing {@link ../types.VoiceTracker} and adding an entry below — no
 * other wiring is required for them to become selectable by the agent in
 * `voice/config.json` and rendered in the training screen.
 */

import type { VoiceTracker } from "./types";
import { pitchTracker } from "./trackers/pitch";
import { resonanceTracker } from "./trackers/resonance";
import { intonationTracker } from "./trackers/intonation";
import { weightTracker } from "./trackers/weight";
import { loudnessTracker } from "./trackers/loudness";
import { genderspaceTracker } from "./trackers/genderspace";

/** All built-in trackers, keyed by id. */
export const TRACKERS: Record<string, VoiceTracker> = {
  pitch: pitchTracker,
  resonance: resonanceTracker,
  intonation: intonationTracker,
  weight: weightTracker,
  loudness: loudnessTracker,
  genderspace: genderspaceTracker,
};

/** Ordered list for display (e.g. picker menus). */
export const TRACKER_LIST: VoiceTracker[] = [
  pitchTracker,
  resonanceTracker,
  intonationTracker,
  weightTracker,
  loudnessTracker,
  genderspaceTracker,
];

/** Look up a tracker by id. */
export function getTracker(id: string): VoiceTracker | undefined {
  return TRACKERS[id];
}
