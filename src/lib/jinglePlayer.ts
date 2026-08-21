/**
 * Background jingle player for `script` actions.
 *
 * When the engine executes a `script` action it queues the script (Today's
 * "Queued for you" list) and emits `v2-autoplay { src, id }`. If the user
 * is in the app at that moment, this module plays the script immediately,
 * headless — a short confirmation sting accompanying the notice overlay,
 * giving the event immediate audio feedback (see FORMAT.md §5).
 *
 * Guardrails:
 *   - only plays while the app is foregrounded (the queued row + OS
 *     notification cover the user-away case);
 *   - never plays over the full-screen player (audio bus busy → the
 *     script stays queued for manual listening);
 *   - skips interactive scripts (`<until>`/`<choice>`/`<rating>`/`<react>`
 *     anywhere in the tree, includes included) — those need the real
 *     player UI, so they stay queued;
 *   - skips scripts longer than `MAX_JINGLE_SECS` for the same reason.
 *
 * Playbacks are serialized (a queue of jingles plays back-to-back) and
 * logged to the activity log under feature `script`, action `play`, just
 * like manual plays. On completion the pending row is dismissed; skipped
 * or failed jingles remain queued.
 */

import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { ManifestPlayer, type Segment } from "@/lib/manifestPlayer";
import { isAudioBusy } from "@/lib/audioBus";
import { logActivity } from "@/lib/activity";

/** Hard cap for auto-play — longer scripts stay queued for manual play. */
const MAX_JINGLE_SECS = 60;

interface RenderedManifest {
  manifest_path: string;
  duration: number;
}

interface AutoplayEvent {
  src: string;
  id: number;
}

interface QueueItem {
  src: string;
  id: number;
}

const queue: QueueItem[] = [];
let running = false;

/**
 * Resolve (rendering if needed — `render_manifest` reuses a fresh,
 * hash-matched render) and play one script headless. Resolves when
 * playback finishes or is skipped; never rejects (failures keep the
 * script queued and are only logged).
 */
async function playJingle(item: QueueItem): Promise<void> {
  try {
    // The full-screen player owns the audio output — leave this queued.
    if (isAudioBusy()) return;

    const rendered = await invoke<RenderedManifest>("render_manifest", {
      scriptPath: item.src,
    });
    const read = await invoke<{ root: Segment }>("read_manifest", {
      manifestPath: rendered.manifest_path,
    });
    if (rendered.duration > MAX_JINGLE_SECS) return;
    if (await isInteractive(read.root, new Set())) return;

    await new Promise<void>((resolve) => {
      const player = new ManifestPlayer({
        onPrompt: () => {
          // Interactive scripts are filtered above; a prompt here would
          // have no UI — stop and leave the script queued.
          player.destroy();
          resolve();
        },
        onPlayingChange: () => {},
        onEnded: () => resolve(),
        onError: (e) => {
          console.warn(`[jingle] playback failed for ${item.src}:`, e.message);
          resolve();
        },
        readImport: (manifestPath) =>
          invoke<{ root: Segment }>("read_manifest", { manifestPath }).then(
            (r) => r.root,
          ),
      });
      void player.start(read.root).catch(() => resolve());
    });

    void logActivity("script", "play", item.src);
    await invoke("economy_dismiss_pending", { id: item.id }).catch(() => {});
  } catch (e) {
    console.warn(`[jingle] ${item.src} not auto-played:`, e);
  }
}

/** Drain the queue one jingle at a time. */
async function drain(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.length > 0) {
      const next = queue.shift()!;
      // Re-check between jingles: a late user-initiated play wins.
      if (isAudioBusy()) continue;
      await playJingle(next);
    }
  } finally {
    running = false;
  }
}

/**
 * Wire the autoplay pipeline. Mount once from App (after onboarding);
 * `isForeground` should be the stable getter from `useAppForeground`.
 */
export function useJinglePlayer(isForeground: () => boolean): void {
  useEffect(() => {
    const un = listen<AutoplayEvent>("v2-autoplay", (e) => {
      if (!isForeground()) return; // queued row + OS notification cover it
      queue.push({ src: e.payload.src, id: e.payload.id });
      void drain();
    });
    return () => {
      void un.then((f) => f());
    };
  }, [isForeground]);
}

/**
 * True when the segment tree contains an interactive node (a prompt the
 * listener must answer). Sub-manifests (`import`) are read and recursed
 * into; `seen` breaks include cycles.
 */
async function isInteractive(seg: Segment, seen: Set<string>): Promise<boolean> {
  switch (seg.type) {
    case "until":
    case "choice":
    case "rating":
    case "react":
      return true;
    case "static":
      return false;
    case "sequence": {
      for (const child of seg.children) {
        if (await isInteractive(child, seen)) return true;
      }
      return false;
    }
    case "random":
    case "scramble": {
      for (const child of seg.options) {
        if (await isInteractive(child, seen)) return true;
      }
      return false;
    }
    case "loop":
      return isInteractive(seg.child, seen);
    case "background":
      return isInteractive(seg.layer, seen);
    case "overlay": {
      for (const part of seg.parts) {
        if (await isInteractive(part.segment, seen)) return true;
      }
      return false;
    }
    case "section":
      return isInteractive(seg.child, seen);
    case "import": {
      if (seen.has(seg.manifest)) return false;
      seen.add(seg.manifest);
      try {
        const sub = await invoke<{ root: Segment }>("read_manifest", {
          manifestPath: seg.manifest,
        });
        return await isInteractive(sub.root, seen);
      } catch {
        // Unreadable import — assume interactive so we never auto-block.
        return true;
      }
    }
  }
}
