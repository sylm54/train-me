/*---
title: Morning demo session
schedule: 0 8 * * *
timeframe: 30m
success: { "type": "points", "delta": 5 }
---*/
// A short gated session: widgets on the stage, zone-synced audio.
await show("intro", { type: "text", text: "Deep breath. Begin." });
const s = await audio.play("hypnos/demo.xml");
await s.zone("warmup");
const list = await show("tasks", {
  type: "checklist",
  items: ["Stretch", "Breathe slowly"],
});
await list.done;
await s.end;
await log("routine", "demo complete", { felt: "good" });
await wait(5);
