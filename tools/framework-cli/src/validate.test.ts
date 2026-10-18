import { expect, test } from "bun:test";
import {
  checkJsSyntax,
  jsBodyFirstLine,
  scriptSrcsInBody,
  splitJsFrontmatter,
  validateHabit,
  validateRoutine,
  validateStore,
  validateTask,
  type Diag,
} from "./validate";
import { validateOnboarding } from "./onboarding";

const errors = (d: Diag[]) => d.filter((x) => x.severity === "error").map((x) => x.message);
const warnings = (d: Diag[]) => d.filter((x) => x.severity === "warning").map((x) => x.message);

function routineDiags(content: string): Diag[] {
  const diags: Diag[] = [];
  validateRoutine(content, diags);
  return diags;
}

/** A routine with the given front-matter lines and a valid body. */
function routine(fm: string, body = "await wait(1);"): string {
  return `/*---\n${fm}\n---*/\n${body}`;
}

function onboardingErrors(items: unknown): string[] {
  const diags: Diag[] = [];
  validateOnboarding(items, ".", null, diags);
  return errors(diags);
}

// ── comment front-matter ───────────────────────────────────────────────────

test("comment front-matter splits verbatim body", () => {
  const content = "/*---\ntitle: T\n---*/\nawait wait(1);\nawait wait(2);";
  const split = splitJsFrontmatter(content);
  expect(split.kind).toBe("block");
  if (split.kind !== "block") return;
  expect(split.fm).toBe("title: T\n");
  expect(split.body).toBe("await wait(1);\nawait wait(2);");
  expect(jsBodyFirstLine(split.fm)).toBe(4);
});

test("missing or unterminated front-matter is an error", () => {
  expect(errors(routineDiags("await wait(1);")).join("\n")).toContain(
    "the first line must be exactly `/*---`",
  );
  expect(errors(routineDiags("/*---\ntitle: T\nawait wait(1);")).join("\n")).toContain(
    "never closed",
  );
  // No leading-whitespace tolerance: ` /*---` does not open the block.
  expect(errors(routineDiags(" /*---\ntitle: T\n---*/\nawait wait(1);")).length).toBe(1);
});

test("leftover format key warns, valid routine parses clean", () => {
  const d = routineDiags(routine("title: T\nschedule: 0 8 * * *\ntimeframe: 45m"));
  expect(errors(d)).toEqual([]);
  expect(warnings(d)).toEqual([]);

  const withFormat = routineDiags(routine("format: 2\ntitle: T"));
  expect(errors(withFormat)).toEqual([]);
  expect(warnings(withFormat).join("\n")).toContain("`format:` no longer exists");
});

// ── JS body syntax (AsyncFunction, never executed) ─────────────────────────

test("valid JS bodies compile and invalid ones are rejected with a file line", () => {
  const ok = routineDiags(routine("title: T", 'const s = await audio.play("hypnos/a.xml");\nawait s.end;'));
  expect(errors(ok)).toEqual([]);

  const bad = routineDiags(routine("title: T", "await wait(1);\nconst x = {;"));
  const es = errors(bad);
  expect(es.length).toBe(1);
  expect(es[0]).toContain("invalid JavaScript");
  expect(es[0]).toContain("Unexpected token");
  // The body's second line is file line 5 (1 /*---, 2 fm, 3 ---*/, 4-5 body).
  const lineDiag = bad.find((d) => d.severity === "error" && d.line !== undefined);
  expect(lineDiag?.line).toBe(5);
});

test("module-only syntax is rejected, top-level await is not", () => {
  expect(errors(routineDiags(routine("title: T", 'import { x } from "y";')))).toHaveLength(1);
  expect(errors(routineDiags(routine("title: T", "export const a = 1;")))).toHaveLength(1);
  const diags: Diag[] = [];
  checkJsSyntax("await wait(30);\nreturn;", 1, diags);
  expect(errors(diags)).toEqual([]);
});

// ── quoted .xml discovery over JS bodies ───────────────────────────────────

test("script discovery scans quoted .xml strings in the body", () => {
  const content = routine(
    "title: T",
    [
      'const a = await audio.play("hypnos/warm.xml");',
      "const b = await audio.play('hypnos/other.xml');",
      'const not1 = "readme.md";      // not .xml',
      'const not2 = "x.xml.txt";      // does not end in .xml',
      'const not3 = "http://x/y.xml"; // kept — resolution filters later',
      "const mixed = \"a.xml';         // unterminated → no match",
    ].join("\n"),
  );
  const diags: Diag[] = [];
  const parsed = validateRoutine(content, diags);
  expect(parsed?.scripts.sort()).toEqual([
    "http://x/y.xml",
    "hypnos/other.xml",
    "hypnos/warm.xml",
  ]);
});

// ── actions / keys (shared with habits & store) ────────────────────────────

test("agent action validates its message", () => {
  const withFailure = (failure: string): Diag[] =>
    routineDiags(routine(`title: T\nschedule: 0 8 * * *\n${failure}`));
  expect(errors(withFailure('failure: { "type": "agent", "message": "check in" }'))).toEqual([]);
  expect(errors(withFailure('failure: { "type": "agent" }')).join("\n")).toContain(
    "`message` is required",
  );
  expect(errors(withFailure('failure: { "type": "agent", "message": "   " }')).join("\n")).toContain(
    "`message` is required",
  );
});

test("task containers validate timeouts and template refs", () => {
  const content = `/*---
title: Check
timeframe: 2h
timeouts: [{ "after": "30m", "action": { "type": "task", "template": "extra" } }]
success: { "type": "points", "delta": 10 }
---*/
await show("t", { type: "text", text: "Check the device." });`;
  const diags: Diag[] = [];
  const parsed = validateTask(content, diags);
  expect(errors(diags)).toEqual([]);
  expect(parsed?.templates).toEqual(["extra"]);
});

test("store entries still validate", () => {
  const diags: Diag[] = [];
  validateStore(
    JSON.stringify({ title: "Pass", price: 5, action: { type: "points", delta: 0 } }),
    diags,
  );
  expect(errors(diags)).toEqual([]);
  const bad: Diag[] = [];
  validateStore(JSON.stringify({ title: "No price" }), bad);
  expect(errors(bad).join("\n")).toContain("`price` is required");
});

// ── habits (unchanged v2 markdown) ─────────────────────────────────────────

test("habit minutes mode mirrors the engine's unit rules", () => {
  const habitDiags = (frontmatter: string): Diag[] => {
    const diags: Diag[] = [];
    validateHabit(`---\n${frontmatter}\n---\nbody`, diags);
    return diags;
  };
  // A time habit parses clean.
  expect(errors(habitDiags('title: P\ntype: min\nminutes: 40'))).toEqual([]);
  // Both units is an authoring mistake.
  expect(
    errors(habitDiags('title: Q\ntype: min\ncount: 2\nminutes: 40')).join("\n"),
  ).toContain("mutually exclusive");
  // Negative minutes is rejected.
  expect(
    errors(habitDiags("title: R\ntype: max\nminutes: -5")).join("\n"),
  ).toContain("`minutes` must be ≥ 0");
  // `format` is optional but must be 2 when present.
  expect(errors(habitDiags('format: 2\ntitle: P\ntype: min'))).toEqual([]);
  expect(errors(habitDiags('format: 3\ntitle: P\ntype: min')).join("\n")).toContain(
    "`format` must be 2",
  );
});

// ── onboarding (unchanged) ─────────────────────────────────────────────────

const TIERLIST_Q = {
  id: "toys",
  answer: "tierlist",
  prompt: "Rate your toys",
  choices: ["rope", "impact", "blindfold"],
  tiers: ["S", "A", "B"],
};

test("tierlist questions validate shape", () => {
  // A well-formed tierlist lints clean, alone or with tier conditions.
  expect(onboardingErrors([{ ...TIERLIST_Q }])).toEqual([]);
  expect(
    onboardingErrors([
      { ...TIERLIST_Q },
      { kind: "text", text: "x", showIf: { id: "toys", tier: "S", includes: "rope" } },
      {
        kind: "text",
        text: "y",
        showIf: { id: "toys", tierAtLeast: "A", includes: "rope" },
      },
    ]),
  ).toEqual([]);

  // Needs tiers — at least two of them, unique and non-empty.
  expect(onboardingErrors([{ ...TIERLIST_Q, tiers: undefined }]).join("\n")).toContain(
    "at least 2 `tiers`",
  );
  expect(onboardingErrors([{ ...TIERLIST_Q, tiers: ["S", "S"] }]).join("\n")).toContain(
    "must be non-empty and unique",
  );
  // Items must be unique too, and at least two of them.
  expect(
    onboardingErrors([{ ...TIERLIST_Q, choices: ["rope", "rope"] }]).join("\n"),
  ).toContain("must be non-empty and unique");
  expect(
    onboardingErrors([{ ...TIERLIST_Q, choices: ["rope"] }]).join("\n"),
  ).toContain("at least 2 `choices`");
});

test("tier showIf scopes must name a tierlist question above and its tier", () => {
  // Unknown tier name.
  expect(
    onboardingErrors([
      { ...TIERLIST_Q },
      { kind: "text", text: "x", showIf: { id: "toys", tier: "Z", includes: "rope" } },
    ]).join("\n"),
  ).toContain("does not define");
  // Scoping a non-tierlist question.
  expect(
    onboardingErrors([
      { id: "n", answer: "open", prompt: "p" },
      { kind: "text", text: "x", showIf: { id: "n", tier: "S", includes: "rope" } },
    ]).join("\n"),
  ).toContain("is not a tierlist question above it");
  // Scoping a question BELOW (self-reference included) is rejected.
  expect(
    onboardingErrors([
      {
        id: "t2",
        answer: "tierlist",
        prompt: "p",
        choices: ["a", "b"],
        tiers: ["S", "A"],
        showIf: { id: "t2", tier: "S", includes: "a" },
      },
    ]).join("\n"),
  ).toContain("is not a tierlist question above it");
  // Combining both scopes.
  expect(
    onboardingErrors([
      { ...TIERLIST_Q },
      {
        kind: "text",
        text: "x",
        showIf: { id: "toys", tier: "S", tierAtLeast: "A", includes: "rope" },
      },
    ]).join("\n"),
  ).toContain("cannot combine");
  // A tier scope without a comparator.
  expect(
    onboardingErrors([
      { ...TIERLIST_Q },
      { kind: "text", text: "x", showIf: { id: "toys", tier: "S" } },
    ]).join("\n"),
  ).toContain("needs at least one of");
});
