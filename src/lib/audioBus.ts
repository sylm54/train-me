/**
 * Global "exclusive audio" flag for the standalone player ↔ jingle pair.
 *
 * The full-screen player marks itself busy for its lifetime so background
 * jingles (auto-played `script` actions) don't talk over audio the user
 * deliberately opened. The jingle player consults this before starting;
 * when busy, the script simply stays in Today's "Queued for you" list.
 *
 * Scripted sessions (lib/runtime) do NOT participate: a session owns its
 * audio — every `audio.play` gets an independent ManifestPlayer
 * (lib/runtime/scriptHandle.ts), so multiple handles may sound
 * concurrently (and the mic widget phase is expected to coexist with
 * playback). Nothing in the session path claims or consults this flag.
 */

let busy = false;

/** Claim/release the audio output (call from the foreground player). */
export function setAudioBusy(next: boolean): void {
  busy = next;
}

/** True while a user-initiated player owns the audio output. */
export function isAudioBusy(): boolean {
  return busy;
}
