/**
 * Condition DSL for feature files (routines and TTS `<if>` tags).
 *
 * One tiny boolean expression grammar shared by the session runner
 * (page/element `when:`), the manifest player (`<if cond>`), and the
 * framework CLI linter. The Rust mirror lives in `src-tauri/src/cond.rs`
 * (syntax + identifier validation only — this module is the executable
 * semantics).
 *
 * Grammar:
 *   expr    := or
 *   or      := and ("or" and)*
 *   and     := not ("and" not)*
 *   not     := "not" not | cmp
 *   cmp     := sum (("=" | "!=" | "<" | "<=" | ">" | ">=") sum | "in" list)?
 *   sum     := term (("+" | "-") term)*
 *   term    := unary (("*" | "/") unary)*
 *   unary   := "-" unary | primary
 *   primary := number | string | "true" | "false" | ident | "(" expr ")"
 *   list    := "[" (value ("," value)*)? "]"
 *
 * Identifiers resolve against the run-context variables (see
 * `RESERVED_VARS`). A missing variable makes the whole condition false
 * (never a throw — a broken condition must not break a session), which
 * the linters surface as a diagnostic instead.
 */

/** The engine-provided variable names. Answer fields merge on top of these. */
export const RESERVED_VARS = [
  "weekday",
  "is_weekend",
  "hour",
  "date",
  "month",
  "streak",
  "best_streak",
  "done",
  "fails",
  "days_since_last",
  "points",
  "locked",
] as const;

export type CondValue = number | string | boolean;
export type CondVars = Record<string, CondValue>;

// ──────────────────────────────────────────────────────────────────────────
// AST + parser
// ──────────────────────────────────────────────────────────────────────────

type Node =
  | { k: "or"; a: Node; b: Node }
  | { k: "and"; a: Node; b: Node }
  | { k: "not"; a: Node }
  | { k: "cmp"; op: CmpOp; a: Node; b: Node }
  | { k: "in"; a: Node; items: Node[] }
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "bool"; v: boolean }
  | { k: "var"; name: string }
  | { k: "neg"; a: Node }
  | { k: "bin"; op: "+" | "-" | "*" | "/"; a: Node; b: Node };

type CmpOp = "==" | "!=" | "<" | "<=" | ">" | ">=";

interface ParseResult {
  ok: true;
  node: Node;
  identifiers: string[];
}

interface ParseError {
  ok: false;
  error: string;
}

const IDENT_START = /[A-Za-z_]/;
const IDENT = /[A-Za-z0-9_]/;

class Parser {
  private pos = 0;
  readonly identifiers: string[] = [];
  constructor(private readonly src: string) {}

  /** Parse the whole expression; trailing garbage is an error. */
  parse(): ParseError | ParseResult {
    try {
      const node = this.or();
      this.skipWs();
      if (this.pos < this.src.length) {
        return { ok: false, error: `unexpected \`${this.src[this.pos]}\` after expression` };
      }
      return { ok: true, node, identifiers: this.identifiers };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private fail(msg: string): never {
    throw new Error(`${msg} (at position ${this.pos})`);
  }

  private skipWs(): void {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos])) this.pos++;
  }

  private peek(): string {
    return this.src[this.pos] ?? "";
  }

  private eat(s: string): boolean {
    this.skipWs();
    if (this.src.startsWith(s, this.pos)) {
      // `<=`/`>=`/`==`/`!=` must not be eaten as `<`/`>`/`=` by callers.
      this.pos += s.length;
      return true;
    }
    return false;
  }

  private or(): Node {
    let a = this.and();
    while (this.word("or")) {
      a = { k: "or", a, b: this.and() };
    }
    return a;
  }

  private and(): Node {
    let a = this.not();
    while (this.word("and")) {
      a = { k: "and", a, b: this.not() };
    }
    return a;
  }

  /** Match a bare keyword (word boundary required). */
  private word(w: "or" | "and" | "not" | "in" | "true" | "false"): boolean {
    this.skipWs();
    if (!this.src.startsWith(w, this.pos)) return false;
    const after = this.src[this.pos + w.length];
    if (after && (IDENT.test(after) || after === '"' || after === "'")) return false;
    this.pos += w.length;
    return true;
  }

  private not(): Node {
    if (this.word("not")) {
      return { k: "not", a: this.not() };
    }
    return this.cmp();
  }

  private cmp(): Node {
    const a = this.sum();
    this.skipWs();
    for (const op of ["==", "!=", "<=", ">=", "<", ">"] as CmpOp[]) {
      if (this.eat(op)) return { k: "cmp", op, a, b: this.sum() };
    }
    if (this.word("in")) {
      return { k: "in", a, items: this.list() };
    }
    return a;
  }

  private list(): Node[] {
    this.skipWs();
    if (!this.eat("[")) this.fail("expected `[` after `in`");
    const items: Node[] = [];
    this.skipWs();
    if (this.eat("]")) return items;
    for (;;) {
      items.push(this.primary());
      this.skipWs();
      if (this.eat(",")) continue;
      if (this.eat("]")) return items;
      this.fail("expected `,` or `]` in list");
    }
  }

  private sum(): Node {
    let a = this.term();
    for (;;) {
      this.skipWs();
      if (this.eat("+")) a = { k: "bin", op: "+", a, b: this.term() };
      else if (this.eat("-")) a = { k: "bin", op: "-", a, b: this.term() };
      else return a;
    }
  }

  private term(): Node {
    let a = this.unary();
    for (;;) {
      this.skipWs();
      if (this.eat("*")) a = { k: "bin", op: "*", a, b: this.unary() };
      else if (this.eat("/")) a = { k: "bin", op: "/", a, b: this.unary() };
      else return a;
    }
  }

  private unary(): Node {
    this.skipWs();
    if (this.eat("-")) return { k: "neg", a: this.unary() };
    return this.primary();
  }

  private primary(): Node {
    this.skipWs();
    const c = this.peek();
    if (!c) this.fail("unexpected end of expression");
    if (c === "(") {
      this.pos++;
      const inner = this.or();
      this.skipWs();
      if (!this.eat(")")) this.fail("expected `)`");
      return inner;
    }
    if (c === '"' || c === "'") {
      return { k: "str", v: this.string(c) };
    }
    if (/[0-9]/.test(c)) return { k: "num", v: this.number() };
    if (IDENT_START.test(c)) {
      if (this.word("true")) return { k: "bool", v: true };
      if (this.word("false")) return { k: "bool", v: false };
      return { k: "var", name: this.ident() };
    }
    this.fail(`unexpected character \`${c}\``);
  }

  private string(quote: string): string {
    this.pos++; // opening quote
    let out = "";
    while (this.pos < this.src.length && this.src[this.pos] !== quote) {
      out += this.src[this.pos++];
    }
    if (this.pos >= this.src.length) this.fail("unterminated string");
    this.pos++; // closing quote
    return out;
  }

  private number(): number {
    const start = this.pos;
    while (this.pos < this.src.length && /[0-9.]/.test(this.src[this.pos])) this.pos++;
    const v = Number(this.src.slice(start, this.pos));
    if (Number.isNaN(v)) this.fail(`invalid number at position ${start}`);
    return v;
  }

  private ident(): string {
    const start = this.pos;
    this.pos++;
    while (this.pos < this.src.length && IDENT.test(this.src[this.pos])) this.pos++;
    const name = this.src.slice(start, this.pos);
    if (name === "and" || name === "or" || name === "not" || name === "in") {
      this.fail(`unexpected keyword \`${name}\``);
    }
    this.identifiers.push(name);
    return name;
  }
}

export interface ParsedCondition {
  identifiers: string[];
  eval: (vars: CondVars) => boolean;
}

/**
 * Parse a condition once. Returns `null` + `error` on syntax errors; the
 * caller (linter) reports them.
 */
export function parseCondition(src: string): { ok: true; cond: ParsedCondition } | { ok: false; error: string } {
  const res = new Parser(src).parse();
  if (!res.ok) return { ok: false, error: res.error };
  const identifiers = [...new Set(res.identifiers)];
  return { ok: true, cond: { identifiers, eval: (vars) => evalNode(res.node, vars) } };
}

/** Parse + evaluate in one step. Any error (syntax, missing var, type) → false. */
export function evalCondition(src: string, vars: CondVars): boolean {
  const parsed = parseCondition(src);
  if (!parsed.ok) return false;
  try {
    return parsed.cond.eval(vars) === true;
  } catch {
    return false;
  }
}

function evalNode(n: Node, vars: CondVars): boolean {
  switch (n.k) {
    case "or":
      return truth(evalNode(n.a, vars)) || truth(evalNode(n.b, vars));
    case "and":
      return truth(evalNode(n.a, vars)) && truth(evalNode(n.b, vars));
    case "not":
      return !truth(evalNode(n.a, vars));
    case "cmp":
      return compare(n.op, value(n.a, vars), value(n.b, vars));
    case "in": {
      const v = value(n.a, vars);
      return n.items.some((item) => looseEq(v, value(item, vars)));
    }
    case "num":
    case "str":
    case "bool":
      return n.v === true;
    case "var":
      return truth(lookup(n.name, vars));
    case "neg":
      // A bare negated value as a condition: true when non-zero.
      return num(value(n.a, vars), n) !== 0;
    case "bin": {
      // A bare arithmetic expression used as a condition: true when non-zero.
      return arith(n, vars) !== 0;
    }
  }
}

/** Evaluate a node to a plain value (for comparisons / arithmetic). */
function value(n: Node, vars: CondVars): CondValue {
  switch (n.k) {
    case "num":
      return n.v;
    case "str":
      return n.v;
    case "bool":
      return n.v;
    case "var":
      return lookup(n.name, vars);
    case "neg":
      return -num(value(n.a, vars), n);
    case "bin":
      return arith(n, vars);
    default:
      throw new Error("boolean expression used as a value");
  }
}

function truth(v: CondValue): boolean {
  if (typeof v === "boolean") return v;
  // Numbers: non-zero is true (C-style, used by arithmetic results);
  // strings must compare, not truth-test.
  if (typeof v === "number") return v !== 0;
  return false;
}

function lookup(name: string, vars: CondVars): CondValue {
  if (Object.prototype.hasOwnProperty.call(vars, name)) return vars[name];
  throw new Error(`unknown variable \`${name}\``);
}

function num(v: CondValue, at: Node): number {
  if (typeof v === "number") return v;
  throw new Error(`expected a number (\`${at.k}\`)`);
}

function arith(n: Extract<Node, { k: "bin" }>, vars: CondVars): number {
  const a = num(value(n.a, vars), n.a);
  const b = num(value(n.b, vars), n.b);
  switch (n.op) {
    case "+":
      return a + b;
    case "-":
      return a - b;
    case "*":
      return a * b;
    case "/":
      return b === 0 ? 0 : a / b;
  }
}

function compare(op: CmpOp, a: CondValue, b: CondValue): boolean {
  if (op === "==") return looseEq(a, b);
  if (op === "!=") return !looseEq(a, b);
  if (typeof a === "number" && typeof b === "number") {
    switch (op) {
      case "<":
        return a < b;
      case "<=":
        return a <= b;
      case ">":
        return a > b;
      case ">=":
        return a >= b;
    }
  }
  if (typeof a === "string" && typeof b === "string") {
    switch (op) {
      case "<":
        return a < b;
      case "<=":
        return a <= b;
      case ">":
        return a > b;
      case ">=":
        return a >= b;
    }
  }
  return false;
}

function looseEq(a: CondValue, b: CondValue): boolean {
  if (typeof a === "number" && typeof b === "number") return a === b;
  if (typeof a === typeof b) return a === b;
  return false;
}

// ──────────────────────────────────────────────────────────────────────────
// Interpolation (`{{ var }}`) — routines only; TTS is conditional-only.
// ──────────────────────────────────────────────────────────────────────────

const INTERP_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** Substitute `{{ var }}` placeholders with run-context values. Unknown vars render as empty. */
export function interpolate(text: string, vars: CondVars): string {
  return text.replace(INTERP_RE, (_whole, name: string) => {
    if (Object.prototype.hasOwnProperty.call(vars, name)) {
      const v = vars[name];
      return typeof v === "boolean" ? (v ? "true" : "false") : String(v);
    }
    return "";
  });
}

/** Identifiers referenced by `{{ var }}` placeholders in a text (for lints). */
export function interpolationIdents(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(INTERP_RE)) out.push(m[1]);
  return [...new Set(out)];
}

/**
 * True when the text still contains a raw `{{#if}}`-style marker. The Rust
 * parser strips well-formed markers; leftovers mean unbalanced blocks, which
 * the linter reports and the renderer leaves as visible text.
 */
export function hasRawConditionalMarker(text: string): boolean {
  return /\{\{#(if|else|\/if)/.test(text);
}
