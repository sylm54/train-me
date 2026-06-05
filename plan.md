# Train-Me — Full Implementation Plan

A Tauri 2 desktop/mobile app combining an AI agent (with subagents), a virtual bash sandbox, and a TTS engine for hypnosis/conditioning script playback. The app manages structured workflows for feminization/hypno training: conditioning scripts, rules, routines, inventory, chastity, journal, voice training, and activity tracking.

---

## Current State

The project at `C:\Users\bldng\DEV\train-me` is a working Tauri 2 app with:

- **Frontend**: React 19 + Vite + TypeScript (`src/App.tsx`, `src/main.tsx`)
- **Backend**: Rust (`src-tauri/src/`)
  - `tag_parser.rs` — XML tag parser for TTS markup (supports `<voice>`, `<speed>`, `<volume>`, `<pause>`, `<sound>`, `<tone>`, `<effect>`, `<overlay>`, `<loop>`, `<background>`, `<until>`)
  - `audio_renderer.rs` — Renders parsed AST to WAV audio (TTS synthesis, sound effects, tones, mixing, dynamic expressions)
  - `expression.rs` — Dynamic expression parser (`@fadein`, `@beat`, `@sin`, etc.)
  - `helper.rs` — TTS model loading (Piper ONNX)
  - `model_downloader.rs` — Downloads TTS model from HuggingFace
  - `sounds.rs` — Built-in sound effects
  - `lib.rs` — Tauri commands: `get_model_status`, `download_model`, `load_model`, `synthesize`, `list_tracks`, `get_track_audio`, `delete_track`, `get_sound_names`
- **Current UI**: A single-page TTS demo with textarea input, synthesize button, and track list
- **Data dirs**: `app_data_dir/model/` (TTS model) and `app_data_dir/tracks/` (rendered WAVs)
- **Dependencies**: React 19, Tauri 2, Vite 7, TypeScript 5.8

### Key existing files to read before starting

- `todo.md` — The original task description
- `features.md` — Feature specifications (what the agent can do)
- `tts_tags.md` — Complete TTS tag reference and concepts
- `examples/format.json` — Journal format example
- `examples/routine.md` — Routine file format with cron frontmatter
- `examples/rule.md` — Rule file format
- `src/App.tsx` — Current UI (will be replaced)
- `src-tauri/src/tag_parser.rs` — Tag parser AST and implementation
- `src-tauri/src/audio_renderer.rs` — Audio rendering pipeline
- `src-tauri/src/lib.rs` — Tauri commands
- `src-tauri/Cargo.toml` — Rust dependencies
- `package.json` — dependencies
- `src-tauri/tauri.conf.json` — Tauri configuration

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    React Frontend                        │
│  (Vite, Tailwind CSS, AI Elements, Vercel AI SDK)       │
│                                                          │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │ Settings  │  │ Agent Chat   │  │ Feature Views     │  │
│  │ (API keys │  │ (AI Elements │  │ (Conditioning,    │  │
│  │  models)  │  │  components) │  │  Rules, Routines, │  │
│  │           │  │              │  │  Inventory, etc.) │  │
│  └──────────┘  └──────┬───────┘  └───────────────────┘  │
│                       │                                  │
│         ┌─────────────┼─────────────┐                   │
│         │             │             │                    │
│         ▼             ▼             ▼                    │
│  OpenRouter API   Tauri Commands   (state mgmt)         │
│  (streamText      (invoke<T>())                          │
│   client-side)                                           │
└─────────────────────┬───────────────────────────────────┘
                      │
┌─────────────────────┴───────────────────────────────────┐
│                    Rust Backend (Tauri 2)                │
│                                                          │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ Bashkit      │  │ TTS Engine   │  │ File I/O       │  │
│  │ (virtual     │  │ (existing    │  │ (app_data_dir) │  │
│  │  bash +      │  │  Piper ONNX) │  │                │  │
│  │  ReadWriteFs)│  │              │  │                │  │
│  │              │  │ Custom cmds: │  │                │  │
│  │ Custom cmds: │  │  synthesize  │  │                │  │
│  │  chastity    │  │  list_tracks │  │                │  │
│  │  activity    │  │  etc.        │  │                │  │
│  │  writeScript │  │              │  │                │  │
│  └─────────────┘  └──────────────┘  └────────────────┘  │
│                                                          │
│  All share app_data_dir as the filesystem root          │
└─────────────────────────────────────────────────────────┘
```

### Tech Stack

| Layer | Technology | Reference |
|-------|-----------|-----------|
| Frontend framework | React 19 + Vite | Already set up |
| Styling | Tailwind CSS 4 | https://tailwindcss.com |
| Chat UI components | AI Elements | https://elements.ai-sdk.dev/llms.txt |
| AI SDK | Vercel AI SDK | https://ai-sdk.dev |
| LLM Provider | OpenRouter (primary), OpenAI-compatible (extensible) | https://openrouter.ai |
| Desktop/Mobile shell | Tauri 2 | https://v2.tauri.app |
| Bash sandbox | bashkit (Rust) | https://bashkit.sh, https://docs.rs/bashkit |
| TTS engine | Piper ONNX (existing) | Already integrated |

### Design Theme

- **Primary**: White background
- **Accent**: Pastel pink (e.g., `#F8C6D6`, `#F4A6C0`, `#FFB6C1`)
- Use Tailwind CSS variables for theming
- Responsive: works on mobile (Tauri 2 mobile) and desktop

---

## Agent System

### Overview

The main agent lives in the React frontend. It uses the Vercel AI SDK's `useChat` hook with a **custom `ChatTransport`** that calls OpenRouter directly from the browser (no Next.js backend needed). Tool execution routes through Tauri commands to the Rust backend.

### AI SDK Integration (Client-Side)

Since this is a Tauri app (not Next.js), we cannot use API routes. Instead:

1. Install `ai`, `@ai-sdk/react`, `@ai-sdk/openai` (OpenRouter is OpenAI-compatible)
2. Create a custom `ChatTransport` implementation that:
   - Receives messages from `useChat`
   - Calls `streamText` from the AI SDK directly in the browser
   - Uses the OpenAI provider pointed at `https://openrouter.ai/api/v1`
   - Passes the user's API key and selected model
   - Streams the response back to `useChat`
3. Tools are executed client-side: when the agent calls a tool, the transport invokes Tauri commands

```typescript
// Pseudo-code for the custom transport
import { streamText, convertToModelMessages, type UIMessage } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';

function createOpenRouterTransport(apiKey: string, model: string, tools: Record<string, Tool>) {
  const provider = createOpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: apiKey,
  });

  return {
    async submitMessages({ messages, body }: { messages: UIMessage[] }) {
      const result = streamText({
        model: provider(model),
        system: body?.systemPrompt,
        messages: convertToModelMessages(messages),
        tools,
      });
      return result.toUIMessageStreamResponse();
    },
  };
}
```

> **Note**: The Vercel AI SDK's `useChat` expects a `transport` object. See:
> - https://ai-sdk.dev/docs/ai-sdk-ui/chatbot
> - https://ai-sdk.dev/reference/ai-sdk-ui/use-chat

### Agent Configuration

Users configure in Settings (persisted to localStorage or Tauri secure storage):

```typescript
interface AgentConfig {
  // Per-agent provider settings
  agents: {
    main: { provider: 'openrouter' | 'openai'; model: string };
    planner: { provider: 'openrouter' | 'openai'; model: string };
    writer: { provider: 'openrouter' | 'openai'; model: string };
  };
  // API keys per provider
  apiKeys: {
    openrouter?: string;
    openai?: string;
  };
}
```

### Agent Tools (Main Agent)

The main agent has these tools available (implemented as Tauri command invocations):

| Tool | Description | Implementation |
|------|-------------|---------------|
| `bash` | Execute a command in bashkit sandbox | Tauri command → bashkit `exec()` |
| `read_file` | Read a file from app_data_dir | Tauri command → `std::fs::read` |
| `write_file` | Write a file to app_data_dir | Tauri command → `std::fs::write` |
| `list_files` | List files in a directory | Tauri command → `std::fs::read_dir` |
| `synthesize` | Render TTS tags to audio | Existing Tauri command |
| `invoke_planner` | Spawn hypno planner subagent | Frontend LLM call (separate `streamText`) |
| `get_activity` | Query activity log | Tauri command → SQLite query |

### Subagent: Hypno Planner

- Spawned when main agent calls `invoke_planner` tool
- Separate `streamText` call with:
  - System prompt from `prompts/hypno_planner.md`
  - Model from `AgentConfig.agents.planner`
  - Tools: `bash`, `read_file`, `write_file`, `list_files`, `invoke_writer`
- Has full filesystem access (via bashkit/Read/Write tools)
- Creates conditioning JSON metadata files
- Invokes writer subagent via `invoke_writer` tool

### Subagent: Hypno Writer

- Spawned when planner calls `invoke_writer(path: string, instructions: string)` tool
- Separate `streamText` call with:
  - System prompt from `prompts/hypno_writer.md`
  - Model from `AgentConfig.agents.writer`
  - **No filesystem access**
  - Single tool: `writeScript(content: string)` — writes XML to the path specified by the planner, returns validation result
- The writer's non-tool output (text between tool calls) is routed back to the planner as part of the `invoke_writer` tool result

### Prompt System

Prompts live in `app_data_dir/prompts/`. The agent cannot write to this directory (enforced by filesystem permissions in the Tauri backend).

#### Prompt Loading

When the agent session starts (or when a new chat is created):

1. Read `prompts/main_agent.md`
2. Process `{{{embed 'path'}}}` directives — replace with contents of `prompts/path`
3. Process `{{special}}` directives — scan `prompts/special/**/*.md`, extract YAML frontmatter from each file, output as a markdown table:

```markdown
| File | Fields |
|------|--------|
| commands/chastity.md | name, description, usage, examples |
| commands/activity.md | name, description, usage, examples |
```

4. The processed prompt becomes the system message for the LLM

#### Embed Directive

```
{{{embed 'shared/tools.md'}}}
```

- Path is relative to `prompts/` directory
- Resolves to `prompts/shared/tools.md`
- Content is inlined at load time (before sending to LLM)
- Embeds can be nested (an embedded file can contain further embeds)
- Circular embeds: silent skip (track visited files)

#### Special Directive

```
{{special}}
```

- Scans `prompts/special/**/*.md` (recursive)
- Extracts YAML frontmatter from each file
- Outputs a markdown table with all frontmatter fields
- Purpose: gives the agent awareness of available documentation/skills without loading them all
- Agent can then `read_file` the relevant `special/` file when it needs details

### Chat UI (AI Elements)

Use AI Elements components for the chat interface. Key components:

- `Conversation` + `ConversationContent` + `ConversationScrollButton` — scrollable message container
- `Message` + `MessageContent` + `MessageResponse` — individual messages with streaming markdown
- `PromptInput` + `PromptInputTextarea` + `PromptInputSubmit` — input area
- `Tool` + `ToolHeader` + `ToolContent` — tool call display (when agent runs bash commands, synthesize, etc.)

Reference: https://elements.ai-sdk.dev/llms.txt

**Important**: AI Elements requires Tailwind CSS 4 and shadcn/ui. Install via:
```bash
npx ai-elements@latest
```

Also add to `globals.css` (required for MessageResponse streaming markdown):
```css
@source "../node_modules/streamdown/dist/*.js";
```

### Streaming

Token-by-token streaming. The `useChat` hook + `MessageResponse` component handle this automatically when the transport returns a UI message stream.

---

## Feature Specifications

All feature data lives in `app_data_dir/`. The bashkit virtual filesystem is backed by `app_data_dir` using `ReadWriteFs`, so files written by the agent in bash are real files on disk.

### Directory Structure

```
app_data_dir/
├── model/                    # TTS model files (existing)
├── tracks/                   # Rendered audio tracks (existing)
├── conditioning/             # Conditioning scripts
│   ├── some_script.json      # Metadata
│   └── some_script.xml       # TTS XML script
├── rule/                     # Rules
│   └── some_rule.md
├── routines/                 # Routines
│   └── some_routine.md
├── inventory/                # Inventory
│   ├── items.csv             # User-owned items (user-only write)
│   └── wishlist.csv          # Agent can write recommendations
├── chastity/                 # Chastity state
│   └── state.json            # Lock status, hidden string, countdown
├── journal/                  # Journal
│   ├── *.md                  # User journal entries (user-only write)
│   └── format.json           # Agent-configured prompts
├── voice/                    # Voice training
│   ├── config.json
│   └── *.md
├── activity.db               # Activity log (SQLite)
├── prompts/                  # Agent prompts (READ-ONLY for agent)
│   ├── main_agent.md
│   ├── hypno_planner.md
│   ├── hypno_writer.md
│   ├── special/              # Documentation/skill files
│   │   ├── commands/
│   │   │   ├── chastity.md
│   │   │   └── activity.md
│   │   └── ...
│   └── shared/               # Shared embeddable snippets
│       └── ...
└── audio_cache/              # Cached rendered audio segments
    └── conditioning/
```

### 1. Conditioning (`conditioning/*.json` + `conditioning/*.xml`)

**Purpose**: TTS-based hypno scripts that the agent creates and the user plays back.

**JSON metadata format**:
```json
{
  "title": "Some Title",
  "description": "Some Description.",
  "script_path": "conditioning/some_file.xml",
  "tags": ["some", "tags"]
}
```

**Creation flow**:
1. Main agent decides a new conditioning script is needed
2. Main agent calls `invoke_planner` tool with instructions
3. Planner subagent (separate LLM call with filesystem access):
   - Plans the script content
   - Creates the JSON metadata file in `conditioning/`
   - Calls `invoke_writer(script_path, instructions)` tool
4. Writer subagent (separate LLM call, NO filesystem access):
   - Has single tool: `writeScript(content: string)`
   - Generates XML using TTS tags from `tts_tags.md`
   - Calls `writeScript(content)` → backend validates the XML (runs tag_parser) and writes to the path the planner specified
   - Returns validation result (valid/invalid + error messages)
   - Writer can iterate: call `writeScript` multiple times until valid
   - Non-tool output routed back to planner as tool result

**UI View**:
- List of conditioning scripts (browsing JSON metadata: title, description, tags)
- **Render** button: triggers TTS synthesis of the XML script
- **Play** button: plays the rendered audio (appears after rendering completes)
- User does NOT see the XML content
- If no rendered audio exists yet, show only the Render button

**Audio rendering & caching**:
- Scripts are rendered on-demand when user clicks "Render"
- Split rendering at `<include>` boundaries and `<until>` boundaries for caching
- Cached segments stored in `audio_cache/conditioning/<script_id>/`
- Interactive playback: segments separated by `<until>` are stitched at runtime with UI buttons

### 2. Rules (`rule/*.md`)

**Purpose**: Rules the user is expected to follow.

**Format**: See `examples/rule.md` for the standard.

**UI View**: List of rules with their names (derived from filename: `rules/rule_name.md` → "Rule Name") and content. Links to other features are clickable (e.g., `[link](conditioning/some_file.json)` navigates to that conditioning script).

**Agent access**: Read-only.

### 3. Routines (`routines/*.md`)

**Purpose**: Scheduled routines for the user.

**Format**: See `examples/routine.md`. YAML frontmatter with `schedule` in cron format.

**UI display for a routine `routines/some_routine.md` with schedule `30 2 * * *`**:
```
Name: Some Routine
Schedule: everyday at 2:30
Content: [file contents minus frontmatter]
```

**Agent access**: Read-only.

**Note**: Cron scheduling UI (notifications, reminders) is a future enhancement. For now, routines are displayed but not auto-triggered.

### 4. Inventory (`inventory/items.csv`, `inventory/wishlist.csv`)

**Purpose**: Track items the user owns and items they want.

**Format**: CSV files with columns defined by the user.

**Access**:
- `items.csv`: Agent can read/query (using `yq` or custom command). Only the user adds/updates entries. The agent should instruct the user to add new items.
- `wishlist.csv`: Agent can read AND write. Agent provides purchase recommendations by writing to this file.

**UI View**: Two tables (Items, Wishlist) with CSV data displayed readably.

### 5. Chastity

**Purpose**: Virtual lock mechanism for motivation/control.

**Flow**:
1. User inputs a secret string → string gets saved (hidden from user) in `chastity/state.json`
2. User sees: "Locked" status (no access to the string)
3. Agent sees: lock status and the hidden string (via `chastity info` command)
4. Agent can start a countdown: `chastity countdown <time>` (e.g., `2h`, `3d`, `1w`)
5. When countdown is active, user sees a live countdown timer in the UI
6. When countdown reaches zero → **auto-unlock** → string becomes visible to user
7. Agent can also unlock manually: `chastity unlock`

**State file** (`chastity/state.json`):
```json
{
  "locked": true,
  "hidden_string": "user's secret",
  "locked_at": "2026-06-05T10:00:00Z",
  "countdown_end": "2026-06-07T10:00:00Z",
  "countdown_active": true
}
```

**Bash commands** (custom bashkit commands):
```bash
chastity info          # Shows lock status (agent sees hidden string)
chastity unlock        # Unlocks, reveals string
chastity countdown 2h  # Starts a countdown
```

**UI View**: Lock status card with countdown timer (if active). Input field for locking (entering the secret string). The UI should NOT show the hidden string when locked — only when unlocked.

### 6. Journal (`journal/*.md`, `journal/format.json`)

**Purpose**: User's personal journal entries.

**Access**:
- `journal/*.md`: User writes entries. Agent is read-only.
- `journal/format.json`: Agent can customize prompts and settings.

**Format**: See `examples/format.json`:
```json
[
  { "type": "freeform", "prompt": "How was your day?" },
  { "type": "scale", "prompt": "On a scale of 1-5 how content are you?" },
  { "type": "choice", "prompt": "What do you like most?", "options": ["Birds", "Deers"] }
]
```

**UI View**: Journal entry form based on `format.json` prompts. Past entries list.

### 7. Voice Training (`voice/config.json`, `voice/*.md`)

**Purpose**: Voice feminization training guidance.

**Access**: Agent can read and write config and guidance files.

**UI View**: Training configuration and guidance materials.

### 8. Activity Tracking (`activity.db`)

**Purpose**: Log of user actions for progress tracking.

**Storage**: SQLite database (`activity.db` in app_data_dir). Works on both mobile and desktop.

**Schema**:
```sql
CREATE TABLE activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day INTEGER NOT NULL,          -- Relative day since start
  number INTEGER NOT NULL,       -- Sequence number within the day
  feature TEXT NOT NULL,         -- 'rule', 'routine', 'journal', 'chastity', etc.
  action TEXT NOT NULL,          -- Description of what happened
  details TEXT,                  -- JSON with additional context
  timestamp TEXT NOT NULL        -- ISO 8601
);
CREATE UNIQUE INDEX idx_activity_id ON activities(day, number);
```

**Activity IDs**: Format `#<day>-<number>` (e.g., `#1-22`).

**Bash commands** (custom bashkit commands):
```bash
activity list                              # Recent activity, current relative day
activity list --filter rule                # Filter to specific feature
activity list --filter rule/some_rule.md   # Filter to specific file
activity list -w 1d                        # Time window (default: 1d)
activity list -t 1                         # Show activity from day 1
activity inspect #1-22                     # Details on specific activity
```

**What gets logged**: User actions — journal entry written, rule broken/completed, routine triggered, chastity locked/unlocked, conditioning played, etc. The agent explicitly logs activities (via an `activity log` bash command or internal tool).

**UI View**: Activity feed/list with filtering, inspectable entries.

### 9. Settings

**UI View**: Configuration form for:
- API keys (OpenRouter, OpenAI)
- Model selection per agent (main, planner, writer) — dropdown of model IDs
- Data directory info (show path to app_data_dir)
- Import zip button (to populate filesystem)
- TTS model management (existing download/load functionality)

---

## TTS `<include>` Tag

### Tag Definition

```xml
<include src="conditioning/foo.xml"/>
```

- Includes the content of another XML file at that point in the document
- `src` path is **relative to app_data_dir root** (the virtual filesystem root)
- Included file can contain any valid tags and expressions
- The included content becomes part of the segment tree as if it were written inline

### Implementation (tag_parser.rs)

1. Add a new `Node::Include { src: String }` variant to the AST enum
2. Add `parse_include_tag()` method to `TagParser`
3. The parser reads `<include src="..."/>` and creates an `Include` node

### Implementation (audio_renderer.rs)

1. Before rendering, **pre-process** the AST to resolve all `<include>` nodes:
   - Walk the AST tree
   - When an `Include` node is encountered:
     - Read the file from app_data_dir (or bashkit FS path)
     - Parse the included file's content with `tag_parser::parse()`
     - Replace the `Include` node with the parsed children
     - Track visited files in a set (for circular include detection)
     - If a file has already been visited → **silent skip** (omit the include)
   - This pre-processing is recursive (included files can contain includes)

```rust
fn resolve_includes(
    nodes: Vec<Node>,
    base_dir: &Path,
    visited: &mut HashSet<PathBuf>,
) -> Vec<Node> {
    let mut result = Vec::new();
    for node in nodes {
        match node {
            Node::Include { src } => {
                let path = base_dir.join(&src);
                let canonical = path.canonicalize().unwrap_or(path.clone());
                if visited.contains(&canonical) {
                    continue; // Silent skip for circular includes
                }
                if !path.exists() {
                    continue; // Silent skip for missing files
                }
                visited.insert(canonical);
                let content = std::fs::read_to_string(&path).unwrap_or_default();
                if let Ok(included_nodes) = tag_parser::parse(&content) {
                    let resolved = resolve_includes(included_nodes, base_dir, visited);
                    result.extend(resolved);
                }
                visited.remove(&path.canonicalize().unwrap_or(path.clone()));
            }
            other => {
                // Recursively resolve includes in children
                result.push(resolve_includes_in_children(other, base_dir, visited));
            }
        }
    }
    result
}
```

4. Call `resolve_includes()` before rendering in `render_to_file()`

### Segment Caching

For performance, cache rendered audio at `<include>` boundaries:

- When rendering a conditioning script, split the AST at `<include>` nodes
- Render each segment independently and cache by file hash
- When the same included file is used in multiple scripts, reuse the cached audio
- Store cached segments in `audio_cache/` directory
- Cache key: hash of the included file's content

Similarly, split at `<until>` boundaries for interactive playback:
- Each segment between `<until>` tags is rendered independently
- Segments are stitched at playback time
- When an `<until>` is reached, the segment loops and a button appears
- When the button is pressed, the next segment plays

### tts_tags.md Update

Add the `<include>` tag documentation to `tts_tags.md`:

```markdown
<include src="filename.xml"/>

Includes the content of another XML file at that point. The included file can contain
any valid tags and expressions.

Path is relative to the filesystem root (app_data_dir).

Circular includes are silently skipped.
```

---

## Bashkit Integration

### Setup

1. Add bashkit to `src-tauri/Cargo.toml`:
   ```toml
   [dependencies]
   bashkit = "..."  # Check https://crates.io/crates/bashkit for latest version
   ```

2. Initialize bashkit in `lib.rs` with `ReadWriteFs` backed by `app_data_dir`:

```rust
use bashkit::{Bash, fs::ReadWriteFs};

fn create_bash_sandbox(app_data_dir: &Path) -> Bash {
    let fs = ReadWriteFs::new(app_data_dir);
    Bash::builder()
        .filesystem(fs)
        .build()
}
```

Reference: https://bashkit.sh and https://docs.rs/bashkit

### Tauri Command: `exec_bash`

Expose bashkit execution as a Tauri command:

```rust
#[tauri::command]
async fn exec_bash(
    command: String,
    state: State<'_, AppState>,
) -> Result<BashResult, String> {
    let bash = state.bash.lock().await;
    let result = bash.exec(&command).await
        .map_err(|e| e.to_string())?;
    Ok(BashResult {
        stdout: result.stdout,
        stderr: result.stderr,
        exit_code: result.exit_code,
    })
}
```

### Custom Bash Commands

Register custom commands in bashkit for feature-specific operations:

#### `chastity` command

```bash
# chastity info — show lock status
# chastity unlock — unlock
# chastity countdown <time> — set countdown
# chastity lock <string> — lock with secret string (user-facing, not agent)
```

Implementation: reads/writes `chastity/state.json`, parses time formats (`2h`, `3d`, `1w`, `1m`).

#### `activity` command

```bash
# activity list [--filter <path>] [-w <window>] [-t <time>]
# activity inspect <id>
# activity log <feature> <action> [details]  # Used by agent to log events
```

Implementation: queries `activity.db` (SQLite via bashkit's built-in `sqlite3` or Rust `rusqlite`).

#### `writeScript` command (writer subagent)

This is NOT a bash command. It's an AI SDK tool that the writer subagent uses. The backend validates and writes the XML:

```rust
#[tauri::command]
async fn write_script(
    path: String,
    content: String,
    state: State<'_, AppState>,
) -> Result<WriteScriptResult, String> {
    // Validate XML by parsing
    match tag_parser::parse(&content) {
        Ok(nodes) => {
            let full_path = state.app_data_dir.join(&path);
            std::fs::write(&full_path, &content).map_err(|e| e.to_string())?;
            Ok(WriteScriptResult { valid: true, error: None })
        }
        Err(e) => Ok(WriteScriptResult {
            valid: false,
            error: Some(e.to_string()),
        }),
    }
}
```

---

## UI Implementation

### Layout

```
┌──────────────────────────────────────────────────────────┐
│  ┌───────────┐  ┌──────────────────────────────────────┐  │
│  │           │  │                                      │  │
│  │  Sidebar  │  │         Main Content Area            │  │
│  │           │  │                                      │  │
│  │  📝 Chat  │  │  (Chat view, or feature view,        │  │
│  │  🎙 Cond. │  │   or settings, depending on          │  │
│  │  📋 Rules │  │   selected sidebar item)             │  │
│  │  📅 Routines│ │                                      │  │
│  │  📦 Invent│  │                                      │  │
│  │  🔒 Chast.│  │                                      │  │
│  │  📔 Journal│ │                                      │  │
│  │  🎤 Voice │  │                                      │  │
│  │  📊 Activity│ │                                      │  │
│  │  ⚙ Settings│ │                                      │  │
│  │           │  │                                      │  │
│  └───────────┘  └──────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

- Sidebar on the left (collapsible on mobile)
- Main content area on the right
- Chat is the default view

### Styling

```css
/* Tailwind theme extensions */
:root {
  --color-pink-50: #FDF2F8;
  --color-pink-100: #FCE7F3;
  --color-pink-200: #FBCFE8;
  --color-pink-300: #F9A8D4;
  --color-pink-400: #F472B6;
  --color-pink-500: #EC4899;
  --color-pink-600: #DB2777;
}

/* Primary accent: pastel pink */
:root {
  --accent: #F8C6D6;
  --accent-foreground: #1F1020;
  --background: #FFFFFF;
  --foreground: #1A1A1A;
}
```

Use Tailwind utility classes throughout. Follow shadcn/ui conventions for component styling.

### Component Structure

```
src/
├── main.tsx
├── App.tsx                      # Main app shell with routing
├── globals.css                  # Tailwind imports + theme
├── lib/
│   ├── agent.ts                 # Agent transport, tool definitions
│   ├── prompts.ts               # Prompt loading + embed/special processing
│   ├── store.ts                 # Zustand store for app state
│   └── utils.ts                 # Utility functions (cn, formatters)
├── components/
│   ├── ui/                      # shadcn/ui base components
│   ├── ai-elements/             # AI Elements components (installed via CLI)
│   ├── layout/
│   │   ├── Sidebar.tsx          # Navigation sidebar
│   │   └── AppShell.tsx         # Main layout wrapper
│   ├── chat/
│   │   ├── ChatView.tsx         # Main agent chat interface
│   │   ├── ChatMessage.tsx      # Message renderer
│   │   └── ChatInput.tsx        # Prompt input
│   └── features/
│       ├── ConditioningView.tsx
│       ├── RulesView.tsx
│       ├── RoutinesView.tsx
│       ├── InventoryView.tsx
│       ├── ChastityView.tsx
│       ├── JournalView.tsx
│       ├── VoiceTrainingView.tsx
│       ├── ActivityView.tsx
│       └── SettingsView.tsx
├── hooks/
│   ├── useAgent.ts              # useChat wrapper with custom transport
│   ├── useBash.ts               # Execute bash commands
│   ├── useFileSystem.ts         # Read/write files via Tauri
│   └── useChastity.ts           # Chastity state polling
└── types/
    ├── agent.ts                 # Agent types, tool definitions
    ├── features.ts              # Feature data types
    └── tauri.ts                 # Tauri command types
```

### Routing

Use simple state-based routing (no React Router needed for a sidebar app):

```typescript
type View = 'chat' | 'conditioning' | 'rules' | 'routines' | 'inventory' |
            'chastity' | 'journal' | 'voice' | 'activity' | 'settings';

const [currentView, setCurrentView] = useState<View>('chat');
```

### Chat View (using AI Elements)

```tsx
import { Conversation, ConversationContent, ConversationScrollButton } from '@/components/ai-elements/conversation';
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message';
import { PromptInput, PromptInputTextarea, PromptInputSubmit, PromptInputBody, PromptInputFooter } from '@/components/ai-elements/prompt-input';
import { Tool, ToolHeader, ToolContent, ToolInput, ToolOutput } from '@/components/ai-elements/tool';
```

The chat view renders messages from `useChat`, handling text parts, tool-call parts, and reasoning parts. Tool calls show collapsible `Tool` components displaying the bash command, output, etc.

---

## Zip Import

Users can import a zip file to populate the filesystem (app_data_dir). This is useful for sharing configurations, prompts, conditioning scripts, etc.

**Implementation**:
1. Settings page has an "Import Zip" button
2. User selects a `.zip` file via Tauri file dialog
3. Backend unzips into `app_data_dir/` (merging with existing files, overwriting on conflict)
4. Feature directories (`conditioning/`, `rule/`, `routines/`, `prompts/`, etc.) are populated

**Zip structure**: Mirrors app_data_dir:
```
conditioning/
  script1.json
  script1.xml
rule/
  some_rule.md
routines/
  morning.md
prompts/
  main_agent.md
  special/
    commands/
      chastity.md
```

**Tauri command**:
```rust
#[tauri::command]
async fn import_zip(
    zip_path: String,
    state: State<'_, AppState>,
) -> Result<ImportResult, String> {
    // Unzip into app_data_dir
    // Return summary of imported files
}
```

---

## Implementation Phases

### Phase 1: Foundation

**Goal**: Get the basic app shell, settings, bashkit integration, and working agent chat.

**Tasks**:
1. Install dependencies:
   - `npm install ai @ai-sdk/react @ai-sdk/openai zod tailwindcss @tailwindcss/vite`
   - `npx ai-elements@latest` (install conversation, message, prompt-input, tool components)
   - `cargo add bashkit` (check latest version at https://crates.io/crates/bashkit)

2. Set up Tailwind CSS 4:
   - Configure `tailwind.config.ts` with pastel pink theme
   - Set up `globals.css` with theme variables and AI Elements `@source` directive

3. Create app shell:
   - `AppShell.tsx` with sidebar navigation
   - `Sidebar.tsx` with icons for each feature
   - State-based view routing

4. Implement Settings page:
   - API key inputs (OpenRouter, OpenAI)
   - Model selection dropdowns per agent (main, planner, writer)
   - Persist to localStorage or Tauri store plugin
   - TTS model management (move existing model status/download UI here)

5. Integrate bashkit:
   - Initialize `Bash` with `ReadWriteFs` backed by `app_data_dir`
   - Create `exec_bash` Tauri command
   - Create file read/write Tauri commands

6. Implement prompt system:
   - `prompts.ts`: load prompt, process `{{{embed}}}` directives, process `{{special}}` directive
   - Frontmatter parsing for `{{special}}` (use `gray-matter` or simple YAML parser)

7. Implement agent chat:
   - Custom `ChatTransport` for OpenRouter (client-side `streamText`)
   - `useAgent` hook wrapping `useChat`
   - Tools: `bash`, `read_file`, `write_file`, `list_files`
   - Chat UI with AI Elements components
   - Streaming token-by-token

8. Create basic `prompts/main_agent.md` placeholder (user populates via zip import)

### Phase 2: Prompt System & Subagents

**Goal**: Full prompt embedding system and subagent orchestration.

**Tasks**:
1. Complete prompt preprocessing:
   - `{{{embed 'path'}}}` resolution with circular detection
   - `{{special}}` table generation from `prompts/special/**/*.md`
   - Frontmatter extraction

2. Implement subagent invocation:
   - `invoke_planner` tool: spawns planner LLM call with planner system prompt + tools
   - `invoke_writer` tool (planner only): spawns writer LLM call with writer system prompt + `writeScript` tool only
   - Route writer output back to planner

3. Implement `writeScript` Tauri command:
   - Validates XML via `tag_parser::parse()`
   - Writes to specified path
   - Returns validation result

4. Register custom bashkit commands:
   - `chastity` (info, unlock, countdown)
   - `activity` (list, inspect, log)

### Phase 3: Core Features (Conditioning + TTS `<include>` + Rules + Routines)

**Goal**: TTS `<include>` tag, conditioning UI, rules UI, routines UI.

**Tasks**:
1. **TTS `<include>` tag**:
   - Add `Node::Include` to `tag_parser.rs`
   - Add `parse_include_tag()` method
   - Add `resolve_includes()` pre-processing in `audio_renderer.rs`
   - Update `tts_tags.md` with documentation
   - Add tests for include resolution, circular detection, missing files

2. **Conditioning UI**:
   - List conditioning scripts (read JSON metadata files)
   - Render button (calls `synthesize` Tauri command with XML content)
   - Play button (plays rendered WAV)
   - Card layout: title, description, tags, render/play buttons

3. **Rules UI**:
   - List rule files from `rule/` directory
   - Display rule content with markdown rendering
   - Derive display names from filenames

4. **Routines UI**:
   - List routine files from `routines/` directory
   - Parse cron schedule from frontmatter
   - Display name, human-readable schedule, content

### Phase 4: Remaining Features

**Goal**: Inventory, chastity, journal, voice training, activity tracking.

**Tasks**:
1. **Inventory UI**:
   - Parse CSV files (`items.csv`, `wishlist.csv`)
   - Display as tables
   - Items: read-only display
   - Wishlist: read-only display (agent writes)

2. **Chastity UI**:
   - Lock status display
   - Secret string input (hidden)
   - Countdown timer (live updating)
   - Poll `chastity/state.json` for updates

3. **Journal UI**:
   - Entry form based on `journal/format.json`
   - Display past entries (markdown rendering)
   - Save entries to `journal/*.md`

4. **Voice Training UI**:
   - Display config from `voice/config.json`
   - Display guidance from `voice/*.md`

5. **Activity Tracking UI**:
   - Initialize SQLite database (`activity.db`)
   - Activity feed with filtering
   - Activity inspect detail view
   - Activity log entries from agent

### Phase 5: Polish

**Goal**: Zip import, audio caching, interactive playback, mobile testing.

**Tasks**:
1. **Zip import**:
   - File dialog for selecting zip
   - Unzip into app_data_dir
   - Import summary

2. **Audio caching**:
   - Cache rendered segments at `<include>` boundaries
   - Cache key: file content hash
   - Cache directory: `audio_cache/`

3. **Interactive conditioning playback**:
   - Segment audio at `<until>` boundaries
   - UI buttons that appear during playback
   - Segment stitching at runtime

4. **Mobile testing**:
   - Test responsive layout
   - Test Tauri mobile build (iOS/Android)
   - Touch-friendly UI adjustments

5. **General polish**:
   - Error handling and user feedback (toasts)
   - Loading states
   - Keyboard shortcuts
   - Dark mode (optional, theme is primarily white)

---

## Key References

| Resource | URL |
|----------|-----|
| AI Elements docs | https://elements.ai-sdk.dev/llms.txt |
| AI SDK docs | https://ai-sdk.dev/docs |
| AI SDK useChat | https://ai-sdk.dev/reference/ai-sdk-ui/use-chat |
| AI SDK streamText | https://ai-sdk.dev/reference/ai-sdk-core/stream-text |
| OpenRouter API | https://openrouter.ai/docs |
| OpenRouter model list | https://openrouter.ai/models |
| bashkit docs | https://bashkit.sh |
| bashkit Rust API | https://docs.rs/bashkit |
| Tauri 2 docs | https://v2.tauri.app |
| Tailwind CSS 4 | https://tailwindcss.com |
| shadcn/ui | https://ui.shadcn.com |
| TTS tag reference | `tts_tags.md` (in project root) |
| Feature specs | `features.md` (in project root) |

---

## Notes for the Implementing Agent

1. **Read all existing code first**: Understand `tag_parser.rs`, `audio_renderer.rs`, `lib.rs` before modifying them. The TTS engine is complex and working — be careful not to break it.

2. **AI Elements + Vite (not Next.js)**: AI Elements is designed for Next.js but works with any React setup. You need to create a custom `ChatTransport` since there's no API route backend. The AI SDK's `streamText` can run directly in the browser.

3. **bashkit version**: Check https://crates.io/crates/bashkit for the latest version and API. The API may differ from what's shown in this plan — always check docs.rs.

4. **Tauri permissions**: You'll need to add capabilities to `src-tauri/capabilities/` for file system access, dialog, etc. See https://v2.tauri.app/security/permissions/

5. **Prompts directory**: The `prompts/` directory doesn't exist yet. It should be created in `app_data_dir` at first run. Users populate it via zip import. Create minimal placeholder files for development.

6. **The app_data_dir**: On desktop, this is typically `~/.local/share/com.train-me.app/` (Linux), `~/Library/Application Support/com.train-me.app/` (macOS), or `%APPDATA%/com.train-me.app/` (Windows). On mobile, Tauri manages it.

7. **Testing**: Run `cargo test` for Rust tests and `bun test` or `vitest` for frontend tests. The existing tag_parser has good test coverage — follow the same patterns for new features.

8. **Commit style**: Follow the user's commit message conventions (see their AGENTS.md preferences: short subject, imperative mood, no punctuation at end).

9. **Don't implement prompts content**: The user said "No need for initial versions" for prompt files. Create the infrastructure for loading/processing them, but don't write the actual prompt content.

10. **Conditioning scripts are created by the agent**, not hardcoded. The UI just displays what's in the `conditioning/` directory.
