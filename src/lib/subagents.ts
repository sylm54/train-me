/**
 * Subagent orchestration: hypno planner + writer.
 *
 * Both subagents are spawned from the frontend via separate `streamText`
 * calls. They are *not* exposed to the user — only the main agent sees
 * `invoke_planner`, and only the planner sees `invoke_writer`.
 *
 * Lifecycle:
 *
 *   Main agent
 *     └─ tool: invoke_planner(task: string)
 *          └─ streamText(planner prompt, planner tools)
 *               ├─ tool: bash / read_file / write_file / list_files
 *               └─ tool: invoke_writer(path: string, instructions: string)
 *                    └─ streamText(writer prompt, writer tools)
 *                         └─ tool: writeScript(content: string)
 *
 * The writer's text output is routed back to the planner as part of the
 * `invoke_writer` tool result. The planner's final text becomes the
 * `invoke_planner` tool result the main agent sees.
 *
 * Note on concurrency: writer invocations are strictly serial — the
 * planner awaits each `invoke_writer` call before issuing another — so we
 * can use a single module-level slot (`currentWriterPath`) to thread the
 * destination path from `invoke_writer` into the writer's `writeScript`
 * tool without relying on any closed-over context the AI SDK doesn't
 * expose publicly.
 *
 * All subagent activity is mirrored to the browser devtools console
 * (search for `[planner]` / `[writer]`). Each invocation opens a
 * collapsed console.group; expand it to see the full trace.
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
import { invoke } from "@tauri-apps/api/core";

import { loadPrompt } from "./prompts";
import { getProvider, buildProviderOptions } from "./agent";
import { bashTool, readFileTool, writeFileTool, listFilesTool } from "./tools";
import type { AgentSettings } from "./types";
import { emitAgentEvent, type AgentRole } from "./agent-events";

/** Result of the backend `write_script` Tauri command. */
interface WriteScriptResult {
  valid: boolean;
  path: string | null;
  error: string | null;
  node_count: number;
}

// ============================================================================
// Console logging helpers
// ============================================================================

type SubagentName = "planner" | "writer";

/** Distinct console-marker colours per subagent so they're easy to scan. */
const LOG_STYLES: Record<SubagentName, string> = {
  planner: "color:#d946ef;font-weight:bold", // pink-500
  writer: "color:#06b6d4;font-weight:bold", // cyan-500
};

/** Cap previews so a single tool result doesn't drown the console. */
const PREVIEW_MAX = 240;

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

/** Emit a prefixed console.log entry for the given subagent. */
function log(agent: SubagentName, message: string, ...args: unknown[]) {
  console.log(`%c[${agent}]`, LOG_STYLES[agent], message, ...args);
}

// ── UI progress events ────────────────────────────────────────────────
//
// High-level labels surfaced to the UI via the agent event bus. These
// intentionally hide *what* a tool is doing — the user just sees a
// friendly verb like "Reading file". Exact arguments/results stay in the
// console (via `log` above).

const START_LABEL: Record<SubagentName, string> = {
  planner: "Planning",
  writer: "Writing script",
};

const STEP_LABEL: Record<string, string> = {
  bash: "Running command",
  read_file: "Reading file",
  write_file: "Writing file",
  edit_file: "Editing file",
  list_files: "Listing files",
  writeScript: "Writing script",
  invoke_writer: "Writing script",
  invoke_planner: "Planning",
};

/** Push a subagent-start event so the UI can show "Planning…" etc. */
function emitStart(agent: SubagentName) {
  emitAgentEvent({
    type: "subagent-start",
    agent,
    label: START_LABEL[agent],
    ts: Date.now(),
  });
}

/** Update the current step label for a running subagent. */
function emitStep(agent: SubagentName, toolName: string, detail?: string) {
  emitAgentEvent({
    type: "subagent-step",
    agent,
    label: STEP_LABEL[toolName] ?? toolName,
    detail,
    ts: Date.now(),
  });
}

/** Pop a subagent activity when its run completes. */
function emitEnd(agent: SubagentName) {
  emitAgentEvent({ type: "subagent-end", agent, ts: Date.now() });
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
 * Slot for the destination path of the currently-running writer call.
 * Written by `invoke_writer.execute`, read by the `writeScript` tool's
 * execute(). Safe because writer runs are strictly serial.
 */
let currentWriterPath: string | null = null;

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
  systemPrompt: string;
  messages: UIMessage[];
  tools: ToolSet;
}): Promise<string> {
  const cfg = getProvider(opts.settings, opts.agent);
  if (!cfg) {
    log(
      opts.agent,
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
    `▶ starting (${opts.settings.agents[opts.agent].provider}/${cfg.model})`,
  );
  emitStart(opts.agent);

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
      system: opts.systemPrompt,
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

    for await (const part of result.fullStream) {
      switch (part.type) {
        case "text-delta":
          pendingText += part.text;
          finalText += part.text;
          break;

        case "text-end":
          if (pendingText.trim()) {
            log(opts.agent, "💬 text", preview(pendingText.trim()));
          }
          pendingText = "";
          break;

        case "reasoning-start":
          // Reasoning is intentionally NOT accumulated into finalText —
          // subagent thinking must not leak into tool results returned to
          // the parent agent. We just open a console group for it so it
          // can be inspected during debugging.
          if (pendingText.trim()) {
            log(opts.agent, "💬 text", preview(pendingText.trim()));
            pendingText = "";
          }
          console.groupCollapsed(
            `%c[${opts.agent}]`,
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
            log(opts.agent, "💬 text", preview(pendingText.trim()));
            pendingText = "";
          }
          // Discard any text accumulated so far — it was inter-step
          // "thinking" emitted before this tool call, not the final
          // answer. The caller only wants the text from the LAST
          // assistant message (after the final tool call returns).
          finalText = "";
          const dynamic = "dynamic" in part && part.dynamic ? " (dynamic)" : "";
          log(opts.agent, `🔧 tool call: ${part.toolName}${dynamic}`);
          // Surface a friendly step label (no args) to the UI progress feed.
          emitStep(opts.agent, part.toolName);
          break;
        }

        case "tool-input-end":
          // Tool input parsing complete; we don't log the args here because
          // the SDK emits them as separate deltas and we'd just see JSON.
          break;

        case "tool-result": {
          // The `output` field is the JSON the tool's execute() returned.
          const outputPreview = preview("output" in part ? part.output : part);
          log(opts.agent, `↳ ${part.toolName} result`, outputPreview);
          break;
        }

        case "tool-error": {
          const msg =
            "errorText" in part && typeof part.errorText === "string"
              ? part.errorText
              : "unknown tool error";
          log(opts.agent, `✗ ${part.toolName} error`, msg);
          break;
        }

        case "error": {
          const msg =
            "error" in part && part.error instanceof Error
              ? part.error.message
              : String(part);
          log(opts.agent, "✗ stream error", msg);
          break;
        }

        case "finish": {
          if (pendingText.trim()) {
            log(opts.agent, "💬 text", preview(pendingText.trim()));
            pendingText = "";
          }
          log(
            opts.agent,
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
    emitEnd(opts.agent);
  }
}

// ============================================================================
// Writer subagent
// ============================================================================

/** Build the writer subagent's toolset (just `writeScript`). */
function buildWriterTools() {
  return {
    writeScript: tool({
      description:
        "Validate and save TTS markup. " +
        "Returns {valid, path, error, node_count}. If valid=false, fix the " +
        "markup based on `error` and call again.",
      inputSchema: z.object({
        content: z
          .string()
          .describe(
            "The full TTS markup document (XML-like tags + text). " +
              "Will be parsed by the backend before saving.",
          ),
      }),
      execute: async ({ content }) => {
        if (currentWriterPath == null) {
          return {
            valid: false,
            error:
              "No destination path associated with this writer invocation. " +
              "Internal error: invoke_writer did not set currentWriterPath.",
            path: null,
            node_count: 0,
          } satisfies WriteScriptResult;
        }
        log(
          "writer",
          `↗ writeScript → ${currentWriterPath}`,
          `(${content.length} chars)`,
        );
        try {
          const result = await invoke<WriteScriptResult>("write_script", {
            path: currentWriterPath,
            content,
          });
          log(
            "writer",
            result.valid
              ? `✓ writeScript ok (${result.node_count} nodes)`
              : `✗ writeScript invalid`,
            result.error ?? "",
          );
          return result;
        } catch (e) {
          log("writer", `✗ writeScript exception`, String(e));
          return {
            valid: false,
            error: String(e),
            path: null,
            node_count: 0,
          } satisfies WriteScriptResult;
        }
      },
    }),
  };
}

/**
 * Run the writer subagent. Returns the writer's final text (which becomes
 * part of the `invoke_writer` tool result the planner sees).
 */
async function runWriter(opts: {
  settings: AgentSettings;
  systemPrompt: string;
  path: string;
  instructions: string;
}): Promise<string> {
  const previous = currentWriterPath;
  currentWriterPath = opts.path;

  console.groupCollapsed(
    `%c[writer]`,
    LOG_STYLES.writer,
    `▶ invoke_writer → ${opts.path}`,
  );
  log("writer", `task: ${opts.path}`);
  log("writer", "instructions", preview(opts.instructions));

  try {
    const messages: UIMessage[] = [
      {
        id: `writer-user-${Math.random().toString(36).slice(2)}`,
        role: "user",
        parts: [
          {
            type: "text",
            text:
              `Write the script to \`${opts.path}\`.\n\n` +
              `Instructions from the planner:\n${opts.instructions}`,
          },
        ],
      },
    ];

    const out = await runSubagent({
      settings: opts.settings,
      agent: "writer",
      systemPrompt: opts.systemPrompt,
      messages,
      tools: buildWriterTools(),
    });
    log("writer", "✔ writer done");
    return out;
  } catch (e) {
    log(
      "writer",
      "✗ writer failed",
      e instanceof Error ? e.message : String(e),
    );
    throw e;
  } finally {
    console.groupEnd();
    currentWriterPath = previous;
  }
}

// ============================================================================
// Planner subagent
// ============================================================================

/** Build the planner subagent's toolset. */
function buildPlannerTools(settings: AgentSettings, writerPrompt: string) {
  return {
    bash: bashTool,
    read_file: readFileTool,
    write_file: writeFileTool,
    list_files: listFilesTool,
    invoke_writer: tool({
      description:
        "Spawn the Hypno Writer subagent to produce a single TTS XML " +
        "script at the given path. Pass detailed instructions: pacing, " +
        "voice(s), tone, sound effects, loops, intended emotional state. " +
        "Returns {ok, path, output?, error?} where `output` is the " +
        "writer's final text (typically a one-line confirmation, or an " +
        "error message).",
      inputSchema: z.object({
        path: z
          .string()
          .describe(
            "Destination path relative to the agent's writable area " +
              "(POSIX-style, no leading slash). e.g. " +
              "'conditioning/my_script.xml'.",
          ),
        instructions: z
          .string()
          .describe(
            "Detailed brief for the writer. Include pacing, voices, " +
              "tone, sound effects, loops, and the intended emotional " +
              "state. The writer has no other context.",
          ),
      }),
      execute: async ({ path, instructions }) => {
        log("planner", `↘ invoke_writer → ${path}`, preview(instructions));
        try {
          const output = await runWriter({
            settings,
            systemPrompt: writerPrompt,
            path,
            instructions,
          });
          log("planner", `↖ invoke_writer done ← ${path}`, preview(output));
          return { ok: true, path, output };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          log("planner", `✗ invoke_writer failed`, msg);
          return { ok: false, path, error: msg };
        }
      },
    }),
  };
}

/**
 * Invoke the planner subagent with a high-level task from the main agent.
 *
 * Loads the planner + writer prompts from disk on every invocation so the
 * user can edit them and see changes immediately.
 */
export async function invokePlanner(opts: {
  settings: AgentSettings;
  task: string;
}): Promise<string> {
  const [plannerPrompt, writerPrompt] = await Promise.all([
    loadPrompt("hypno_planner.md"),
    loadPrompt("hypno_writer.md"),
  ]);

  if (!plannerPrompt) {
    log("planner", "✗ prompts/hypno_planner.md missing or empty");
    throw new Error(
      "prompts/hypno_planner.md is empty or missing. " +
        "Add a system prompt for the planner before invoking it.",
    );
  }

  console.groupCollapsed(`%c[planner]`, LOG_STYLES.planner, `▶ invoke_planner`);
  log("planner", "task", preview(opts.task));

  try {
    const messages: UIMessage[] = [
      {
        id: `planner-user-${Date.now()}`,
        role: "user",
        parts: [{ type: "text", text: opts.task }],
      },
    ];

    const tools = buildPlannerTools(opts.settings, writerPrompt);

    const out = await runSubagent({
      settings: opts.settings,
      agent: "planner",
      systemPrompt: plannerPrompt,
      messages,
      tools,
    });
    log("planner", "✔ planner done");
    return out;
  } catch (e) {
    log(
      "planner",
      "✗ planner failed",
      e instanceof Error ? e.message : String(e),
    );
    throw e;
  } finally {
    console.groupEnd();
  }
}

/**
 * Build the `invoke_planner` tool as exposed to the main agent.
 *
 * The tool takes a single `task` string and returns the planner's final
 * answer (which the main agent sees as the tool result).
 */
export function buildInvokePlannerTool(settings: AgentSettings) {
  return tool({
    description:
      "Spawn the Hypno Planner subagent to create one or more new " +
      "conditioning scripts (or other scripted training content). The " +
      "planner will write JSON metadata, delegate the XML writing to " +
      "Use this whenever the user asks to *create*, *design*, or *plan* new scripts or update existing ones.",
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
      console.groupCollapsed(
        `%c[main]`,
        "color:#10b981;font-weight:bold",
        `▶ invoke_planner tool`,
      );
      console.log("task", preview(task));
      try {
        const output = await invokePlanner({ settings, task });
        console.log(
          "%c[main]",
          "color:#10b981;font-weight:bold",
          "✔ invoke_planner result",
          preview(output),
        );
        return { ok: true, output };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.log(
          "%c[main]",
          "color:#10b981;font-weight:bold",
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
