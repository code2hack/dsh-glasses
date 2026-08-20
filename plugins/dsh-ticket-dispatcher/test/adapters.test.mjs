import assert from "node:assert/strict";
import test from "node:test";
import { parseJqLines } from "../lib/adapters.js";

test("parseJqLines parses one JSON value per paginated jq output line", () => {
  assert.deepEqual(parseJqLines('{"number":1,"state":"open"}\n{"number":2,"state":"closed"}\n'), [
    { number: 1, state: "open" },
    { number: 2, state: "closed" },
  ]);
});

test("parseJqLines accepts empty and whitespace-only output", () => {
  assert.deepEqual(parseJqLines(""), []);
  assert.deepEqual(parseJqLines(" \n\t\n"), []);
});

test("parseJqLines identifies a malformed output line", () => {
  assert.throws(() => parseJqLines('{"ok":true}\nnot-json\n'), /invalid gh --jq JSON on line 2: "not-json"/);
});
