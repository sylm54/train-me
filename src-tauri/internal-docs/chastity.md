---
description: Chastity — the `lock` widget (`state: locked|unlocked`) inside sessions, the hidden code lifecycle, and the `chastity` bash builtin.
---

# Chastity

## The `lock` widget

`show("id", { type: "lock", state: "locked" | "unlocked" })` — a
lock/unlock GATE on the session stage:

- If the device is already in the required state, the widget is instantly
  fulfilled (`await w.done` resolves with the reached state string).
- `locked`: the user locks themselves right on the stage; a hidden code
  is generated and kept from them.
- `unlocked`: releases the lock and reveals the code on screen.

Show these gates inside a routine/task body to make locking/release part
of a session flow — e.g. a `locked` gate before a long audio stretch, an
`unlocked` gate as an earned reward.

## Lifecycle rules

- The user locks themselves (via onboarding or a `state: locked` gate);
  once locked, only you can unlock. Locking is user-only by design — you
  can read the state and unlock headlessly, never lock.
- `chastity unlock` (bash) unlocks headless — the hidden code stays
  hidden.
- To hand the code back, reach a `state: unlocked` gate in a routine or
  task: reaching it releases the lock and reveals the code on screen.
- Lock/unlock events log under `chastity`. An unlock gate's log entry
  includes the revealed code, so the user can always recover it from the
  activity log. The code never crosses back into the script.
- The lock state itself lives outside the sandbox — in a script body,
  read the boolean snapshot as `vars.locked`.
