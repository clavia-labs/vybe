import { describe, expect, it } from "bun:test";
import { seededRandom } from "./sampling.js";
import { apply, initialState, stateKey, type MachineState } from "./machine.js";
import { actionMenu, isLeaf, type Leaf, type MenuNode } from "./menu.js";

function walk(state: MachineState, random: () => number, seen?: Set<string>) {
  let node: MenuNode | Leaf = actionMenu(state, {
    text: true,
    ...(seen ? { seen } : {}),
  });
  const path: string[] = [];
  const trail: { node: MenuNode; key: string }[] = [];
  while (!isLeaf(node)) {
    const keys = Object.keys(node.choices);
    expect(keys.length).toBeLessThanOrEqual(255);
    if (keys.length === 0) {
      // Dead ends are removed and the previous question is asked again.
      const parent = trail.pop()!;
      delete parent.node.choices[parent.key];
      path.pop();
      node = parent.node;
      continue;
    }
    const key = keys[Math.floor(random() * keys.length)]!;
    path.push(key);
    trail.push({ node, key });
    node = node.choices[key]!.next();
  }
  return { leaf: node, path };
}

describe("interpreter questions", () => {
  it("offers only edits that apply to the current state", () => {
    const random = seededRandom(3);
    let state = initialState("sort numbers 9 -1 5 7");
    for (let step = 0; step < 300; step += 1) {
      const { leaf } = walk(state, random);
      if (leaf.kind !== "instruction") continue;
      const next = apply(state, leaf.instruction);
      // Every offered edit changes the state.
      expect(stateKey(next)).not.toBe(stateKey(state));
      state = next;
    }
  });

  it("describes each option by its effect and flags earlier states", () => {
    let state = initialState("sort numbers 9 -1 5 7");
    state = apply(state, {
      op: "set",
      target: ["list"],
      value: { kind: "path", path: ["inputs"] },
    });
    const seen = new Set([stateKey(state)]);
    const swapped = apply(state, { op: "swap", list: ["list"], i: 0, j: 1 });
    seen.add(stateKey(swapped));
    const lists = actionMenu(swapped, { seen }).choices[
      "swap two list items"
    ]!.next() as MenuNode;
    // With one list, the run loop answers this question without Jev.
    expect(Object.keys(lists.choices)).toEqual(["`list` ([-1,9,5,7])"]);
    const swaps = lists.choices["`list` ([-1,9,5,7])"]!.next() as MenuNode;
    expect(
      swaps.choices["`list[0]` (-1) with `list[1]` (9)"]!.description,
    ).toBe("`list` becomes [9,-1,5,7]. This recreates an earlier state.");
    expect(swaps.choices["`list[1]` (9) with `list[2]` (5)"]!.description).toBe(
      "`list` becomes [-1,5,9,7].",
    );
  });
});
