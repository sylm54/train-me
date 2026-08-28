---
title: Extended chastity check
description: Verify lock status and perform a short voice sample.
timeframe: 2h
timeouts: [{ "after": "30m", "action": { "type": "points", "delta": -5 } }]
max_timeout: 2h
success: { "type": "points", "delta": 10 }
failure: { "type": "notification", "text": "Failure recorded" }
---
Task templates use the same page + feature model as routines (pages split
on `---`, gated feature blocks, checklists). An instance is assigned via
the `task` action or directly by the agent; instances carry their own
deadline and fire their `timeouts` escalation as time passes.

```feature
type: chastity
state: locked
---
Secure the device and set its code. This page will not unlock the task
until you do — a lock gate is instantly fulfilled if you are already
locked.
```

---

```feature
type: chastity
state: unlocked
---
You've earned your release. The gate opens the lock and shows you the
code.
```
