import { expect, test } from "bun:test";
import { validateXml } from "./xml";

test("validateXml allows the same include src repeatedly in one file", () => {
  const diags = validateXml(
    `<include src="foo.xml"/><voice speaker="female">between</voice><include src="foo.xml"/>`,
  );
  expect(diags).toEqual([]);
});

test("validateXml still rejects empty src and directory wildcards", () => {
  expect(validateXml(`<include src=""/>`).length).toBe(1);
  expect(validateXml(`<include src="dir/*/x.xml"/>`).length).toBe(1);
});
