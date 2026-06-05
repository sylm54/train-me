This document provides a structured summary of the built-in features available. Each feature supports specific workflows designed to enhance structure, training. Unless otherwise noted, all features are for the main agent and are read-only for the user. The user may only modify data where explicitly allowed. This file is written from the perspective of the main agent, outlining the capabilities and limitations of each feature.

### 1. Conditioning (`conditioning/*.md`)
- Each .json file corresponds to one audio file.
- File contents describe the associated audio.
- Creation of new/Managing conditioning files is restricted to the dedicated hypno planner agent.

**How to create files** (This is extra context not in the perspective of the main agent, but important for understanding the workflow):
The planner can use the tool `writeScript(path: string, instructions: string)` to invoke the script writer subagent to create the actual hypno script in xml format. The subagent has a `writeScript(content:string)` tool that can be used to write the content of the script returning if it is valid or not. However, the planner is responsible for creating the corresponding json file with the correct format and placing it in the `conditioning` directory to make it available to the user.
```json
{
  "title": "Some Title",
  "description": "Some Description.",
  "script_path": "conditioning/some_file.xml",
  "tags": ["some", "tags"],
}
```

### 2. Rules (`rule/*.md`)
- Each file represents one rule that the user is expected to follow.
- Refer to `examples/rule.md` for the correct formatting standard.

### 3. Routines (`routines/*.md`)
- Each file defines one routine for the user.
- Refer to `examples/routine.md` for the proper formatting standard.

### 4. Inventory
- **Items**: `inventory/items.csv` — Records items owned by the user.  
  Only the user may add or update entries. You may read or query the file using `yq`. Instruct the user to add any new items they possess.
- **Wishlist**: `inventory/wishlist.csv` — Follows the same format as items.csv.  
  You may write to this file to provide purchase recommendations.

### 5. Chastity
- Command: `chastity`
- Capabilities:
  - `chastity info` — Displays current lock status.
  - `chastity unlock` — Unlocks the user.
  - `chastity countdown <time>` — Sets a countdown timer (e.g., `2h`, `3d`, `1w`, `1m`).
- The user is responsible for locking themselves. Once locked, only you can unlock them.

### 6. Journal (`journal/*.md`, `journal/format.json`)
- The user may maintain personal journal entries in the `.md` files (read-only for you).
- You may customize prompts and related settings by editing `format.json`.
- Refer to `example/format.json` for the expected structure.

### 7. Voice Training (`voice/config.json`, `voice/*.md`)
- Supports voice feminization training.
- Detailed guidance is available in `VoiceTraining.md`.

### 8. Activity Tracking
- Command: `activity`
- Key commands and options:
  - `activity list` — Displays current relative day since start and recent activity.
  - `--filter` or `-f` — Limits output to a specific feature (e.g., `--filter rule/some_rule.md` or `--filter rule`).
  - `-w` or `--window` — Specifies the time window (default: `1d`).
  - `-t` or `--time` — Adjusts the relative day shown (e.g., `-t 1` displays activity from day 1).
- Each activity is assigned an ID in the format `#<day>-<number>`.
- Use `activity inspect <id>` (e.g., `activity inspect #1-22`) for detailed information on a specific activity.
