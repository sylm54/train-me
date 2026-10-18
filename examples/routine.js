/*---
title: Morning voice & posture drill
schedule: 0 8 * * *
timeframe: 45m
success: { "type": "points", "delta": 15 }
failure: { "type": "task", "template": "punishment-light" }
---*/
// The body is plain orchestration JS, run in a sandboxed runtime with the
// interaction API (wait / show / audio / vars / log / ...). Engine state
// (streak, done, points, ...) arrives as the `vars` object.
await show("intro", {
  text:
    "Good morning. Stand tall, relax your jaw, and let's wake the voice up. " +
    `You're on a ${vars.streak}-day streak with ${vars.done} completed runs.`,
});
await audio("hypnos/warm-up.xml");
await wait("15m");
if (vars.weekday === "sunday") {
  await wait("10m");
}
const feeling = await slider("feeling", {
  min: 1,
  max: 10,
  label: "Feminine feeling",
});
if (feeling >= 7) {
  await show("bonus", { text: "That number says it's clicking. Bank the momentum." });
}
await log("drill complete");
