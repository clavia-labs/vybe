import { describe, expect, it } from "bun:test";
import type { Provider } from "../../src/index.js";
import { apply } from "./machine.js";
import { isLeaf, type MenuNode } from "./menu.js";
import { runInterpreter } from "./run.js";
import {
  isSolved,
  PUZZLES,
  SOLUTION,
  sudokuGame,
  wrongCells,
  type Grid,
} from "./sudoku.js";

function solutions(grid: Grid): number {
  const index = grid.flat().indexOf(0);
  if (index < 0) return 1;
  const [r, c] = [Math.floor(index / 4), index % 4];
  let count = 0;
  for (let digit = 1; digit <= 4; digit += 1) {
    const box = [0, 1].flatMap((i) =>
      [0, 1].map((j) => grid[r - (r % 2) + i]![c - (c % 2) + j]),
    );
    if (
      grid[r]!.includes(digit) ||
      grid.some((cells) => cells[c] === digit) ||
      box.includes(digit)
    )
      continue;
    grid[r]![c] = digit;
    count += solutions(grid);
    grid[r]![c] = 0;
  }
  return count;
}

describe("4×4 sudoku game", () => {
  it("uses puzzles with exactly one solution", () => {
    for (const puzzle of Object.values(PUZZLES)) {
      expect(solutions(puzzle.map((cells) => [...cells]))).toBe(1);
      puzzle.flat().forEach((cell, i) => {
        if (cell !== 0) expect(cell).toBe(SOLUTION.flat()[i]!);
      });
    }
  });

  it("offers every empty cell and digit as a valid move", () => {
    const game = sudokuGame(PUZZLES.hard, "effects");
    const cells = game.menu(game.initial);
    expect(Object.keys(cells.choices)).toHaveLength(11);
    for (const cell of Object.values(cells.choices)) {
      const digits = cell.next() as MenuNode;
      expect(Object.keys(digits.choices)).toEqual(["1", "2", "3", "4"]);
      for (const digit of Object.values(digits.choices)) {
        const leaf = digit.next();
        if (!isLeaf(leaf) || leaf.kind !== "instruction")
          throw new Error("Expected an edit");
        expect(() => apply(game.initial, leaf.instruction)).not.toThrow();
      }
    }
  });

  it("varies how much each question says", () => {
    const describe = (questions: "plain" | "context" | "effects") => {
      const game = sudokuGame(PUZZLES.easy, questions);
      const cell = game.menu(game.initial).choices["row 1, column 1"]!;
      const digits = cell.next() as MenuNode;
      return [cell.description, digits.choices["4"]!.description];
    };
    expect(describe("plain")).toEqual([
      "The empty cell at row 1, column 1.",
      "Write 4 in row 1, column 1.",
    ]);
    expect(describe("context")).toEqual([
      "Its row holds [_, _, _, 4], its column holds [_, 3, 2, 4], and its box holds [_, _, 3, 4].",
      "Row 1 becomes [4, _, _, 4].",
    ]);
    expect(describe("effects")[1]).toBe(
      "Row 1 becomes [4, _, _, 4]. 4 already appears in its row and column and box.",
    );
  });

  it("plays through the run loop, ends when the grid is full, and replays with jq", async () => {
    const game = sudokuGame(PUZZLES.easy, "plain");
    // Fill five cells correctly, then the last one wrongly. The last cell is
    // the only choice, so only its digit is asked.
    const moves = [
      ["row 1, column 1", "1"],
      ["row 1, column 2", "2"],
      ["row 1, column 3", "3"],
      ["row 2, column 3", "1"],
      ["row 3, column 3", "4"],
      ["2"],
    ].flat();
    let index = 0;
    const provider: Provider = {
      decide(request) {
        if (request.kind === "is")
          throw new Error("Games ask no completion question");
        const answer = moves[index++]!;
        const keys = Object.keys(request.rubric as Record<string, string>);
        return {
          choice: answer,
          probabilities: Object.fromEntries(
            keys.map((key) => [key, key === answer ? 1 : 0]),
          ),
        };
      },
    };
    const run = await runInterpreter(game.task, {
      provider,
      game,
      temperature: 0,
    });
    expect(run.status).toBe("done");
    expect(run.steps).toHaveLength(6);
    expect(isSolved(run.answer as Grid)).toBe(false);
    expect(wrongCells(run.answer as Grid, PUZZLES.easy)).toBe(1);
    expect(run.replayMatches).toBe(true);
    expect(run.program).toContain("| (.answer[0][0] = 1)");
  });
});
