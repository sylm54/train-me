import { expect, test } from "bun:test";
import { validateHabit, validateRoutine, type Diag } from "./validate";
import { validateOnboarding } from "./onboarding";

function diagsFor(body: string): Diag[] {
  const content = `---\nformat: 2\ntitle: T\nschedule: 0 8 * * *\n---\n\n${body}`;
  const diags: Diag[] = [];
  validateRoutine(content, diags);
  return diags;
}

const errors = (d: Diag[]) => d.filter((x) => x.severity === "error").map((x) => x.message);
const warnings = (d: Diag[]) => d.filter((x) => x.severity === "warning").map((x) => x.message);

function onboardingErrors(items: unknown): string[] {
  const diags: Diag[] = [];
  validateOnboarding(items, ".", null, diags);
  return errors(diags);
}

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
  expect(onboardingErrors([{ ...TIERLIST_Q, tiers: ["S"] }]).join("\n")).toContain(
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
