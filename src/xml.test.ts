import { expect, test } from "bun:test";
import { clipSrcsInContent, validateXml } from "./xml";

const errors = (content: string): string[] =>
  validateXml(content).map((d) => d.message);

test("the audio-only tag set validates clean", () => {
  const script = `
    <tone preset="pinknoise" volume="0.3"/>
    <voice speaker="female">
      Hello. <pause duration="0.4"/>
      <clip src="sounds/click.wav"/>
    </voice>
    <zone name="warmup">
      <loop loops="2"><voice speaker="male">Inhale.</voice></loop>
    </zone>
    <mark name="warmup-done"/>
    <background volume="0.3"><speed value="0.9">Deep.</speed></background>
    <overlay>
      <part>one</part>
      <part looped="true" volume="0.3">two</part>
    </overlay>
    <random><part>a</part><part>b</part></random>
    <scramble><part>a</part><part>b</part></scramble>
    <include src="shared/part.xml"/>
  `;
  expect(errors(script)).toEqual([]);
});

test("removed tags are unknown-tag errors", () => {
  for (const gone of [
    '<sound type="beep"/>',
    "<until>x</until>",
    "<choice><part>a</part></choice>",
    '<rating min="1" max="5"/>',
    '<react><part role="main">a</part></react>',
    '<if cond="a">x</if>',
    "<else>x</else>",
    "<intro>x</intro>",
    "<main>x</main>",
    "<outro>x</outro>",
    '<beatmeter bpm="120">x</beatmeter>',
    "<visual>x</visual>",
    "<caption>x</caption>",
  ]) {
    const es = errors(gone);
    expect(es.length).toBe(1);
    expect(es[0]).toContain("Unknown tag");
  }
});

test("semantic checks: speakers, tone presets, effect presets", () => {
  expect(errors('<voice speaker="robot">x</voice>').join("\n")).toContain("Unknown speaker");
  expect(errors('<tone preset="banjo"/>').join("\n")).toContain("Unknown tone preset");
  expect(errors('<effect type="echo" preset="miles">x</effect>').join("\n")).toContain(
    "Unknown echo preset",
  );
  expect(errors('<effect type="reverb" preset="miles">x</effect>').join("\n")).toContain(
    "Unknown reverb preset",
  );
  expect(errors('<effect type="wobble">x</effect>').join("\n")).toContain("Unknown effect type");
  expect(errors('<effect type="reverb" preset="cathedral">x</effect>')).toEqual([]);
});

test("zone and mark names share one unique namespace per script", () => {
  expect(errors('<mark name="a"/><zone name="a"><pause/></zone>').join("\n")).toContain(
    "Duplicate name 'a'",
  );
  expect(errors('<zone name="a"><pause/></zone><mark name="b"/>')).toEqual([]);
});

test("include and clip src rules", () => {
  // Repeats are fine — cycles are the cross-file walk's job in lint.ts.
  expect(
    errors('<include src="foo.xml"/><voice>x</voice><include src="foo.xml"/>'),
  ).toEqual([]);
  expect(errors('<include src=""/>').length).toBe(1);
  expect(errors('<include src="dir/*/x.xml"/>').length).toBe(1);
  expect(errors('<clip src="dir/*/x.wav"/>').join("\n")).toContain(
    "Wildcards are not allowed in <clip",
  );
  expect(errors("<clip/>").length).toBe(1);
  expect(clipSrcsInContent('<clip volume="0.5" src=\'sounds/click.wav\'/>')).toEqual([
    "sounds/click.wav",
  ]);
});
