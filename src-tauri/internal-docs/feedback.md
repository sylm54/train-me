---
description: Immediate feedback actions — `script` (auto-playing audio stings) and `notification` (in-app overlay / OS notification).
---

# Feedback Actions

`script` and `notification` fire immediately when their action runs. Use them together to give an event both a message and a jingle (e.g. a success sting + "+10, well done").

## `script` — immediate audio

- When the user is in the app it auto-plays right away as a background jingle — a clicker/confirmation sting scoring the event (think "cha-ching", not a session).
- Author script-action scripts SHORT — under ~10 seconds.
- Scripts longer than 60 s will not auto-play; they land in the "Queued for you" list on Today for manual listening.
- Long audio belongs inside routine/task bodies (`await audio.play("hypnos/….xml")` — see `docs/internal/runtime-api.md`), not in `script` actions.

## `notification` — immediate message

- While the app is open the text pops up as an in-app overlay; when it isn't, it becomes an OS notification.
