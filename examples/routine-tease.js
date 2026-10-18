/*---
title: Tease & pace session
cooldown: 4h
limit: { "daily": 1 }
success: { "type": "points", "delta": 5 }
failure: { "type": "notification", "text": "Tease session failed — no points this time." }
---*/
// On-demand routine (no `schedule`): the user starts it from Today, the
// `cooldown` keeps re-runs apart, and `limit` caps rewarded completions
// (an on-demand routine without an explicit `limit` defaults to one
// successful completion per day). The body shows the media background
// slideshow, a beat meter synced to the audio script, and an elapsed
// timer — all stage widgets; see docs/internal/runtime-api.md.
//
// To use: copy this file to routines/ and the two hypnos/*.xml scripts
// to hypnos/ (audio paths in bodies are not validated — a missing script
// fails at run time with a clear message).
await media.prefetch({ niche: "just-boobs", tags: "joi", count: 12 });
show("bg", {
  type: "media",
  niche: "just-boobs",
  tags: "joi",
  count: 12,
  every: "4..8",
  effect: "zoom,vignette",
  z: -1,
});

// The beat meter follows the script's nominal position via `sync`, and
// `mark` waits for the <mark name="finale"/> seam in the markup.
const s = await audio.play("hypnos/deepening.xml");
show("pace", { type: "beatmeter", bpm: 100, pattern: "X.x.x.x.", sync: s });
show("clock", { type: "timer", mode: "up", label: "Elapsed" });
await show("intro", {
  type: "text",
  text: "Eyes on the screen. Match the beat — no rushing ahead.",
});

await s.mark("finale");
await wait(120);

const stop = await show("stop", {
  type: "buttons",
  prompt: "The audio is done. Ready to stop?",
  items: ["Stop here", "Two more minutes"],
});
if ((await stop.done) === "Two more minutes") {
  await wait(120);
}

await hide("pace");
await hide("clock");
await hide("bg");
await log("routine", "tease session complete", { position: s.position });
