/**
 * Subagent orchestration: hypno planner (recursive).
 *
 * The planner is spawned from the frontend via its own `streamText` call.
 * It is *not* exposed to the user — only its parent (the main agent, or
 * another planner) sees `invoke_planner`.
 *
 * Lifecycle (recursive):
 *
 *   Main agent
 *     └─ tool: invoke_planner(task)          → planner @ depth 1
 *          └─ streamText(planner prompt, planner tools)
 *               ├─ bash / read_file / write_file / edit_file / list_files
 *               ├─ validate_files (path-aware)
 *               └─ tool: invoke_planner(task) → planner @ depth 2
 *                    └─ … (up to MAX_SUBAGENT_DEPTH)
 *
 * The planner writes XML scripts directly with `write_file`/`edit_file` and
 * validates them with `validate_files` (optionally scoped to a path). Its
 * final text becomes the `invoke_planner` tool result the parent sees.
 *
 * Recursion cap: a planner running at chain depth `d` is given the
 * `invoke_planner` tool (which spawns depth `d+1`) only while
 * `d < MAX_SUBAGENT_DEPTH`. The deepest level simply has no spawn tool, so
 * it authors and validates directly — exceeding the cap is structurally
 * impossible, not merely discouraged.
 *
 * All subagent activity is mirrored to the browser devtools console
 * (search for `[planner]`). Each invocation opens a collapsed
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
import { emitAgentEvent, type AgentRole } from "./agent-events";

// ============================================================================
// Console logging helpers
// ============================================================================

type SubagentName = "planner";

/**
 * Maximum planner chain depth. Depth 1 = spawned by the main agent; each
 * nested spawn increments by one. A planner at this depth gets no
 * `invoke_planner` tool and works directly, so this is a hard, structural
 * cap on recursion. Tune to balance decomposition vs. token/latency cost.
 */
export const MAX_SUBAGENT_DEPTH = 3;

/** Distinct console-marker colour for the planner so it's easy to scan. */
const LOG_STYLES: Record<SubagentName, string> = {
  planner: "color:#d946ef;font-weight:bold", // pink-500
};

/**
 * Console tag for a subagent at a given depth, e.g. `[planner]` for the
 * first level and `[planner·2]`, `[planner·3]` for nested ones, so the
 * recursion depth is visible when scanning flat devtools logs.
 */
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
  console.log(`%c${tag(agent, depth)}`, LOG_STYLES[agent], message, ...args);
}

// ── UI progress events ────────────────────────────────────────────────
//
// High-level labels surfaced to the UI via the agent event bus. These
// intentionally hide *what* a tool is doing — the user just sees a
// friendly verb like "Reading file". Exact arguments/results stay in the
// console (via `log` above).

const START_LABEL: Record<SubagentName, string> = {
  planner: "Planning",
};

const STEP_LABEL: Record<string, string> = {
  bash: "Running command",
  read_file: "Reading file",
  write_file: "Writing file",
  edit_file: "Editing file",
  list_files: "Listing files",
  validate_files: "Validating files",
  invoke_planner: "Planning",
};

/** Push a subagent-start event so the UI can show "Planning…" etc. */
function emitStart(agent: SubagentName, depth: number) {
  emitAgentEvent({
    type: "subagent-start",
    agent,
    depth,
    label: START_LABEL[agent],
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

/** Report normalized token usage for a subagent run to the UI bus. */
function reportUsage(agent: SubagentName, usage: unknown) {
  try {
    const u = (usage ?? {}) as Record<string, number | undefined>;
    const promptTokens = u.promptTokens ?? u.inputTokens ?? 0;
    const completionTokens = u.completionTokens ?? u.outputTokens ?? 0;
    emitAgentEvent({
      type: "usage",
      role: agent as AgentRole,
      ts: Date.now(),
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: u.totalTokens ?? promptTokens + completionTokens,
      },
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
  /** Chain depth of this run (1 = spawned by main, 2 = by a depth-1 planner…). */
  depth: number;
  systemPrompt: string;
  messages: UIMessage[];
  tools: ToolSet;
}): Promise<string> {
  const cfg = getProvider(opts.settings, opts.agent);
  if (!cfg) {
    log(
      opts.agent,
      opts.depth,
      "✗ no API key for provider",
      opts.settings.agents[opts.agent].provider,
    );
    throw new Error(
      `No API key configured for the ${opts.agent} agent ` +
        `(provider "${opts.settings.agents[opts.agent].provider}").`,
    );
  }

  log(
    opts.agent,
    opts.depth,
    `▶ starting (${opts.settings.agents[opts.agent].provider}/${cfg.model})`,
  );
  emitStart(opts.agent, opts.depth);

  // Declared outside the try so the `finally` block can read its usage.
  // `streamText` runs synchronously, but the awaited message conversion
  // happens before assignment — so it may stay undefined if that throws.
  let result: ReturnType<typeof streamText> | undefined;
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
        opts.agent,
      ) as Parameters<typeof streamText>[0]["providerOptions"],
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
            LOG_STYLES[opts.agent],
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
    // Report cumulative token usage for this run, then pop the activity
    // from the UI progress feed. Done in `finally` so an error still
    // clears the spinner.
    if (result) {
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
 * Prefix prepended to every subagent's system prompt (below its file prompt).
 *
 * Framework prompts are written for the agent generally; nothing in them says
 * "you are the subagent right now". Without that, a spawned planner has been
 * observed delegating its own task back through `invoke_planner` — spawning
 * itself to do the very work it was given, burning a recursion level and
 * tokens for nothing. Stating the identity + depth explicitly in the prompt
 * makes the model do the work itself and reserve spawning for genuinely
 * separable subtasks.
 */
function withSubagentContext(
  agent: SubagentName,
  depth: number,
  systemPrompt: string,
): string {
  const caller =
    depth <= 1 ? "the main agent" : `another ${agent} subagent (depth ${depth - 1})`;
  return (
    `[Subagent context — injected by the app, not part of your file prompt]\n` +
    `You ARE the "${agent}" subagent, running at recursion depth ${depth}, spawned by ${caller} ` +
    `via a tool call. The user does not see your messages — only your final text is ` +
    `returned to the caller as that tool's result.\n` +
    `Because you are already this subagent, never invoke it on yourself: do NOT spawn ` +
    `another "${agent}" to handle the task you were given — that is your job, do it ` +
    `directly. Spawning further subagents is only for genuinely separate, decomposable ` +
    `subtasks, never for re-doing or continuing your own assignment.\n\n` +
    systemPrompt
  );
}

// ============================================================================
// Planner subagent
// ============================================================================

/**
 * Build the planner subagent's toolset.
 *
 * The planner authors scripts directly with `write_file`/`edit_file` and
 * validates them with `validate_files` (optionally scoped to a path).
 *
 * Recursion: a planner running at chain `depth` is handed `invoke_planner`
 * (which spawns a planner at `depth + 1`) only while `depth <
 * MAX_SUBAGENT_DEPTH`. The deepest allowed level simply has no spawn tool,
 * so it works directly — the recursion cap is structural, not advisory.
 */
function buildPlannerTools(settings: AgentSettings, depth: number): ToolSet {
  const tools: ToolSet = {
    bash: bashTool,
    read_file: readFileTool,
    write_file: writeFileTool,
    edit_file: editFileTool,
    list_files: listFilesTool,
    validate_files: validateFilesTool,
  };
  if (depth < MAX_SUBAGENT_DEPTH) {
    tools.invoke_planner = buildInvokePlannerTool(settings, depth + 1);
  }
  return tools;
}

/**
 * Invoke the planner subagent with a high-level task from its parent (the
 * main agent, or another planner when recursing).
 *
 * `depth` is the chain depth of the planner to run (1 = spawned by main).
 * Loads the planner prompt from disk on every invocation so the user can
 * edit it and see changes immediately.
 */
export async function invokePlanner(opts: {
  settings: AgentSettings;
  task: string;
  /** Chain depth of the planner to run (1 = spawned by the main agent). */
  depth: number;
}): Promise<string> {
  const plannerPrompt = await loadPrompt("hypno_planner.md");

  if (!plannerPrompt) {
    log("planner", opts.depth, "✗ prompts/hypno_planner.md missing or empty");
    throw new Error(
      "prompts/hypno_planner.md is empty or missing. " +
        "Add a system prompt for the planner before invoking it.",
    );
  }

  console.groupCollapsed(
    `%c${tag("planner", opts.depth)}`,
    LOG_STYLES.planner,
    `▶ invoke_planner`,
  );
  log("planner", opts.depth, "task", preview(opts.task));

  try {
    const messages: UIMessage[] = [
      {
        id: `planner-user-${Date.now()}-${opts.depth}`,
        role: "user",
        parts: [{ type: "text", text: opts.task }],
      },
    ];

    const tools = buildPlannerTools(opts.settings, opts.depth);

    const out = await runSubagent({
      settings: opts.settings,
      agent: "planner",
      depth: opts.depth,
      systemPrompt: plannerPrompt,
      messages,
      tools,
    });
    log("planner", opts.depth, "✔ planner done");
    return out;
  } catch (e) {
    log(
      "planner",
      opts.depth,
      "✗ planner failed",
      e instanceof Error ? e.message : String(e),
    );
    throw e;
  } finally {
    console.groupEnd();
  }
}

/**
 * Build the `invoke_planner` tool as exposed to a parent agent (the main
 * agent at depth 1, or a planner at deeper levels).
 *
 * `depth` is the chain depth of the planner this tool will spawn. The tool
 * takes a single `task` string and returns the planner's final answer
 * (which the parent sees as the tool result).
 */
export function buildInvokePlannerTool(settings: AgentSettings, depth: number) {
  return tool({
    description:
      "Spawn the Hypno Planner subagent to create or update TTS audio " +
      "scripts (and other scripted training content). The planner authors " +
      "the JSON metadata + XML scripts directly and validates them. The " +
      "planner may itself spawn further planners to decompose large or " +
      "multi-part tasks, up to a fixed recursion depth; beyond that it " +
      "does the work directly. Use this whenever the user asks to create, " +
      "design, plan, or update audio scripts. Provide a fully " +
      "self-contained brief — the planner does not see this chat.",
    inputSchema: z.object({
      task: z
        .string()
        .describe(
          "A self-contained brief for the planner. Include what to " +
            "create, target tags, desired tone/pacing, and any other " +
            "context the planner would need to design the scripts. " +
            "Do not assume the planner sees this chat — include all " +
            "relevant detail.",
        ),
    }),
    execute: async ({ task }) => {
      // Identify who is spawning the planner, for the console trace. depth
      // here is the SPAWNED planner's level, so the caller is the main
      // agent when depth === 1, otherwise the planner one level up.
      const callerTag =
        depth === 1 ? "main" : tag("planner", depth - 1);
      console.groupCollapsed(
        `%c[${callerTag}]`,
        depth === 1
          ? "color:#10b981;font-weight:bold"
          : LOG_STYLES.planner,
        `▶ invoke_planner tool`,
      );
      console.log("task", preview(task));
      try {
        const output = await invokePlanner({ settings, task, depth });
        console.log(
          `%c[${callerTag}]`,
          depth === 1
            ? "color:#10b981;font-weight:bold"
            : LOG_STYLES.planner,
          "✔ invoke_planner result",
          preview(output),
        );
        return { ok: true, output };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.log(
          `%c[${callerTag}]`,
          depth === 1
            ? "color:#10b981;font-weight:bold"
            : LOG_STYLES.planner,
          "✗ invoke_planner error",
          msg,
        );
        return { ok: false, error: msg };
      } finally {
        console.groupEnd();
      }
    },
  });
}
