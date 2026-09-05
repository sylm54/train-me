import { expect, test } from "bun:test";
import { validateRoutine, type Diag } from "./validate";

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
