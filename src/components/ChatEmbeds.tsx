/**
 * Clickable audio/task embeds inside chat messages.
 *
 * The agent embeds sandbox content with plain markdown image syntax (the
 * same formulation as images — the alt text doubles as the card label):
 *
 *   ![Deepening](hypnos/deepening.xml)   → playable audio-script card
 *   ![task](tasks/dishes.js)             → task card (Start = Today's Start)
 *
 * `MessageResponse` (Streamdown) renders assistant text. Embeds need two
 * hooks into it:
 *
 *  1. `components` — the exported {@link chatEmbedComponents} renders the
 *     `chat-embed` element (and any plain `img` as fallback) as a card.
 *  2. `rehypePlugins` — the exported {@link chatEmbedRehypePlugins} replaces
 *     Streamdown's internal rehype chain with a mirror of it plus one extra
 *     step: Streamdown runs `rehype-harden` over every image, and harden's
 *     URL policy has no notion of sandbox-relative paths — a bare
 *     `![alt](hypnos/deepening.xml)` parses as neither absolute nor
 *     `./`-relative, so harden replaces the image with a literal
 *     "[Image blocked: alt]" span before any `components` override runs.
 *     Our extractor therefore renames embed-eligible images to a
 *     `chat-embed` element BEFORE harden runs; harden (which only inspects
 *     `img` and `a`) leaves it alone and the card component picks it up.
 *     The rest of the chain mirrors Streamdown 2.5's internals
 *     (raw → sanitize → harden with its exact default config) so ordinary
 *     markdown keeps its existing behaviour.
 *
 * Detection is by file extension for audio (`.xml`) and by extension or the
 * literal `task` alt marker for tasks; anything unrecognised stays a plain
 * (hardened) `<img>`.
 *
 * Audio cards resolve through the same pipeline as the Today view:
 * `manifest_status` tells rendered/stale, a Render button runs
 * `render_manifest` through the app-wide render registry (so the floating
 * progress pill mirrors it), and Play opens the full-screen
 * `AudioPlayerOverlay` (which handles the voice-engine gate). Task cards
 * resolve via `v2_resolve_task_instance`: Start opens an existing assigned
 * instance, or first assigns one from the template — then hands a session
 * request to the app exactly as if the task had been started on Today.
 */

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { AudioLines, ClipboardList, Loader2, Play, RefreshCw } from "lucide-react";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { harden } from "rehype-harden";
import { visit } from "unist-util-visit";
import type { PluggableList } from "unified";
import type { Element, Root } from "hast";

import { Button } from "@/components/ui/button";
import {
  clear,
  displayPct,
  ensureGlobalListener,
  estimateRemainingMs,
  formatClock,
  isAutoCreated,
  markDone,
  markError,
  markStart,
  useRenderStore,
  useRenderTick,
} from "@/lib/renderRegistry";
import { resolveTaskInstance, type TaskInstanceRef } from "@/lib/v2";

// ── Embed resolution ───────────────────────────────────────────────────────

type Embed =
  | { kind: "audio"; src: string; title: string | null }
  | { kind: "task"; template: string; title: string | null };

/**
 * Alt texts that mark the embed kind rather than label it. A label the
 * agent actually wrote ("Deepening trance") always wins as the title.
 */
const MARKER_ALTS = new Set(["audio", "script", "tts", "task"]);

/** Resolve an `![alt](href)` into an embed, or null for a plain image. */
function resolveEmbed(href: string, alt: string): Embed | null {
  let h = href.trim();
  // The backend resolves embed paths relative to the agent sandbox root, so
  // tolerate `./` and a single leading `/` (but never `//`, a protocol-relative URL).
  if (h.startsWith("./")) h = h.slice(2);
  else if (h.startsWith("/") && !h.startsWith("//")) h = h.slice(1);
  // Split off a fragment/query defensively — sandbox paths carry neither.
  const cut = h.search(/[?#]/);
  if (cut !== -1) h = h.slice(0, cut);
  if (!h || /^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith("//")) return null;

  const label = alt.trim();
  const title = MARKER_ALTS.has(label.toLowerCase()) ? null : label || null;
  if (/\.xml$/i.test(h)) return { kind: "audio", src: h, title };
  if (/\.js$/i.test(h) || label.toLowerCase() === "task") {
    return { kind: "task", template: h, title };
  }
  return null;
}

/** Prettify a path's file stem into a fallback card title. */
function stemTitle(path: string): string {
  const file = path.split(/[\\/]/).pop() ?? path;
  const stem = file.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim();
  return stem ? stem[0].toUpperCase() + stem.slice(1) : path;
}

// ── Context: the chat supplies the actions ──────────────────────────────────

interface EmbedActions {
  /** Open the full-screen audio player for a sandbox-relative script. */
  playAudio: (src: string) => void;
  /** Resolve-or-assign the task instance, then open its session. */
  startTask: (template: string) => Promise<void>;
}

const EmbedActionsContext = createContext<EmbedActions | null>(null);

export function EmbedActionsProvider({
  value,
  children,
}: {
  value: EmbedActions;
  children: ReactNode;
}) {
  return (
    <EmbedActionsContext.Provider value={value}>
      {children}
    </EmbedActionsContext.Provider>
  );
}

function useEmbedActions(): EmbedActions {
  const ctx = useContext(EmbedActionsContext);
  if (!ctx) {
    // Cards only render inside the chat; a missing provider is a wiring
    // bug — degrade to inert buttons rather than crash the message list.
    return { playAudio: () => undefined, startTask: () => Promise.resolve() };
  }
  return ctx;
}

// ── Streamdown img override ────────────────────────────────────────────────

/** Tag the extractor renames embed images to (see the header comment). */
const EMBED_TAG = "chat-embed";

/**
 * Module-scope so its identity is stable — `MessageResponse` is memoized
 * and `useChat` re-renders on every stream chunk.
 */
export const chatEmbedComponents = {
  img: EmbedImg,
  [EMBED_TAG]: EmbedImg,
};

/**
 * Rehype plugin that lifts embed images out of rehype-harden's way by
 * renaming them to {@link EMBED_TAG} before harden runs. The predicate is
 * `resolveEmbed` itself, so exactly the images the cards would render get
 * extracted and everything else keeps the default hardened-img treatment.
 */
function rehypeExtractEmbeds() {
  return (tree: Root) => {
    visit(tree, "element", (node: Element) => {
      if (node.tagName !== "img") return;
      const src = String(node.properties.src ?? "");
      const alt = String(node.properties.alt ?? "");
      if (resolveEmbed(src, alt)) node.tagName = EMBED_TAG;
    });
  };
}

/**
 * Replacement for Streamdown's internal rehype chain — its exact 2.5 chain
 * (raw → sanitize → harden, with harden's default config) plus the embed
 * extractor between sanitize and harden. Streamdown's `rehypePlugins` prop
 * REPLACES its defaults rather than appending, so the mirror must be kept
 * faithful: if a future Streamdown changes its sanitize schema or harden
 * config, this needs the same update.
 */
export const chatEmbedRehypePlugins: PluggableList = [
  rehypeRaw,
  [
    rehypeSanitize,
    {
      ...defaultSchema,
      protocols: {
        ...defaultSchema.protocols,
        href: [...(defaultSchema.protocols?.href ?? []), "tel"],
      },
      attributes: {
        ...defaultSchema.attributes,
        code: [...(defaultSchema.attributes?.code ?? []), "metastring"],
      },
    },
  ],
  rehypeExtractEmbeds,
  [
    harden,
    {
      allowedImagePrefixes: ["*"],
      allowedLinkPrefixes: ["*"],
      allowedProtocols: ["*"],
      allowDataImages: true,
    },
  ],
];

/** The `img`/`chat-embed` element override the markdown renderer calls. */
function EmbedImg({
  node: _node,
  alt = "",
  src = "",
  ...rest
}: ComponentProps<"img"> & { node?: unknown }) {
  const embed = resolveEmbed(String(src), String(alt));
  if (!embed) return <img alt={alt} src={src} {...rest} />;
  const title =
    embed.title ?? stemTitle(embed.kind === "audio" ? embed.src : embed.template);
  return embed.kind === "audio" ? (
    <AudioEmbedCard src={embed.src} title={title} />
  ) : (
    <TaskEmbedCard template={embed.template} title={title} />
  );
}

// ── Shared card chrome ──────────────────────────────────────────────────────

/**
 * Card shell. Everything is a span — the markdown image renders inside a
 * `<p>`, and block elements in phrasing context trip React's DOM-nesting
 * validation (and real HTML parsers would close the paragraph).
 */
function EmbedCardShell({
  icon,
  title,
  subtitle,
  subtitleClass,
  body,
  action,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  subtitleClass?: string;
  body?: ReactNode;
  action: ReactNode;
}) {
  return (
    <span className="my-2 flex w-full max-w-md items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 shadow-sm">
      <span className="grid size-9 shrink-0 place-items-center rounded-md bg-[var(--color-pink-100)] text-[var(--color-pink-700)]">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-[var(--color-foreground)]">
          {title}
        </span>
        <span
          className={`block truncate text-[11px] text-[var(--color-muted-foreground)] ${subtitleClass ?? ""}`}
        >
          {subtitle}
        </span>
        {body}
      </span>
      <span className="shrink-0">{action}</span>
    </span>
  );
}

// ── Audio script card ───────────────────────────────────────────────────────

interface ManifestStatus {
  rendered: boolean;
  stale: boolean;
  duration: number | null;
}

/** How long a finished render stays visible before the entry is dropped. */
const RENDER_DONE_LINGER_MS = 2500;

export function AudioEmbedCard({ src, title }: { src: string; title: string }) {
  const { playAudio } = useEmbedActions();
  const [manifest, setManifest] = useState<ManifestStatus | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);

  // App-wide render state for this script — also fed by background
  // prerender passes, so the card shows progress it didn't start.
  const renderEntry = useRenderStore().get(src) ?? null;
  const rendering = renderEntry?.status === "rendering";
  const now = useRenderTick(rendering);

  // Render/refresh the rendered-state snapshot. Skipped while a render is
  // in flight (the terminal transition re-runs this).
  useEffect(() => {
    if (rendering) return;
    let cancelled = false;
    setCheckError(null);
    invoke<ManifestStatus>("manifest_status", { scriptPath: src })
      .then((s) => {
        if (!cancelled) setManifest(s);
      })
      .catch((e) => {
        if (!cancelled) setCheckError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [src, rendering]);

  // Kick off a render. Tracked in the global registry like every render,
  // so the floating progress pill mirrors it app-wide.
  const startRender = () => {
    ensureGlobalListener();
    markStart(src);
    void invoke("render_manifest", { scriptPath: src })
      .then(() => markDone(src))
      .catch((e) => markError(src, String(e)));
  };

  // Consume our own terminal entry after a beat (background ones are the
  // render pill's business) so no done/error entry lingers in the registry.
  useEffect(() => {
    const status = renderEntry?.status;
    if (!status || status === "rendering" || isAutoCreated(src)) return;
    const t = window.setTimeout(() => clear(src), RENDER_DONE_LINGER_MS);
    return () => window.clearTimeout(t);
  }, [renderEntry?.status, src]);

  const failed = renderEntry?.status === "error";
  const playable = manifest !== null && manifest.rendered && !manifest.stale;
  const etaMs = rendering && renderEntry ? estimateRemainingMs(renderEntry, now) : null;

  const subtitle = rendering
    ? renderEntry && renderEntry.total > 0
      ? `rendering ${displayPct(renderEntry)}%${
          etaMs != null ? ` · ~${formatClock(etaMs)} left` : ""
        }`
      : "rendering…"
    : playable
      ? manifest.duration != null
        ? `ready · ${formatClock(manifest.duration * 1000)}`
        : "ready"
      : manifest === null && !checkError
        ? src
        : manifest?.stale
          ? "stale — re-render"
          : "not rendered yet";

  const action = playable ? (
    <Button
      size="sm"
      onClick={() => playAudio(src)}
      aria-label={`Play ${title}`}
      title="Play"
    >
      <Play className="size-3.5" /> Play
    </Button>
  ) : (
    <Button
      size="sm"
      variant="outline"
      disabled={rendering}
      onClick={startRender}
      aria-label={`Render ${title}`}
      title={manifest?.stale ? "Re-render audio" : "Render audio"}
    >
      {rendering ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : (
        <RefreshCw className="size-3.5" />
      )}
      Render
    </Button>
  );

  return (
    <EmbedCardShell
      icon={<AudioLines className="size-4" />}
      title={title}
      subtitle={subtitle}
      subtitleClass={failed ? "text-[var(--color-danger)]" : undefined}
      action={action}
      body={
        <>
          {/* Progress bar while rendering (indeterminate until the walker
              seeds a total, mirroring the full-screen player). */}
          {rendering && (
            <span className="mt-1.5 block h-1 w-full overflow-hidden rounded-full bg-[var(--color-border)]">
              {renderEntry && renderEntry.total > 0 ? (
                <span
                  className="block h-full rounded-full bg-[var(--color-pink-500)] transition-all duration-200 ease-out"
                  style={{ width: `${displayPct(renderEntry)}%` }}
                />
              ) : (
                <span className="block h-full w-1/3 rounded-full bg-[var(--color-pink-500)] animate-[render-indeterminate_1.1s_ease-in-out_infinite]" />
              )}
            </span>
          )}
          {failed && renderEntry?.error && (
            <span className="mt-1 block break-words text-[11px] text-[var(--color-danger)] line-clamp-2">
              {renderEntry.error}
            </span>
          )}
          {checkError && (
            <span className="mt-1 block break-words text-[11px] text-[var(--color-danger)]">
              {checkError}
            </span>
          )}
        </>
      }
    />
  );
}

// ── Task card ───────────────────────────────────────────────────────────────

export function TaskEmbedCard({ template, title }: { template: string; title: string }) {
  const { startTask } = useEmbedActions();
  // Real title (front matter) + whether an instance is already open.
  const [info, setInfo] = useState<TaskInstanceRef | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    resolveTaskInstance(template, false)
      .then((r) => {
        if (!cancelled) setInfo(r);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [template]);

  const start = () => {
    setStarting(true);
    setError(null);
    startTask(template)
      .catch((e) => setError(String(e)))
      .finally(() => setStarting(false));
  };

  const subtitle = error
    ? "couldn't load this task"
    : info?.iid
      ? "assigned — ready to run"
      : "not assigned yet";

  return (
    <EmbedCardShell
      icon={<ClipboardList className="size-4" />}
      title={info?.title ?? title}
      subtitle={subtitle}
      subtitleClass={error ? "text-[var(--color-danger)]" : undefined}
      action={
        <Button
          size="sm"
          disabled={starting || !!error}
          onClick={start}
          aria-label={`Start ${title}`}
          title="Start task"
        >
          {starting ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Play className="size-3.5" />
          )}
          Start
        </Button>
      }
    />
  );
}
