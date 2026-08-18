---
title: No masculine clothing
type: max
count: 0
success: { "type": "points", "delta": 5 }
failure: { "type": "points", "delta": -10 }
---
Describe the habit's positive case here.

`type: max` — the daily logged count must stay at or under `count`; any
action over the limit fires the failure actions immediately (and breaks
the streak). Staying under until day-end fires the success actions.
A v1 rule is `type: max, count: 0`.

`type: min` — the inverse: success fires the moment `count` is reached,
failure at day-end if it wasn't.
