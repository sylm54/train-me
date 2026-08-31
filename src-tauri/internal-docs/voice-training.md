---
description: The `voice` feature block — live mic analysis with analyzers, pitch/centroid/loudness targets, scoring, and hold requirements.
---

# Voice Training Blocks

A ``` `voice` ``` feature block inside a routine/task page runs live microphone analysis and gates the page on the user's voice matching your targets until the block's duration is satisfied.

## Configuration

All keys are set inside the feature block body as `key: value` lines:

- `analyzers` — which aspects of the voice to score. Any of: `pitch`, `resonance`, `intonation`, `weight`, `loudness`, `genderspace`.
- `minHz` / `maxHz` — bounds on the analysis range.
- `targetHz` — the pitch the user should hold.
- `targetCentroid` — spectral centroid target (resonance/timbre).
- `targetDb` — loudness target.
- `requiredScore` — 0–1; the combined score the user must maintain.
- `holdRatio` — fraction of the block's duration the score must be met (e.g. `0.8` = 80% of the time).
- `duration` — total length of the exercise in seconds.

## Authoring notes

- Combine analyzers deliberately: each added analyzer makes the gate harder to satisfy.
- Set `requiredScore` and `holdRatio` below 1.0 — perfect, unwavering compliance is frustrating; the gate should reward sustained effort, not perfection.
- Pair long voice holds with an `audio` block or a script link so the user has material to speak along with.
