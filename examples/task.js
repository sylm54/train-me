/*---
title: Extended chastity check
description: Verify lock status and perform a short voice sample.
timeframe: 2h
timeouts: [{ "after": "30m", "action": { "type": "points", "delta": -5 } }]
max_timeout: 2h
success: { "type": "points", "delta": 10 }
failure: { "type": "notification", "text": "Failure recorded" }
---*/
// Task templates are the same comment front-matter + JS body model as
// routines; an instance is assigned via the `task` action or directly by
// the agent, and instances carry their own deadline and `timeouts`
// escalation as time passes.
if (vars.locked) {
  await show("locked", {
    text: "Verify the device is secure and log the code.",
  });
} else {
  await show("unlocked", { text: "You've earned your release. Enjoy it." });
}
await audio("hypnos/voice-sample.xml");
await input("reflection", {
  prompt: "Write a short reflection on this check.",
  required: true,
});
