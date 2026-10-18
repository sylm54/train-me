/*---
title: Extended chastity check
description: Verify lock status and perform a short guided reflection.
timeframe: 2h
timeouts: [{ "after": "30m", "action": { "type": "points", "delta": -5 } }]
max_timeout: 2h
success: { "type": "points", "delta": 10 }
failure: { "type": "notification", "text": "Failure recorded" }
---*/
// Task templates use the same comment front-matter + JS body model as
// routines; an instance is assigned via the `task` action or directly by
// you, and instances carry their own deadline and `timeouts` escalation
// as time passes. To use: copy to tasks/ and the hypnos/*.xml scripts to
// hypnos/.
if (vars.locked) {
  await show("status", {
    type: "text",
    text: "Verify the device is secure before you continue.",
  });
} else {
  await show("status", {
    type: "text",
    text: "You've earned your release. Enjoy it — it's logged.",
  });
}
const sample = await audio.play("hypnos/deepening.xml");
await sample.end;

// `input` resolves with the submitted text: `submit` is the button label,
// `multiline` widens the field. (`label`/`placeholder` are optional.)
const reflection = await show("reflection", {
  type: "input",
  label: "Write a short reflection on this check.",
  submit: "Hand in",
  multiline: true,
});
await log("task", "reflection", await reflection.done);
