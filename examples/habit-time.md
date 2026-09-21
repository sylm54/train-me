---
title: Voice practice
type: min
minutes: 40
success: { "type": "points", "delta": 10 }
failure: { "type": "points", "delta": -5 }
---
Describe the habit's positive case here.

A time habit logs minutes instead of occurrences: `minutes:` replaces
`count` as the daily goal/limit (the two are mutually exclusive), and
every log carries an amount in minutes. `type: min` succeeds the moment
the day's logged minutes reach the goal; `type: max` fails immediately
once a log pushes the day past the limit (e.g. `type: max, minutes: 120`
= "stay under two hours").
