import { expect, test } from "bun:test";
import { validateHabit, validateRoutine, type Diag } from "./validate";

function diagsFor(body: string): Diag[] {
  const content = `---\nformat: 2\ntitle: T\nschedule: 0 8 * * *\n---\n\n${body}`;
  const diags: Diag[] = [];
  validateRoutine(content, diags);
  return diags;
}

const errors = (d: Diag[]) => d.filter((x) => x.severity === "error").map((x) => x.message);
const warnings = (d: Diag[]) => d.filter((x) => x.severity === "warning").map((x) => x.message);

test("proper block conditional parses clean", () => {
  const d = diagsFor("{{#if weekday == \"monday\"}}\n- [ ] item\n{{/if}}");
  expect(errors(d)).toEqual([]);
  expect(warnings(d)).toEqual([]);
});

test("inline {{#if}} on one line gives one actionable error, no 'never closed'", () => {
  const d = diagsFor("{{#if weekday == \"monday\"}}- [ ] item{{/if}}");
  const es = errors(d);
  expect(es.length).toBe(1);
  expect(es[0]).toContain("must be on their own lines");
  expect(es.join("\n")).not.toContain("never closed");
});

test("mid-line markers error clearly", () => {
  expect(errors(diagsFor("Today {{#if weekday == \"monday\"}}x{{/if}}")).join("\n")).toContain(
    "`{{#if}}` must be on its own line",
  );
  expect(errors(diagsFor("- [ ] item {{/if}}")).join("\n")).toContain(
    "`{{/if}}` must be on its own line",
  );
  expect(errors(diagsFor("{{#else}} oops")).join("\n")).toContain(
    "`{{#else}}` must be on its own line",
  );
});

test("agent action validates its message", () => {
  const withFailure = (failure: string): Diag[] => {
    const diags: Diag[] = [];
    validateRoutine(`---\nformat: 2\ntitle: T\nschedule: 0 8 * * *\n${failure}\n---\n\nbody`, diags);
    return diags;
  };
  expect(errors(withFailure('failure: { "type": "agent", "message": "check in" }'))).toEqual([]);
  expect(errors(withFailure('failure: { "type": "agent" }')).join("\n")).toContain(
    "`message` is required",
  );
  expect(errors(withFailure('failure: { "type": "agent", "message": "   " }')).join("\n")).toContain(
    "`message` is required",
  );
});

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
});
