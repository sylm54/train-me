/**
 * TTS XML script validator — TypeScript port of the essential checks from
 * train-me's canonical Rust parser (`src-tauri/src/tag_parser.rs`). The app's
 * `validate_files` remains authoritative; this port exists so framework CI
 * can catch the same classes of errors before packaging. Keep in sync when
 * the tag grammar changes.
 */

import type { Diag } from "./validate";
import { parseCondition } from "./cond";

// ── AST (only what semantic validation needs) ─────────────────────────────

interface Part {
  label?: string;
  role?: string;
  children: Node[];
}

export type Node =
  | { kind: "text" }
  | { kind: "voice"; speaker: string; children: Node[] }
  | { kind: "speed" | "volume" | "loop" | "background" | "until" | "section"
    | "beatmeterContainer"; children: Node[] }
  | { kind: "until"; waitingSound?: string; children: Node[] }
  | { kind: "beatmeter"; bpm: number; pattern?: string; sound?: string; children: Node[] }
  | { kind: "sound"; soundType: string }
  | { kind: "tone"; preset: string }
  | { kind: "effect"; effectType: string; preset?: string; children: Node[] }
  | { kind: "overlay" | "random" | "scramble" | "choice"; parts: Part[] }
  | { kind: "react"; parts: Part[] }
  | { kind: "rating"; min: number; max: number }
  | { kind: "if"; cond: string; children: Node[] }
  | { kind: "visual"; source: string; everyMin: number; everyMax: number; count: number;
    captions: string; effects: string[]; children: Node[] }
  | { kind: "include"; src: string };

// ── known values (mirror tag_parser.rs) ────────────────────────────────────

const VALID_SOUND_TYPES = [
  "beep", "pop", "bubble_pop", "camera_shutter", "censor_beep",
  "heart_beat", "padlock", "snap", "ding", "swoosh", "click",
  "error", "success", "bell", "water_drop",
];

const VALID_TONE_PRESETS = [
  "sine", "square", "sawtooth", "triangle", "whitenoise",
  "pinknoise", "brownnoise",
  "binaural_theta", "binaural_alpha", "binaural_beta", "binaural_delta",
];

const VALID_EFFECT_TYPES = ["echo", "reverb", "filter"];
const VALID_REVERB_PRESETS = ["medium", "small_room", "large_hall", "cathedral", "plate"];
const VALID_ECHO_PRESETS = ["light", "medium", "heavy"];
const VALID_SPEAKERS = [
  "male", "male2", "male3", "male4", "male5",
  "female", "female2", "female3", "female4", "female5",
];

// <visual> known values (mirror tag_parser.rs / visual.rs).
const VALID_VISUAL_SOURCES = ["redgifs"];
const VALID_VISUAL_EFFECTS = [
  "cut", "zoom", "pulse", "flash", "shake", "grayscale", "sepia", "contrast",
  "blur", "vignette", "scanlines",
];
const VALID_CAPTION_MODES = ["off", "meta"];
const DEFAULT_EVERY_MIN = 5;
const DEFAULT_EVERY_MAX = 9;
const DEFAULT_VISUAL_COUNT = 16;

// ── glob <include> helpers (mirror tag_parser.rs) ─────────────────────────

/** True when an `<include src>` is a glob pattern (contains `*` or `?`). */
export function includeSrcIsGlob(src: string): boolean {
  return src.includes("*") || src.includes("?");
}

/** Case-insensitive wildcard match: `*` = any run, `?` = one character. */
export function wildcardMatch(pattern: string, name: string): boolean {
  const p = pattern.toLowerCase();
  const n = name.toLowerCase();
  let pi = 0;
  let ni = 0;
  let star = -1;
  let mark = 0;
  while (ni < n.length) {
    if (pi < p.length && (p[pi] === "?" || p[pi] === n[ni])) {
      pi++;
      ni++;
    } else if (pi < p.length && p[pi] === "*") {
      star = pi;
      mark = ni;
      pi++;
    } else if (star !== -1) {
      pi = star + 1;
      mark++;
      ni = mark;
    } else {
      return false;
    }
  }
  while (pi < p.length && p[pi] === "*") pi++;
  return pi === p.length;
}

// Container tags that require children and a matching closing tag.
// `<else>` is deliberately absent — it is only consumed inside `<if>`; a
// stray `<else>` elsewhere is an unknown-tag error (mirrors tag_parser.rs).
const CONTAINER_TAGS = new Set([
  "voice", "speed", "volume", "effect", "overlay", "loop", "background",
  "until", "random", "scramble", "choice", "react", "beatmeter",
  "intro", "main", "outro", "if", "visual",
]);

// ── parser ─────────────────────────────────────────────────────────────────

class ParseError extends Error {
  constructor(message: string, public pos: number) {
    super(message);
  }
}

class Parser {
  private pos = 0;

  constructor(private input: string) {}

  private peekStr(s: string): boolean {
    return this.input.startsWith(s, this.pos);
  }

  private expectStr(s: string): void {
    if (!this.peekStr(s)) {
      const context = this.input.slice(this.pos, this.pos + 30);
      throw new ParseError(
        `expected '${s}' but found '${context}...'`,
        this.pos,
      );
    }
    this.pos += s.length;
  }

  private skipWs(): void {
    while (this.pos < this.input.length && /\s/.test(this.input[this.pos]!)) this.pos++;
  }

  private readName(what: string): string {
    const start = this.pos;
    while (this.pos < this.input.length && /[A-Za-z0-9_-]/.test(this.input[this.pos]!)) {
      this.pos++;
    }
    const name = this.input.slice(start, this.pos);
    if (!name) {
      const context = this.input.slice(this.pos, this.pos + 30);
      throw new ParseError(`expected ${what} near '${context}...'`, this.pos);
    }
    return name;
  }

  private readAttributes(): Map<string, string> {
    const attrs = new Map<string, string>();
    for (;;) {
      this.skipWs();
      if (this.pos >= this.input.length || this.peekStr(">") || this.peekStr("/>")) break;
      let key: string;
      try {
        key = this.readName("attribute name");
      } catch {
        break;
      }
      this.skipWs();
      if (this.peekStr("=")) {
        this.pos++;
        this.skipWs();
        attrs.set(key, this.readAttrValue());
      } else {
        attrs.set(key, "true");
      }
    }
    return attrs;
  }

  private readAttrValue(): string {
    const q = this.input[this.pos];
    if (q === '"' || q === "'") {
      this.pos++;
      const end = this.input.indexOf(q, this.pos);
      const value = end === -1 ? this.input.slice(this.pos) : this.input.slice(this.pos, end);
      this.pos = end === -1 ? this.input.length : end + 1;
      return value;
    }
    const start = this.pos;
    while (this.pos < this.input.length && !/[\s>/]/.test(this.input[this.pos]!)) this.pos++;
    return this.input.slice(start, this.pos);
  }

  private skipComment(): void {
    this.expectStr("<!--");
    const end = this.input.indexOf("-->", this.pos + 2);
    if (end === -1) throw new ParseError("unterminated comment", this.pos);
    this.pos = end + 3;
  }

  private expectClosing(tag: string): void {
    this.skipWs();
    this.expectStr("</");
    this.skipWs();
    const found = this.readName("closing tag name");
    if (found !== tag) {
      throw new ParseError(`expected closing tag </${tag}> but found </${found}>`, this.pos);
    }
    this.skipWs();
    this.expectStr(">");
  }

  private parseNodes(): Node[] {
    const nodes: Node[] = [];
    while (this.pos < this.input.length) {
      if (this.peekStr("</")) break;
      if (this.peekStr("<!--")) {
        this.skipComment();
        continue;
      }
      if (this.peekStr("<")) {
        nodes.push(this.parseTag());
      } else {
        const start = this.pos;
        const lt = this.input.indexOf("<", this.pos);
        this.pos = lt === -1 ? this.input.length : lt;
        const text = this.input.slice(start, this.pos);
        if (text.trim()) nodes.push({ kind: "text" });
      }
    }
    return nodes;
  }

  /** Parse the children of a container tag, then its closing tag. */
  private parseChildren(tag: string): Node[] {
    this.skipWs();
    this.expectStr(">");
    const children = this.parseNodes();
    this.expectClosing(tag);
    return children;
  }

  /** Collect <part> children (wrapping stray tags/text in implicit parts). */
  private parsePartsContainer(closing: string): Part[] {
    const parts: Part[] = [];
    while (this.pos < this.input.length) {
      this.skipWs();
      if (this.peekStr(`</${closing}`)) break;
      if (this.peekStr("<part")) {
        parts.push(this.parsePart());
      } else if (this.peekStr("<")) {
        parts.push({ children: [this.parseTag()] });
      } else {
        // Text is wrapped in an implicit part; consume text only (up to
        // the next '<') so a following <part> stays at this loop level.
        const start = this.pos;
        const lt = this.input.indexOf("<", this.pos);
        this.pos = lt === -1 ? this.input.length : lt;
        const text = this.input.slice(start, this.pos);
        if (text.trim()) parts.push({ children: [{ kind: "text" }] });
      }
    }
    this.expectClosing(closing);
    return parts;
  }

  private parsePart(): Part {
    this.expectStr("<part");
    const attrs = this.readAttributes();
    this.skipWs();
    this.expectStr(">");
    const children = this.parseNodes();
    this.expectClosing("part");
    return {
      label: attrs.get("label"),
      role: attrs.get("role"),
      children,
    };
  }

  private parseTag(): Node {
    this.expectStr("<");
    this.skipWs();
    const tag = this.readName("tag name");

    if (!CONTAINER_TAGS.has(tag) && !["pause", "sound", "tone", "include", "rating"].includes(tag)) {
      throw new ParseError(`unknown tag <${tag}>`, this.pos);
    }

    const attrs = this.readAttributes();
    const num = (k: string): number | undefined => {
      const v = attrs.get(k);
      if (v === undefined) return undefined;
      const n = parseFloat(v);
      return Number.isFinite(n) ? n : undefined;
    };
    this.skipWs();

    // Self-closing forms.
    if (this.peekStr("/>")) {
      this.pos += 2;
      switch (tag) {
        case "pause":
        case "sound":
        case "tone":
        case "include":
        case "rating":
          break;
        default:
          throw new ParseError(`<${tag}> tag must have children`, this.pos);
      }
      switch (tag) {
        case "sound": return { kind: "sound", soundType: attrs.get("type") ?? "beep" };
        case "tone": return { kind: "tone", preset: attrs.get("preset") ?? "sine" };
        case "include": {
          const src = attrs.get("src");
          if (!src) throw new ParseError(`<include> tag requires a 'src' attribute`, this.pos);
          return { kind: "include", src };
        }
        case "rating":
          return { kind: "rating", min: num("min") ?? 1, max: num("max") ?? 5 };
        default:
          return { kind: "text" }; // <pause/> — nothing to validate
      }
    }

    switch (tag) {
      case "voice": {
        const children = this.parseChildren("voice");
        return { kind: "voice", speaker: attrs.get("speaker") ?? "male", children };
      }
      case "speed":
      case "volume":
      case "loop":
      case "background":
        return { kind: tag, children: this.parseChildren(tag) };
      case "until": {
        const waitingSound = attrs.get("waiting-sound");
        const children = this.parseChildren("until");
        return { kind: "until", waitingSound, children };
      }
      case "intro":
      case "main":
      case "outro":
        return { kind: "section", children: this.parseChildren(tag) };
      case "effect": {
        const children = this.parseChildren("effect");
        return { kind: "effect", effectType: attrs.get("type") ?? "echo", preset: attrs.get("preset"), children };
      }
      case "beatmeter": {
        const children = this.parseChildren("beatmeter");
        return {
          kind: "beatmeter",
          bpm: num("bpm") ?? 120,
          pattern: attrs.get("pattern"),
          sound: attrs.get("sound"),
          children,
        };
      }
      case "overlay":
      case "random":
      case "scramble":
      case "choice": {
        this.skipWs();
        this.expectStr(">");
        const parts = this.parsePartsContainer(tag);
        return { kind: tag, parts };
      }
      case "react": {
        this.skipWs();
        this.expectStr(">");
        const parts = this.parsePartsContainer("react");
        return { kind: "react", parts };
      }
      case "if": {
        const cond = attrs.get("cond");
        if (!cond || !cond.trim()) {
          throw new ParseError(`<if> tag requires a cond attribute`, this.pos);
        }
        this.skipWs();
        this.expectStr(">");
        const children = this.parseIfChildren();
        return { kind: "if", cond, children };
      }
      case "visual":
        // `attrs` was already consumed by parseTag — pass it down (a second
        // readAttributes() here would return an empty map).
        return this.parseVisual(attrs, num);
      default:
        // pause/sound/tone/include/rating reached here = not self-closing.
        throw new ParseError(`<${tag}> must be self-closing (ends with '/>')`, this.pos);
    }
  }

  /**
   * Parse `<visual>` — slideshow attributes (`every` scalar or `min..max`,
   * or `bpm` folding to 60/bpm) plus a custom child loop that consumes
   * `<caption>` elements (authored caption lines; not spoken, not validated
   * beyond their container role). `<caption>` outside `<visual>` stays an
   * unknown-tag error, mirroring the Rust parser.
   */
  private parseVisual(
    attrs: Map<string, string>,
    num: (k: string) => number | undefined,
  ): Node {
    const source = attrs.get("source") ?? "redgifs";
    const list = (k: string): string[] =>
      (attrs.get(k) ?? "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s !== "");

    let everyMin: number;
    let everyMax: number;
    const bpm = num("bpm");
    const everyRaw = attrs.get("every");
    if (everyRaw !== undefined && bpm !== undefined) {
      throw new ParseError(
        `<visual> accepts either every="…" or bpm="…", not both`,
        this.pos,
      );
    } else if (everyRaw !== undefined) {
      const t = everyRaw.trim();
      if (t.includes("..")) {
        const [lo, hi] = t.split("..", 2);
        everyMin = parseFloat(lo!);
        everyMax = parseFloat(hi!);
        if (!Number.isFinite(everyMin) || !Number.isFinite(everyMax)) {
          throw new ParseError(`<visual every="${everyRaw}"> is not a number range`, this.pos);
        }
      } else {
        everyMin = parseFloat(t);
        everyMax = everyMin;
        if (!Number.isFinite(everyMin)) {
          throw new ParseError(`<visual every="${everyRaw}"> is not a number`, this.pos);
        }
      }
    } else if (bpm !== undefined) {
      everyMin = 60 / bpm;
      everyMax = everyMin;
    } else {
      everyMin = DEFAULT_EVERY_MIN;
      everyMax = DEFAULT_EVERY_MAX;
    }
    const count = num("count") ?? DEFAULT_VISUAL_COUNT;
    const captions = attrs.get("captions") ?? "off";
    const effects = list("effect");

    this.skipWs();
    if (this.peekStr("/>")) {
      this.pos += 2;
      throw new ParseError(`<visual> tag must have children`, this.pos);
    }
    this.expectStr(">");
    const children: Node[] = [];
    for (;;) {
      this.skipWs();
      if (this.pos >= this.input.length) {
        throw new ParseError("<visual> is never closed (missing </visual>)", this.pos);
      }
      if (this.peekStr("</visual>")) {
        this.skipWs();
        this.expectStr("</visual>");
        break;
      }
      if (this.peekStr("<caption")) {
        this.expectStr("<caption");
        this.readAttributes();
        this.skipWs();
        if (this.peekStr("/>")) {
          this.pos += 2;
          continue;
        }
        this.expectStr(">");
        this.parseNodes(); // caption body — consumed, not part of the AST
        this.expectClosing("caption");
        continue;
      }
      if (this.peekStr("<")) {
        children.push(this.parseTag());
      } else {
        const start = this.pos;
        const lt = this.input.indexOf("<", this.pos);
        this.pos = lt === -1 ? this.input.length : lt;
        if (this.input.slice(start, this.pos).trim()) children.push({ kind: "text" });
      }
    }
    return { kind: "visual", source, everyMin, everyMax, count, captions, effects, children };
  }

  /**
   * Children of an `<if>`: both branches' content is collected (and thus
   * validated) while the `<else>`/`</else>` markers are skipped. Content
   * after `</else>` joins the else branch, mirroring the Rust parser.
   */
  private parseIfChildren(): Node[] {
    const nodes: Node[] = [];
    for (;;) {
      if (this.pos >= this.input.length) {
        throw new ParseError("<if> is never closed (missing </if>)", this.pos);
      }
      this.skipWs();
      if (this.peekStr("</")) {
        const save = this.pos;
        this.pos += 2;
        const name = this.readName("closing tag name");
        this.skipWs();
        this.expectStr(">");
        if (name === "if") break;
        if (name === "else") continue;
        this.pos = save;
        throw new ParseError(`unexpected closing tag </${name}> inside <if>`, this.pos);
      }
      if (this.peekStr("<")) {
        const save = this.pos;
        this.pos++;
        const name = this.readName("tag name");
        if (name === "else") {
          this.readAttributes();
          this.skipWs();
          if (this.peekStr("/>")) this.pos += 2;
          else this.expectStr(">");
          continue;
        }
        this.pos = save;
        nodes.push(this.parseTag());
        continue;
      }
      const lt = this.input.indexOf("<", this.pos);
      const end = lt === -1 ? this.input.length : lt;
      const text = this.input.slice(this.pos, end);
      this.pos = end;
      if (text.trim()) nodes.push({ kind: "text" });
    }
    return nodes;
  }
}

// ── semantic validation (mirror tag_parser.rs `validate`) ──────────────────

function validateNodes(
  nodes: Node[],
  errors: string[],
  seenIncludes: Set<string>,
  parents: string[] = [],
): void {
  for (const node of nodes) {
    switch (node.kind) {
      case "voice":
        if (!VALID_SPEAKERS.includes(node.speaker)) {
          errors.push(`unknown speaker '${node.speaker}' — valid: ${VALID_SPEAKERS.join(", ")}`);
        }
        validateNodes(node.children, errors, seenIncludes, [...parents, "voice"]);
        break;
      case "speed":
      case "volume":
      case "loop":
      case "background":
      case "section":
      case "beatmeterContainer":
        validateNodes(node.children, errors, seenIncludes, [...parents, node.kind]);
        break;
      case "until":
        if (node.waitingSound && !VALID_SOUND_TYPES.includes(node.waitingSound)) {
          errors.push(`unknown waiting-sound '${node.waitingSound}' in <until> — valid: ${VALID_SOUND_TYPES.join(", ")}`);
        }
        validateNodes(node.children, errors, seenIncludes, [...parents, "until"]);
        break;
      case "beatmeter":
        if (node.bpm <= 0) errors.push(`<beatmeter> bpm must be > 0 (got ${node.bpm})`);
        const soundName = node.sound ?? "click";
        if (!VALID_SOUND_TYPES.includes(soundName)) {
          errors.push(`unknown sound '${soundName}' in <beatmeter sound="..."> — valid: ${VALID_SOUND_TYPES.join(", ")}`);
        }
        if (node.pattern !== undefined) {
          const bad = [...node.pattern].find((c) => !"Xx.".includes(c));
          if (node.pattern === "") {
            errors.push("<beatmeter> pattern is empty — use at least one of X/x/. or omit it");
          } else if (bad !== undefined) {
            errors.push(`invalid pattern char '${bad}' in <beatmeter pattern="${node.pattern}"> — only X, x, . are allowed`);
          }
        }
        validateNodes(node.children, errors, seenIncludes, [...parents, "beatmeter"]);
        break;
      case "sound":
        if (!VALID_SOUND_TYPES.includes(node.soundType)) {
          errors.push(`unknown sound type '${node.soundType}' — valid: ${VALID_SOUND_TYPES.join(", ")}`);
        }
        break;
      case "tone":
        if (!VALID_TONE_PRESETS.includes(node.preset)) {
          errors.push(`unknown tone preset '${node.preset}' — valid: ${VALID_TONE_PRESETS.join(", ")} (others fall back to sine)`);
        }
        break;
      case "effect":
        if (!VALID_EFFECT_TYPES.includes(node.effectType)) {
          errors.push(`unknown effect type '${node.effectType}' — valid: ${VALID_EFFECT_TYPES.join(", ")}`);
        } else if (node.effectType === "echo" && node.preset !== undefined && !VALID_ECHO_PRESETS.includes(node.preset)) {
          errors.push(`unknown echo preset '${node.preset}' — valid: ${VALID_ECHO_PRESETS.join(", ")}`);
        } else if (node.effectType === "reverb" && node.preset !== undefined && !VALID_REVERB_PRESETS.includes(node.preset)) {
          errors.push(`unknown reverb preset '${node.preset}' — valid: ${VALID_REVERB_PRESETS.join(", ")}`);
        }
        // `<effect>` content is baked into ONE clip (no split points), so a
        // conditional inside can never be toggled per playback.
        if (node.children.some((c) => c.kind === "if")) {
          errors.push(`<if> is not allowed directly inside <effect> — move it outside the effect`);
        }
        validateNodes(node.children, errors, seenIncludes, [...parents, "effect"]);
        break;
      case "overlay":
      case "random":
      case "scramble":
      case "choice":
        for (const part of node.parts) {
          if (part.role !== undefined) {
            errors.push(`<part role="..."> is only valid inside <react>`);
          }
          validateNodes(part.children, errors, seenIncludes, [...parents, node.kind]);
        }
        break;
      case "react": {
        const mains = node.parts.filter((p) => p.role === "main").length;
        const fallbacks = node.parts.filter((p) => p.role === "fallback").length;
        if (mains !== 1) errors.push(`<react> requires exactly one <part role="main">`);
        if (fallbacks !== 1) errors.push(`<react> requires exactly one <part role="fallback">`);
        for (const p of node.parts) {
          if (p.role !== undefined && p.role !== "main" && p.role !== "fallback") {
            errors.push(`<part role="${p.role}"> is not valid in <react> (use "main" or "fallback")`);
          }
        }
        for (const part of node.parts) {
          validateNodes(part.children, errors, seenIncludes, [...parents, "react"]);
        }
        break;
      }
      case "rating":
        if (node.min > node.max) errors.push(`<rating> min (${node.min}) must be ≤ max (${node.max})`);
        break;
      case "if": {
        const parsed = parseCondition(node.cond);
        if (!parsed.ok) {
          errors.push(`<if cond="${node.cond}">: ${parsed.error}`);
        }
        validateNodes(node.children, errors, seenIncludes, [...parents, "if"]);
        break;
      }
      case "visual": {
        // Containment: one screen at a time, and never inside a concurrent
        // audio layer or a single-clip construct (mirrors tag_parser.rs).
        for (const parent of ["visual", "until", "effect", "beatmeter", "background", "overlay"]) {
          if (parents.includes(parent)) {
            errors.push(
              `<visual> is not allowed inside <${parent}> — place it in sequence content (top level, inside <voice>/<loop>/<main>, a <choice>/<random>/<react> part, …)`,
            );
          }
        }
        if (!VALID_VISUAL_SOURCES.includes(node.source)) {
          errors.push(`unknown source '${node.source}' in <visual source="..."> — valid: ${VALID_VISUAL_SOURCES.join(", ")}`);
        }
        if (!(node.everyMin > 0) || node.everyMax < node.everyMin) {
          errors.push(`<visual> every/bpm must be > 0 with min ≤ max (got ${node.everyMin}..${node.everyMax})`);
        }
        if (node.count < 1 || node.count > 40) {
          errors.push(`<visual> count must be between 1 and 40 (got ${node.count})`);
        }
        if (!VALID_CAPTION_MODES.includes(node.captions)) {
          errors.push(`unknown captions mode '${node.captions}' in <visual captions="..."> — valid: ${VALID_CAPTION_MODES.join(", ")}`);
        }
        for (const e of node.effects) {
          if (!VALID_VISUAL_EFFECTS.includes(e)) {
            errors.push(`unknown effect '${e}' in <visual effect="..."> — valid: ${VALID_VISUAL_EFFECTS.join(", ")}`);
          }
        }
        validateNodes(node.children, errors, seenIncludes, [...parents, "visual"]);
        break;
      }
      case "include":
        if (!node.src) errors.push(`<include> has an empty 'src' attribute`);
        else if (seenIncludes.has(node.src)) {
          errors.push(`circular or repeated <include src="${node.src}"> — each file may only be included once in a render tree`);
        } else if (includeSrcIsGlob(node.src)) {
          // Wildcards expand over one directory; reject patterns that would
          // need recursive directory matching (mirrors the Rust validator).
          const sep = Math.max(node.src.lastIndexOf("/"), node.src.lastIndexOf("\\"));
          if (sep >= 0 && /[*?]/.test(node.src.slice(0, sep))) {
            errors.push(
              `Wildcards in <include src="${node.src}"> are only allowed in the file name, not in directories`,
            );
          }
        }
        seenIncludes.add(node.src);
        break;
      case "text":
      case "pause":
        break;
    }
  }
}

/** Parse + semantically validate a TTS XML script; returns diagnostics. */
export function validateXml(content: string): Diag[] {
  let nodes: Node[];
  try {
    nodes = new Parser(content).parseNodes();
  } catch (e) {
    if (e instanceof ParseError) {
      const line = content.slice(0, e.pos).split("\n").length;
      return [{ severity: "error", line, message: `XML parse error: ${e.message}` }];
    }
    return [{ severity: "error", message: `XML parse error: ${e}` }];
  }
  const errors: string[] = [];
  validateNodes(nodes, errors, new Set());
  return errors.map((message) => ({ severity: "error" as const, message }));
}
