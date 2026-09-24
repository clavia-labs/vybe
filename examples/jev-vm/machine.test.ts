import { describe, expect, it } from "bun:test";
import {
  apply,
  initialState,
  jqProgram,
  runJq,
  type Instruction,
} from "./machine.js";

const path = (...keys: (string | number)[]) => ({
  kind: "path" as const,
  path: keys,
});
const literal = (value: number) => ({ kind: "literal" as const, value });

describe("JSON state machine", () => {
  it("seeds inputs from the integers in the prompt", () => {
    expect(initialState("sort numbers 9 -1 5 7")).toEqual({
      task: "sort numbers 9 -1 5 7",
      inputs: [9, -1, 5, 7],
      vars: {},
      list: [],
      answer: null,
    });
  });

  it("matches jq for every instruction, including negative division", async () => {
    const instructions: Instruction[] = [
      { op: "set", target: ["list"], value: path("inputs") },
      { op: "swap", list: ["list"], i: 0, j: 1 },
      { op: "append", list: ["list"], value: path("inputs", 0) },
      { op: "remove", list: ["list"], index: 2 },
      {
        op: "compute",
        target: ["vars", "q"],
        operator: "/",
        left: literal(-7),
        right: literal(2),
      },
      {
        op: "compute",
        target: ["vars", "r"],
        operator: "%",
        left: literal(-7),
        right: literal(2),
      },
      {
        op: "compute",
        target: ["vars", "p"],
        operator: "*",
        left: path("vars", "q"),
        right: path("list", 0),
      },
      {
        op: "compute",
        target: ["vars", "lt"],
        operator: "<",
        left: path("vars", "q"),
        right: literal(0),
      },
      { op: "set", target: ["answer"], value: path("list") },
      { op: "swap", list: ["answer"], i: 0, j: 2 },
      {
        op: "text",
        target: ["vars", "note"],
        text: 'Say "hi" \\ and \\(not interpolation)\nnext',
      },
    ];
    let state = initialState("mix 9 -1 5 7");
    const initial = state;
    for (const instruction of instructions) state = apply(state, instruction);
    expect(state.vars).toMatchObject({ q: -4, r: -1, p: 4, lt: true });
    expect(state.list).toEqual([-1, 9, 7, 9]);
    expect(state.answer).toEqual([7, 9, -1, 9]);
    expect(await runJq(jqProgram(initial, instructions))).toEqual(state);
  });

  it("rejects edits that are not valid for the current state", () => {
    const state = initialState("divide 4 by 0");
    expect(() =>
      apply(state, { op: "set", target: ["inputs", 0], value: literal(1) }),
    ).toThrow("read-only");
    expect(() =>
      apply(state, {
        op: "compute",
        target: ["answer"],
        operator: "/",
        left: literal(4),
        right: literal(0),
      }),
    ).toThrow();
    expect(() =>
      apply(state, { op: "set", target: ["list"], value: literal(1) }),
    ).toThrow("list");
    expect(() =>
      apply(state, { op: "swap", list: ["list"], i: 0, j: 1 }),
    ).toThrow();
  });
});
