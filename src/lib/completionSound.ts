/**
 * Completion chime for the agent panel.
 *
 * A short two-note chime synthesized with the Web Audio API — no audio
 * asset to ship or load. Played when the agent's generation run finishes
 * (see ChatView), gated by the Settings → Chat "completion sound" toggle.
 *
 * The AudioContext is created lazily and reused; browsers only allow audio
 * after a user gesture, which always precedes a run (the user sent the
 * message), so resume() unblocks it on the first play.
 */

let ctx: AudioContext | null = null;

function audioContext(): AudioContext | null {
  try {
    if (!ctx) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
    }
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** One synthesized note: a sine with a quick attack and exponential decay. */
function note(
  ac: AudioContext,
  freq: number,
  startAt: number,
  duration: number,
  gain: number,
) {
  const osc = ac.createOscillator();
  const amp = ac.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  amp.gain.setValueAtTime(0, startAt);
  amp.gain.linearRampToValueAtTime(gain, startAt + 0.015);
  amp.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  osc.connect(amp).connect(ac.destination);
  osc.start(startAt);
  osc.stop(startAt + duration + 0.05);
}

/**
 * Play the completion chime: a rising two-note "de-ding" (E5 → A5).
 * Fire-and-forget; failures (missing Web Audio, autoplay policy) are
 * swallowed — a chime must never break the chat.
 */
export function playCompletionSound(): void {
  try {
    const ac = audioContext();
    if (!ac) return;
    const t = ac.currentTime + 0.01;
    note(ac, 659.25, t, 0.18, 0.12); // E5
    note(ac, 880.0, t + 0.12, 0.32, 0.12); // A5
  } catch {
    // best-effort only
  }
}
