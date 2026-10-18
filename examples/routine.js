/*---
title: Morning voice & posture drill
schedule: 0 8 * * *
timeframe: 45m
success: { "type": "points", "delta": 15 }
failure: { "type": "task", "template": "punishment-light" }
---*/
// The body is plain orchestration JS, run in a sandboxed runtime with
// the tm API (wait / show / audio / log / ...). Engine state (streak,
// done, points, ...) arrives as the read-only `vars` snapshot.
await show("intro", {
  type: "text",
  text:
    "Good morning. Stand tall, relax your jaw, and let's wake the voice up. " +
    `You're on a ${vars.streak}-day streak with ${vars.done} completed runs.`,
});
const warmUp = await audio.play("hypnos/warm-up.xml");
await warmUp.end;
await wait(15 * 60); // 15-minute hold
if (vars.weekday === "sunday") {
  await wait(10 * 60);
}
const feelingWidget = await show("feeling", {
  type: "slider",
  label: "Feminine feeling",
  min: 1,
  max: 10,
});
const feeling = await feelingWidget.done;
if (feeling >= 7) {
  await show("bonus", {
    type: "text",
    text: "That number says it's clicking. Bank the momentum.",
  });
}
await log("routine", "drill complete", { feeling });
