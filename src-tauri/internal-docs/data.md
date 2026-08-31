---
description: Agent data access — the `points` and `inventory` bash builtins, chastity commands, and the activity.db SQLite schema.
---

# Data & Builtins

## Points (`points` bash builtin)

- Append-only ledger; the balance is never rewritten.
- `points info` shows balance + recent entries.
- `points grant <n> "reason"` / `points deduct <n> "reason"` append visible, reasoned deltas. Negative balances are just a number.

## Inventory (`inventory` bash builtin)

- `inventory items` / `inventory items <id>` — read-only list of owned items.
- `inventory wishlist` — list; `inventory wishlist add <name> [category] [priority] [notes...]` / `inventory wishlist remove <id>` — full read/write.
- The user manages items via the UI.

## Chastity (`chastity` bash builtin)

- `chastity info` — current lock status. `chastity unlock` — unlocks headless (the hidden code stays hidden). See `docs/internal/chastity.md` for the gate lifecycle.

## Activity log (`activity.db` SQLite)

- Query it read-only via the `sqlite` builtin. Schema:

```sql
CREATE TABLE IF NOT EXISTS activity (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       TEXT    NOT NULL,
    feature  TEXT    NOT NULL,
    action   TEXT    NOT NULL,
    details  TEXT    NOT NULL DEFAULT ''
);
```

- `ts` is RFC 3339. The engine logs routine/habit/task/store events; voice sessions log under `voice`, script playbacks and in-audio decisions under `script`.
