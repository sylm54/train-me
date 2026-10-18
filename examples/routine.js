/*---
title: Morning voice & posture drill
schedule: 0 8 * * *
timeframe: 45m
success: { "type": "points", "delta": 15 }
failure: [{ "type": "task", "template": "punishment-light" }, { "type": "agent", "message": "Morning drill failed or lapsed — check the streak in activity.db, then reschedule or check in with the user." }]
---*/
// The body is plain orchestration JS, run in a sandboxed runtime with the
// tm API (wait / show / hide / audio / log / notify / fail — see
// docs/internal/runtime-api.md). Engine state (streak, done, points, ...)
// arrives as the read-only `vars` snapshot.
//
// To use: copy this file to routines/ and the two hypnos/*.xml scripts to
// hypnos/. Quoted .xml paths in bodies are not validated — audio.play
// fails at run time with a clear message if a script is missing.
await show("intro", {
  type: "text",
  title: "Good morning.",
  text:
    "Stand tall, relax your jaw, and let's wake the voice up. " +
    `You're on a ${vars.streak}-day streak with ${vars.done} completed runs.`,
});
await wait(10);

// Prerendered TTS script. The <mark>/<zone> seams in its markup become
// sync points: here we pause the drill at the script's halfway line.
const warmUp = await audio.play("hypnos/warm-up.xml");
await warmUp.mark("halfway");
await show("mid", {
  type: "text",
  text: "Halfway there. Stay tall — breath low, jaw loose.",
});
await warmUp.end;

// A choice: `buttons` resolves with the picked label.
const mood = await show("mood", {
  type: "buttons",
  prompt: "How did that feel?",
  items: ["Loose and easy", "Getting there", "Tight — again tomorrow"],
});
const picked = await mood.done;
if (picked === "Tight — again tomorrow") {
  await show("again", {
    type: "text",
    text: "Noted. Same drill tomorrow — consistency beats intensity.",
  });
  await wait(20);
}

await log("routine", "morning drill complete", { picked });
