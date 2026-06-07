This document provides a structured summary of the built-in features available. Each feature supports specific workflows designed to enhance structure, training. Unless otherwise noted, all features are for the main agent and are read-only for the user. The user may only modify data where explicitly allowed. This file is written from the perspective of the main agent, outlining the capabilities and limitations of each feature.

### 1. Conditioning (`conditioning/*.md`)
- Each .json file corresponds to one audio file.
- File contents describe the associated audio.
- Creation of new/Managing conditioning files is restricted to the dedicated hypno planner agent.

### 2. Rules (`rule/*.md`)
- Each file represents one rule that the user is expected to follow.
- Refer to `examples/rule.md` for the correct formatting standard.

### 3. Routines (`routines/*.md`)
- Each file defines one routine for the user.
- Refer to `examples/routine.md` for the proper formatting standard.

### 4. Inventory
- Stored in `<app_data>/state/inventory.db` (SQLite; auto-created on first run).
- **Items**: records items owned by the user. Only the user may add or update entries (via the Inventory UI). You may read entries using the `inventory` builtin.
- **Wishlist**: follows the same schema as items (with `priority` instead of `quantity`). You may read AND write wishlist entries.
- Use the `inventory` builtin for all access:
  - `inventory items` — list items.
  - `inventory items <id>` — show one item.
  - `inventory wishlist` — list wishlist.
  - `inventory wishlist <id>` — show one wishlist item.
  - `inventory wishlist add <name> [category] [priority] [notes...]` — add a wishlist entry.
  - `inventory wishlist remove <id>` — remove a wishlist entry.
- Never attempt to add, update, or remove owned items yourself — instruct the user to do it via the Inventory view.

### 5. Chastity
- Command: `chastity`
- State lives at `<app_data>/state/chastity.json` (outside your writable area; you cannot read or write the file directly).
- Capabilities:
  - `chastity info` — Displays current lock status.
  - `chastity lock <secret>` — Locks the user with the given secret.
  - `chastity unlock <secret>` — Unlocks if the secret matches.
  - `chastity countdown <duration>` — Sets a countdown timer (e.g., `2h`, `3d`, `1w`).
  - `chastity countdown stop` — Cancels the active countdown.
- The user is responsible for locking themselves. Once locked, you can only unlock them by providing the correct secret string.

### 6. Journal (`journal/*.md`, `journal/format.json`)
- The user may maintain personal journal entries in the `.md` files (read-only for you).
- You may customize prompts and related settings by editing `format.json`.
- Refer to `example/format.json` for the expected structure.

### 7. Voice Training (`voice/config.json`, `voice/*.md`)
- Supports voice feminization training.
- Detailed guidance is available in `VoiceTraining.md`.

### 8. Activity Tracking
- Stored in `<app_data>/state/activity.db` (SQLite; auto-created on first run). Same store used by the React Activity view.
- Command: `activity`
- Subcommands:
  - `activity log <feature> <action> [details...]` — append an entry.
  - `activity list` — list all entries (oldest first).
  - `activity inspect <id>` — show one entry as JSON.
- Each entry has a unique numeric `id`, an RFC3339 `ts`, a `feature`, an `action`, and free-form `details`.
