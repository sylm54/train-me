/**
 * Subagent orchestration: self-spawn (the agent delegating to a fresh copy
 * of itself).
 *
 * The copy is spawned from the frontend via its own `streamText` call. It is
 * *not* exposed to the user — only its parent (the main agent) sees
 * `spawn_agent`.
 *
 * Lifecycle:

 *   Main agent
 *     └─ tool: spawn_agent(label, task) → copy @ depth 1
 *          └─ streamText(main prompt, copy tools)
 *               ├─ bash / read_file / write_file / edit_file / list_files
 *               └─ validate_files
 *
 * The copy runs the SAME rendered system prompt as the main agent (re-loaded
 * from disk on every spawn, so prompt edits apply immediately) with an empty
 * message history: the task brief is the only user message. That clean slate
 * is the point — long authoring jobs (audio scripts, feature files) run with
 * the docs index at the front of context instead of buried under chat
 * history. Only the copy's final text is returned to the parent as the tool
 * result.
 *
 * Depth cap: the copy's toolset simply has no `spawn_agent` tool, so the
 * recursion cap is structural, not advisory.
 *
 * All subagent activity is mirrored to the browser devtools console
 * (search for `[spawn]`). Each invocation opens a collapsed
 * console.group; expand it to see the full trace.
 */

import {
  streamText,
  convertToModelMessages,
  tool,
  type ToolSet,
  type UIMessage,
  isLoopFinished,
} from "ai";
import { z } from "zod";

import { loadPrompt } from "./prompts";
import { getProvider, buildProviderOptions } from "./agent";
import {
  bashTool,
  readFileTool,
  writeFileTool,
  editFileTool,
  listFilesTool,
  validateFilesTool,
} from "./tools";
import type { AgentSettings } from "./types";
import { emitAgentEvent, normalizeUsage, type AgentRole } from "./agent-events";

// ============================================================================
// Console logging helpers
// ============================================================================

type SubagentName = "spawn";

/** Distinct console-marker colour so it's easy to scan. */
const LOG_STYLE = "color:#d946ef;font-weight:bold"; // pink-500

/** Console tag for a subagent at a given depth, e.g. `[spawn]`. */
function tag(agent: SubagentName, depth: number): string {
  return depth > 1 ? `[${agent}·${depth}]` : `[${agent}]`;
}

/** Cap previews so a single tool result doesn't drown the console. */
const PREVIEW_MAX = 240;

/** Max length for a friendly tool detail (path / command) surfaced to the UI. */
const DETAIL_MAX = 60;

/**
 * Derive a short, friendly detail string from a tool's parsed input — e.g. a
 * file path, or (for bash) the command. Returns undefined when there's nothing
 * worth showing. Keeps the UI feed compact and free of raw JSON.
 */
function toolDetail(toolName: string, input: unknown): string | undefined {
  const obj = (input ?? {}) as Record<string, unknown>;
  if (typeof obj.path === "string" && obj.path.length > 0) return obj.path;
  if (toolName === "bash" && typeof obj.command === "string") {
    const c = obj.command.replace(/\s+/g, " ").trim();
    return c.length > DETAIL_MAX ? c.slice(0, DETAIL_MAX) + "…" : c;
  }
  return undefined;
}

/**
 * Truncate a value (usually a string or serialisable object) for compact
 * console output. Returns the original value if it's already short.
 */
function preview(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.length <= PREVIEW_MAX) return value;
    return (
      value.slice(0, PREVIEW_MAX) + `… (+${value.length - PREVIEW_MAX} chars)`
    );
  }
  if (value && typeof value === "object") {
    let json: string;
    try {
      json = JSON.stringify(value);
    } catch {
      return String(value);
    }
    if (json.length <= PREVIEW_MAX) return value;
    return (
      json.slice(0, PREVIEW_MAX) + `… (+${json.length - PREVIEW_MAX} chars)`
    );
  }
  return value;
}

/** Emit a prefixed console.log entry for the given subagent + depth. */
function log(
  agent: SubagentName,
  depth: number,
  message: string,
  ...args: unknown[]
) {
  console.log(`%c${tag(agent, depth)}`, LOG_STYLE, message, ...args);
}

// ── UI progress events ────────────────────────────────────────────────
//
// High-level labels surfaced to the UI via the agent event bus. These
// intentionally hide *what* a tool is doing — the user just sees a
// friendly verb like "Reading file". Exact arguments/results stay in the
// console (via `log` above).

const START_LABEL: Record<SubagentName, string> = {
  spawn: "Working on a task",
};

const STEP_LABEL: Record<string, string> = {
  bash: "Running command",
  read_file: "Reading file",
  write_file: "Writing file",
  edit_file: "Editing file",
  list_files: "Listing files",
  validate_files: "Validating files",
  spawn_agent: "Delegating",
};

/** Push a subagent-start event so the UI can show progress etc. */
function emitStart(agent: SubagentName, depth: number, label?: string) {
  emitAgentEvent({
    type: "subagent-start",
    agent,
    depth,
    label: label ? `Working on: ${label}` : START_LABEL[agent],
    task: label,
    ts: Date.now(),
  });
}

/** Update the current step label for a running subagent. */
function emitStep(
  agent: SubagentName,
  depth: number,
  toolName: string,
  detail?: string,
  attempt?: number,
) {
  emitAgentEvent({
    type: "subagent-step",
    agent,
    depth,
    label: STEP_LABEL[toolName] ?? toolName,
    detail,
    attempt,
    ts: Date.now(),
  });
}

/** Record one completed subagent tool call in the UI history feed. */
function emitTool(
  agent: SubagentName,
  depth: number,
  toolName: string,
  detail: string | undefined,
  attempt: number | undefined,
  ok: boolean,
) {
  emitAgentEvent({
    type: "subagent-tool",
    agent,
    depth,
    toolName,
    label: STEP_LABEL[toolName] ?? toolName,
    detail,
    attempt,
    ok,
    ts: Date.now(),
  });
}

/** Pop a subagent activity when its run completes. */
function emitEnd(agent: SubagentName, depth: number) {
  emitAgentEvent({ type: "subagent-end", agent, depth, ts: Date.now() });
}

/** Report normalized token usage for a subagent step to the UI bus. */
function reportUsage(agent: SubagentName, usage: unknown, providerMetadata?: unknown) {
  try {
    emitAgentEvent({
      type: "usage",
      role: agent as AgentRole,
      ts: Date.now(),
      usage: normalizeUsage(usage, providerMetadata),
    });
  } catch {
    // Usage is informational; never let it break a run.
  }
}

/**
 * Run a single subagent invocation to completion and return the assistant's
 * last text message — i.e. the text emitted after the final tool call.
 *
 * Intermediate "thinking out loud" produced between tool calls (e.g.
 * "Let me read the file..." before invoking a tool) is intentionally
 * discarded so the parent agent only sees the final, polished answer.
 *
 * Reasoning / thinking chunks emitted by the model (e.g. Claude extended
 * thinking, o1/o3 reasoning) are also deliberately discarded from the
 * returned text. This keeps the subagent's chain-of-thought from leaking
 * back into the parent agent's tool result, where it would just add noise.
 *
 * Caller wraps the call in a `console.groupCollapsed(...)`; this function
 * logs each significant stream event inside that group.
 */
async function runSubagent(opts: {
  settings: AgentSettings;
  agent: SubagentName;
  /** Chain depth of this run (always 1 — copies get no spawn tool). */
  depth: number;
  /** What the copy was spawned for — surfaced on the UI progress feed. */
  label?: string;
  systemPrompt: string;
  messages: UIMessage[];
  tools: ToolSet;
}): Promise<string> {
  const cfg = getProvider(opts.settings, "main");
  if (!cfg) {
    log(opts.agent, opts.depth, "✗ no API key for provider");
    throw new Error(
      `No API key configured for the "${opts.settings.agents.main.provider}" provider.`,
    );
  }

  log(
    opts.agent,
    opts.depth,
    `▶ starting (${opts.settings.agents.main.provider}/${cfg.model})`,
  );
  emitStart(opts.agent, opts.depth, opts.label);

  // `result` is declared outside the try so the `finally` block can read
  // its (fallback) usage; `streamText` runs synchronously, but the awaited
  // message conversion happens before assignment — so it may stay undefined
  // if that throws.
  let result: ReturnType<typeof streamText> | undefined;
  const reportedUsage = { done: false };
  try {
    const modelMessages = await convertToModelMessages(opts.messages);
    // Use `.chat()` to force the Chat Completions API — see agent.ts for
    // the full rationale (OpenRouter doesn't support the Responses API).
    result = streamText({
      model: cfg.provider.chat(cfg.model, cfg.modelSettings),
      system: withSubagentContext(opts.agent, opts.depth, opts.systemPrompt),
      messages: modelMessages,
      tools: opts.tools,
      stopWhen: isLoopFinished(),
      providerOptions: buildProviderOptions(
        opts.settings,
        "main",
      ) as Parameters<typeof streamText>[0]["providerOptions"],
      // Report usage per step (LLM call) rather than only the cumulative
      // `totalUsage` at the end — same rationale as agent.ts, and the
      // per-step events are where cache-hit counts and the OpenRouter
      // charge surface.
      onStepFinish: ({ usage, providerMetadata }) => {
        reportedUsage.done = true;
        reportUsage(opts.agent, usage, providerMetadata);
      },
    });

    // Track per-step text so we can flush it when a tool call or finish
    // arrives. The SDK emits text-delta chunks per turn; accumulating and
    // flushing on tool/start-of-next-activity keeps the console readable.
    let finalText = "";
    let pendingText = "";

    // Per-tool-call bookkeeping for the UI feed. We buffer each call's input
    // JSON deltas (keyed by id) so we can derive a friendly detail
    // (path/command) once the call resolves.
    const toolInputBuffers = new Map<string, string>();
    const toolNamesById = new Map<string, string>();

    const finishToolCall = (
      id: string,
      toolName: string,
      ok: boolean,
      input?: unknown,
    ) => {
      emitTool(
        opts.agent,
        opts.depth,
        toolName,
        toolDetail(toolName, input),
        undefined,
        ok,
      );
      toolInputBuffers.delete(id);
      toolNamesById.delete(id);
    };

    for await (const part of result.fullStream) {
      switch (part.type) {
        case "text-delta":
          pendingText += part.text;
          finalText += part.text;
          break;

        case "text-end":
          if (pendingText.trim()) {
            log(opts.agent, opts.depth, "💬 text", preview(pendingText.trim()));
          }
          pendingText = "";
          break;

        case "reasoning-start":
          // Reasoning is intentionally NOT accumulated into finalText —
          // subagent thinking must not leak into tool results returned to the
          // parent agent. We just open a console group for it so it can be
          // inspected during debugging.
          if (pendingText.trim()) {
            log(opts.agent, opts.depth, "💬 text", preview(pendingText.trim()));
            pendingText = "";
          }
          console.groupCollapsed(
            `%c${tag(opts.agent, opts.depth)}`,
            LOG_STYLE,
            "💭 reasoning",
          );
          break;

        case "reasoning-delta":
          // See reasoning-start: intentionally not added to finalText.
          break;

        case "reasoning-end":
          console.groupEnd();
          break;

        case "tool-input-start": {
          // Flush any text that preceded this tool call.
          if (pendingText.trim()) {
            log(opts.agent, opts.depth, "💬 text", preview(pendingText.trim()));
            pendingText = "";
          }
          // Discard any text accumulated so far — it was inter-step
          // "thinking" emitted before this tool call, not the final
          // answer. The caller only wants the text from the LAST
          // assistant message (after the final tool call returns).
          finalText = "";
          const dynamic = "dynamic" in part && part.dynamic ? " (dynamic)" : "";
          log(opts.agent, opts.depth, `🔧 tool call: ${part.toolName}${dynamic}`);
          toolInputBuffers.set(part.id, "");
          toolNamesById.set(part.id, part.toolName);
          // Surface a friendly step label to the UI progress feed.
          emitStep(opts.agent, opts.depth, part.toolName, undefined, undefined);
          break;
        }

        case "tool-input-delta": {
          // Buffer the input JSON deltas so we can parse a detail later.
          const buf = toolInputBuffers.get(part.id);
          if (buf !== undefined) toolInputBuffers.set(part.id, buf + part.delta);
          break;
        }

        case "tool-input-end":
          // Tool input parsing complete; the buffered JSON is consumed on
          // tool-result/tool-error.
          break;

        case "tool-result": {
          // The `output` field is the JSON the tool's execute() returned.
          const outputPreview = preview("output" in part ? part.output : part);
          log(opts.agent, opts.depth, `↳ ${part.toolName} result`, outputPreview);
          const input =
            "input" in part ? (part as { input?: unknown }).input : undefined;
          finishToolCall(part.toolCallId, part.toolName, true, input);
          break;
        }

        case "tool-error": {
          const msg =
            "errorText" in part && typeof part.errorText === "string"
              ? part.errorText
              : "unknown tool error";
          log(opts.agent, opts.depth, `✗ ${part.toolName} error`, msg);
          const input =
            "input" in part ? (part as { input?: unknown }).input : undefined;
          finishToolCall(part.toolCallId, part.toolName, false, input);
          break;
        }

        case "error": {
          const msg =
            "error" in part && part.error instanceof Error
              ? part.error.message
              : String(part);
          log(opts.agent, opts.depth, "✗ stream error", msg);
          break;
        }

        case "finish": {
          if (pendingText.trim()) {
            log(opts.agent, opts.depth, "💬 text", preview(pendingText.trim()));
            pendingText = "";
          }
          log(
            opts.agent,
            opts.depth,
            `■ finish`,
            `reason=${("finishReason" in part ? part.finishReason : "?") as string}`,
          );
          break;
        }

        default:
          // text-start, tool-input-delta, raw, etc. — too noisy
          // to log by default.
          break;
      }
    }

    return finalText;
  } finally {
    // If the stream broke before any step finished (e.g. a connection error
    // on the first call), still try to surface whatever usage the SDK
    // accumulated, then pop the activity from the UI progress feed. Done in
    // `finally` so an error still clears the spinner.
    if (result && !reportedUsage.done) {
      try {
        const usage = await Promise.resolve(result.totalUsage);
        reportUsage(opts.agent, usage);
      } catch {
        // ignore — usage is best-effort
      }
    }
    emitEnd(opts.agent, opts.depth);
  }
}

// ============================================================================
// Subagent context injection
// ============================================================================

/**
 * Prefix prepended to the copy's system prompt (below its file prompt).
 *
 * Framework prompts are written for the agent generally; nothing in them says
 * "you are the spawned copy right now". Without that, a spawned copy has been
 * observed trying to hand its own task back through a spawn tool — or
 * addressing the user as if in chat. Stating the identity explicitly makes
 * the model do the work itself and return the result as its final text.
 */
function withSubagentContext(
  agent: SubagentName,
  depth: number,
  systemPrompt: string,
): string {
  return (
    `[Subagent context — injected by the app, not part of your file prompt]\n` +
    `You ARE a fresh copy of the main agent (the "${agent}" subagent, depth ${depth}), ` +
    `spawned by the main agent via a tool call. The user does not see your messages — ` +
    `only your final text is returned to the caller as that tool's result.\n` +
    `You have no tool to spawn further copies: whatever task you were given is yours ` +
    `to complete directly.\n\n` +
    systemPrompt
  );
}

// ============================================================================
// spawn_agent tool
// ============================================================================

/**
 * Build the spawned copy's toolset: the main agent's file/inspection tools
 * minus the user-facing `ask_question` (a background copy asking the user a
 * question would block forever) and minus any spawn tool — copies work
 * directly, so the recursion cap is structural.
 */
function buildSpawnedTools(): ToolSet {
  return {
    bash: bashTool,
    read_file: readFileTool,
    write_file: writeFileTool,
    edit_file: editFileTool,
    list_files: listFilesTool,
    validate_files: validateFilesTool,
  };
}

/**
 * Spawn a fresh copy of the main agent with a high-level task from its
 * parent. Loads and renders `prompts/main_agent.md` on every invocation so
 * the user can edit it and see changes immediately.
 */
export async function spawnAgent(opts: {
  settings: AgentSettings;
  task: string;
  /** Short human-readable label for what this copy is for. */
  label?: string;
}): Promise<string> {
  const depth = 1;
  const systemPrompt = await loadPrompt("main_agent.md");

  if (!systemPrompt) {
    log("spawn", depth, "✗ prompts/main_agent.md missing or empty");
    throw new Error(
      "prompts/main_agent.md is empty or missing. " +
        "Add a system prompt for the agent before spawning a copy.",
    );
  }

  console.groupCollapsed(
    `%c${tag("spawn", depth)}`,
    LOG_STYLE,
    `▶ spawn_agent${opts.label ? ` — ${opts.label}` : ""}`,
  );
  log("spawn", depth, "task", preview(opts.task));

  try {
    const messages: UIMessage[] = [
      {
        id: `spawn-user-${Date.now()}`,
        role: "user",
        parts: [{ type: "text", text: opts.task }],
      },
    ];

    const out = await runSubagent({
      settings: opts.settings,
      agent: "spawn",
      depth,
      label: opts.label,
      systemPrompt,
      messages,
      tools: buildSpawnedTools(),
    });
    log("spawn", depth, "✔ spawn done");
    return out;
  } catch (e) {
    log(
      "spawn",
      depth,
      "✗ spawn failed",
      e instanceof Error ? e.message : String(e),
    );
    throw e;
  } finally {
    console.groupEnd();
  }
}

/**
 * Build the `spawn_agent` tool as exposed to the main agent.
 *
 * The tool takes a short human-readable `label` (what the copy is for —
 * shown on the UI progress feed so the user can follow the delegation) and a
 * self-contained `task` string, and returns the copy's final answer (which
 * the parent sees as the tool result). Rebuilt whenever `settings` change
 * because it captures the settings for the spawned LLM call.
 */
export function buildSpawnAgentTool(settings: AgentSettings) {
  return tool({
    description:
      "Spawn a fresh copy of yourself with a clean context to complete a " +
      "self-contained task. The copy runs your same system prompt and tools " +
      "(except this one) with the task as its only input; only its final " +
      "text comes back to you — it cannot see this conversation, and the " +
      "user does not see its work. Use this for substantial, separable " +
      "authoring jobs (e.g. writing or reworking audio scripts, building a " +
      "set of feature files) where a clean slate with the reference docs at " +
      "the front of context produces better work than tacking it onto this " +
      "chat. For small fixes, do them directly. Provide a fully " +
      "self-contained brief — include the goal, relevant paths and context, " +
      "and any constraints; assume the copy reads no part of this chat.",
    inputSchema: z.object({
      label: z
        .string()
        .describe(
          "Short name for what this copy is working on (a few words, e.g. " +
            "'evening audio script' or 'habit feature files'). Shown to the " +
            "user on the progress feed while the copy runs.",
        ),
      task: z
        .string()
        .describe(
          "A self-contained brief for the copy. Include what to create or " +
            "change, the files/docs to draw on, desired tone/format, and " +
            "any other context the copy would need. Do not assume the copy " +
            "sees this chat — include all relevant detail.",
        ),
    }),
    execute: async ({ label, task }) => {
      console.groupCollapsed(
        `%c[main]`,
        "color:#10b981;font-weight:bold",
        `▶ spawn_agent tool${label ? ` — ${label}` : ""}`,
      );
      console.log("task", preview(task));
      try {
        const output = await spawnAgent({ settings, task, label });
        console.log(
          `%c[main]`,
          "color:#10b981;font-weight:bold",
          "✔ spawn_agent result",
          preview(output),
        );
        return { ok: true, output };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.log(
          `%c[main]`,
          "color:#10b981;font-weight:bold",
          "✗ spawn_agent error",
          msg,
        );
        return { ok: false, error: msg };
      } finally {
        console.groupEnd();
      }
    },
  });
}
