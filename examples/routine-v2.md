---
format: 2
title: Morning voice & posture drill
schedule: 0 8 * * *
timeframe: 45m
success: { "type": "points", "delta": 15 }
failure: { "type": "task", "template": "punishment-light" }
---
Good morning. Stand tall, relax your jaw, and let's wake the voice up.
You're on a **{{streak}}**-day streak, with {{done}} completed runs behind you.

{{#if weekday == "sunday"}}
Sunday session: the weekly review is part of today's drill.
- [ ] Review last week's misses
{{/if}}

- [ ] Water glass filled
- [ ] Posture check done

```feature
type: voice
analyzers: pitch,resonance,intonation
minHz: 180
maxHz: 280
targetHz: 220
targetCentroid: 2500
requiredScore: 0.75
duration: 30s
---
Produce a soft, bright, feminine sample. Maintain pitch and resonance
inside the target band.
```

---

Settle into position and hold it.

```feature
type: wait
duration: 15m
when: weekday != "sunday"
---
Remain in the prescribed position and wait the full duration.
```

```feature
type: wait
duration: 10m
when: weekday == "sunday"
---
Sundays run lighter — a shorter hold.
```

```feature
type: slider
min: 1
max: 10
label: Feminine feeling
field: feeling
---
Rate how feminine you currently feel.
```

```feature
type: input
field: reflection
required: true
---
Write a short reflection on the drill.
```

---

@when feeling >= 7

That number says it's clicking. Bank the momentum:

```feature
type: choice
field: momentum
options: Reward tonight|Bank the points
---
How do you want to use today's win?
```
