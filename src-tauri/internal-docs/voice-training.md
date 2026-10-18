---
description: The `voice` widget — live mic analysis with analyzers, pitch/centroid/loudness targets, scoring, hold requirements, and saving the recorded take.
---

# Voice Training Widgets

A `voice` widget (`show("id", { type: "voice", … })`) runs live
microphone analysis on the session stage: the trackers render while the
user records, and at the end of the exercise `await w.done` resolves
with a graded result the script reads — a failing score never fails the
run by itself; the script decides what to do with `passed`.

## Props

- `analyzers` — which aspects of the voice to score. Any of: `pitch`,
  `resonance`, `intonation`, `weight`, `loudness`, `genderspace`
  (array or comma string; absent = all six). Each added analyzer makes
  the gate harder to satisfy. An unknown id is a `show` error.
- `minHz` / `maxHz` — bounds on the pitch analysis range (tracker
  default 165–220 Hz).
- `targetHz` — the pitch the user should hold (default: band midpoint).
- `targetCentroid` — spectral centroid target for resonance/timbre
  (default 1500).
- `targetDb` — HNR target for vocal weight (default 18).
- `requiredScore` — 0–1 (default 0.75); the pass threshold over the
  whole take.
- `holdRatio` — 0–1 (default 0): when set, passing additionally requires
  the live score to stay at/above `requiredScore` for at least that
  fraction of the take.
- `duration` — seconds (number) or `"90s"`/`"5m"` (default 60s);
  recording auto-stops there.

## Result and events

`await w.done` resolves to
`{ score, passed, metrics, lines }` — `score` is 0..1 (mean of each
analyzer's tracker score), `passed` is the threshold + hold gate,
`metrics` is keyed per analyzer, `lines` is human-readable summary text.
Per-second `tick` events carry `{ elapsed, remaining, score, held }`;
`w.state.recording` mirrors the runner's forced REC dot.

## Saving the take

While the mic has recorded, `await w.save("take1")` writes
`recordings/take1.wav` into the sandbox and resolves with that
sandbox-relative path — feed it straight back into TTS as
`<clip src="recordings/take1.wav">`. It rejects when nothing was
recorded. Nothing is stored unless the script saves a take.

## Authoring notes

- Set `requiredScore` and `holdRatio` below 1.0 — perfect, unwavering
  compliance is frustrating; the gate should reward sustained effort,
  not perfection.
- Pair long voice holds with an `audio.play` script so the user has
  material to speak along with.
- Mic analysis is local; the widgets log only what the script logs.
