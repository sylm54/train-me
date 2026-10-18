/**
 * TTS XML script validator — TypeScript port of the essential checks from
 * train-me's canonical Rust parser (`src-tauri/src/tag_parser.rs`). The app's
 * `validate_files` remains authoritative; this port exists so framework CI
 * can catch the same classes of errors before packaging. Keep in sync when
 * the tag grammar changes.
 *
 * The grammar is audio-only: voice, speed, volume, pause, tone, effect,
 * overlay, loop, background, random, scramble, include, clip, zone, mark.
 * Interactive/visual/section/sound tags (until, choice, rating, react,
 * beatmeter, visual, if, else, intro, main, outro, sound, caption) no
 * longer parse — they surface as unknown-tag errors, mirroring the Rust
 * parser.
 */

import type { Diag } from "./validate";

// ── AST (only what semantic validation needs) ─────────────────────────────

interface Part {
  looped?: boolean;
  children: Node[];
}

export type Node =
  | { kind: "text" }
  | { kind: "voice"; speaker: string; children: Node[] }
  | { kind: "speed" | "volume" | "loop" | "background"; children: Node[] }
  | { kind: "pause" }
  | { kind: "tone"; preset: string }
  | { kind: "effect"; effectType: string; preset?: string; children: Node[] }
  | { kind: "overlay" | "random" | "scramble"; parts: Part[] }
  | { kind: "include"; src: string }
  | { kind: "clip"; src: string }
  | { kind: "zone"; name: string; children: Node[] }
  | { kind: "mark"; name: string };

// ── known values (mirror tag_parser.rs) ────────────────────────────────────

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

/** Every tag the audio-only grammar knows; anything else is a parse error. */
const KNOWN_TAGS = new Set([
  "voice", "speed", "volume", "pause", "tone", "effect", "overlay",
  "loop", "background", "random", "scramble", "include", "clip", "zone",
  "mark",
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

  parseNodes(): Node[] {
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
    if (this.peekStr("/>")) {
      throw new ParseError(`<${tag}> tag must have children`, this.pos);
    }
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
      looped: attrs.get("looped") === "true",
      children,
    };
  }

  private parseTag(): Node {
    this.expectStr("<");
    this.skipWs();
    const tag = this.readName("tag name");

    if (!KNOWN_TAGS.has(tag)) {
      throw new ParseError(`Unknown tag: <${tag}>`, this.pos);
    }

    const attrs = this.readAttributes();
    this.skipWs();

    // Self-closing tags: <pause/>, <tone/>, <include/>, <clip/>, <mark/>.
    if (["pause", "tone", "include", "clip", "mark"].includes(tag)) {
      this.skipWs();
      this.expectStr("/>");
      switch (tag) {
        case "include": {
          const src = attrs.get("src");
          if (src === undefined) {
            throw new ParseError(`<include> tag requires a 'src' attribute`, this.pos);
          }
          return { kind: "include", src };
        }
        case "clip": {
          const src = attrs.get("src");
          if (src === undefined) {
            throw new ParseError(`<clip> tag requires a 'src' attribute`, this.pos);
          }
          if (src.trim() === "") {
            throw new ParseError(`<clip> has an empty 'src' attribute`, this.pos);
          }
          return { kind: "clip", src };
        }
        case "mark": {
          const name = attrs.get("name");
          if (name === undefined) {
            throw new ParseError(`<mark> tag requires a 'name' attribute`, this.pos);
          }
          if (name.trim() === "") {
            throw new ParseError(`<mark> has an empty 'name' attribute`, this.pos);
          }
          return { kind: "mark", name };
        }
        case "tone":
          return { kind: "tone", preset: attrs.get("preset") ?? "sine" };
        default:
          return { kind: "pause" }; // <pause/> — nothing to validate
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
      case "effect": {
        const children = this.parseChildren("effect");
        return {
          kind: "effect",
          effectType: attrs.get("type") ?? "echo",
          preset: attrs.get("preset"),
          children,
        };
      }
      case "zone": {
        const name = attrs.get("name");
        if (name === undefined) {
          throw new ParseError(`<zone> tag requires a 'name' attribute`, this.pos);
        }
        if (name.trim() === "") {
          throw new ParseError(`<zone> has an empty 'name' attribute`, this.pos);
        }
        const children = this.parseChildren("zone");
        return { kind: "zone", name, children };
      }
      case "overlay":
      case "random":
      case "scramble": {
        this.skipWs();
        this.expectStr(">");
        const parts = this.parsePartsContainer(tag);
        return { kind: tag, parts };
      }
      default:
        throw new ParseError(`Unknown tag: <${tag}>`, this.pos);
    }
  }
}

// ── semantic validation (mirror tag_parser.rs `validate`) ──────────────────

function validateNodes(nodes: Node[], errors: string[], boundaryNames: Set<string>): void {
  for (const node of nodes) {
    switch (node.kind) {
      case "voice":
        if (!VALID_SPEAKERS.includes(node.speaker)) {
          errors.push(`Unknown speaker '${node.speaker}'. Valid speakers: ${VALID_SPEAKERS.join(", ")}`);
        }
        validateNodes(node.children, errors, boundaryNames);
        break;
      case "speed":
      case "volume":
      case "loop":
      case "background":
        validateNodes(node.children, errors, boundaryNames);
        break;
      case "tone":
        if (!VALID_TONE_PRESETS.includes(node.preset)) {
          errors.push(`Unknown tone preset '${node.preset}' in <tone preset="${node.preset}">. Valid presets: ${VALID_TONE_PRESETS.join(", ")}`);
        }
        break;
      case "effect":
        if (!VALID_EFFECT_TYPES.includes(node.effectType)) {
          errors.push(`Unknown effect type '${node.effectType}'. Valid types: ${VALID_EFFECT_TYPES.join(", ")}`);
        } else if (node.effectType === "echo" && node.preset !== undefined && !VALID_ECHO_PRESETS.includes(node.preset)) {
          errors.push(`Unknown echo preset '${node.preset}'. Valid presets: ${VALID_ECHO_PRESETS.join(", ")}`);
        } else if (node.effectType === "reverb" && node.preset !== undefined && !VALID_REVERB_PRESETS.includes(node.preset)) {
          errors.push(`Unknown reverb preset '${node.preset}'. Valid presets: ${VALID_REVERB_PRESETS.join(", ")}`);
        }
        validateNodes(node.children, errors, boundaryNames);
        break;
      case "overlay":
      case "random":
      case "scramble":
        for (const part of node.parts) {
          validateNodes(part.children, errors, boundaryNames);
        }
        break;
      case "include":
        if (node.src === "") {
          errors.push(`<include> has an empty 'src' attribute`);
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
        break;
      case "clip":
        if (node.src === "") {
          errors.push(`<clip> has an empty 'src' attribute`);
        } else if (includeSrcIsGlob(node.src)) {
          errors.push(`Wildcards are not allowed in <clip src="${node.src}"> — point at one file`);
        }
        break;
      case "zone":
      case "mark":
        // Zones and marks share one namespace per script: both are
        // interaction-layer addresses, so a zone/mark collision is just as
        // ambiguous as a duplicate zone.
        if (boundaryNames.has(node.name)) {
          errors.push(`Duplicate name '${node.name}' on a <zone>/<mark> — names must be unique within a script`);
        } else {
          boundaryNames.add(node.name);
        }
        if (node.kind === "zone") validateNodes(node.children, errors, boundaryNames);
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

/**
 * Every `<clip src="…">` path in a script's raw text (the AST-level clip
 * list is not exported; the linter regexes content the same way it already
 * does for `<include>`). Used to check clip sources exist in the framework
 * tree.
 */
export function clipSrcsInContent(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(/<clip\s[^>]*?\bsrc\s*=\s*["']([^"']+)["']/g)) {
    out.push(m[1]!);
  }
  return out;
}
