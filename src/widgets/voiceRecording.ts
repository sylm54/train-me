/**
 * Voice-widget recording plumbing: PCM capture helpers, WAV encoding, the
 * `recordings/<name>.wav` path rules, and the saver registry that bridges
 * the script's `w.save(name)` RPC to the live widget component.
 *
 * Why the registry: a widget component owns its captured PCM (the frame
 * loop fills it), but `w.save(name)` arrives at the parent as a bridge
 * op with only the widget id. The component registers a saver under its
 * id while mounted; `saveVoiceRecording` resolves it or throws the
 * author-facing error that crosses the bridge as the call's rejection.
 *
 * Why base64: `write_data_file` speaks the UTF-8-only JSON IPC channel,
 * so the encoded WAV crosses as `content_b64` and lands on disk as the
 * exact bytes — the same file a TTS `<clip src="recordings/…">` decodes.
 */

/** Convert one analysis frame's [-1, 1] float samples to 16-bit PCM. */
export function floatToPcm(timeData: Float32Array): Int16Array {
  const out = new Int16Array(timeData.length);
  for (let i = 0; i < timeData.length; i++) {
    const s = timeData[i] < -1 ? -1 : timeData[i] > 1 ? 1 : timeData[i];
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/** Base64 for arbitrary bytes (chunked — spread has an argument limit). */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/**
 * Encode captured 16-bit mono PCM as a base64 WAV (RIFF/PCM, 16-bit,
 * one channel, `sampleRate` Hz) — exactly what hound decodes for clips.
 */
export function encodeWavBase64(
  chunks: readonly Int16Array[],
  sampleRate: number,
): string {
  let samples = 0;
  for (const c of chunks) samples += c.length;
  const dataBytes = samples * 2;
  const out = new Uint8Array(44 + dataBytes);
  const dv = new DataView(out.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) dv.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  dv.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  dv.setUint32(16, 16, true); // fmt chunk size
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true); // byte rate
  dv.setUint16(32, 2, true); // block align
  dv.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  dv.setUint32(40, dataBytes, true);
  let off = 44;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++, off += 2) dv.setInt16(off, c[i], true);
  }
  return bytesToBase64(out);
}

/**
 * Sanitize a script-supplied recording name into the sandbox-relative
 * path `recordings/<name>.wav`. Anything outside `[A-Za-z0-9._-]`
 * collapses to `_` (so no separators, traversal, or control bytes
 * survive), the result is capped to 80 chars, and `.wav` is appended
 * unless already present. Overwriting an existing take is allowed.
 */
export function recordingPath(rawName: string): string {
  const cleaned = rawName
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/\.{2,}/g, ".")
    .replace(/^[._-]+/, "")
    .replace(/[._-]+$/, "")
    .slice(0, 80)
    .replace(/[._-]+$/, "");
  if (cleaned.length === 0) {
    throw new Error(
      `save: recording name ${JSON.stringify(rawName)} has no usable characters`,
    );
  }
  const file = cleaned.toLowerCase().endsWith(".wav") ? cleaned : `${cleaned}.wav`;
  return `recordings/${file}`;
}

/** A voice widget's save: encode what was captured and write it under
 * the agent sandbox, resolving with the sandbox-relative path. */
export type VoiceSaver = (name: string) => Promise<string>;

const savers = new Map<string, VoiceSaver>();

/** Register the live saver under the widget id; returns unregister. */
export function registerVoiceSaver(id: string, saver: VoiceSaver): () => void {
  savers.set(id, saver);
  return () => {
    if (savers.get(id) === saver) savers.delete(id);
  };
}

/** Parent side of `w.save(name)` — resolve the widget's live saver.
 * Throws author-facing errors (they become the RPC's rejection). */
export function saveVoiceRecording(id: string, name: unknown): Promise<string> {
  const saver = savers.get(id);
  if (!saver) {
    throw new Error(`save on widget "${id}": no voice widget is on the stage`);
  }
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new Error(`save on widget "${id}": save(name) expects a non-empty name string`);
  }
  return saver(name);
}
