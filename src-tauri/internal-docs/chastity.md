---
description: Chastity — the `state: locked|unlocked` feature gate inside sessions, the hidden code lifecycle, and the `chastity` bash builtin.
---

# Chastity

## The `chastity` feature block

`state: locked|unlocked` — a lock/unlock GATE inside a routine or task page:

- If the device is already in the required state, the step is instantly fulfilled.
- `locked`: the user locks themselves right on the page; a hidden code is generated and kept from them.
- `unlocked`: releases the lock and reveals the code on screen.

Embed these gates to make locking/release part of a session flow — e.g. a lock gate before a long audio page, an unlock gate as an earned reward.

## Lifecycle rules

- The user locks themselves (via onboarding or a `state: locked` gate); once locked, only you can unlock.
- `chastity unlock` (bash) unlocks headless — the hidden code stays hidden.
- To hand the code back, reach a `state: unlocked` gate in a routine/task: reaching it releases the lock and reveals the code on screen.
- Lock/unlock events log under `chastity`. An unlock gate's log entry includes the revealed code, so the user can always recover it from the activity log.
