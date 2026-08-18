---
format: 2
title: Morning voice & posture drill
schedule: 0 8 * * *
timeframe: 45m
success: { "type": "points", "delta": 15 }
failure: { "type": "task", "template": "punishment-light" }
---
Good morning. Stand tall, relax your jaw, and let's wake the voice up.

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
---
Remain in the prescribed position and wait the full duration.
```

```feature
type: slider
min: 1
max: 10
label: Feminine feeling
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
