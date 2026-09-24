import type { MachineState } from "./machine.js";
import type { MenuNode } from "./menu.js";
import type { Game } from "./run.js";

/** A 4×4 grid; 0 marks an empty cell. */
export type Grid = number[][];

export const SOLUTION: Grid = [
  [1, 2, 3, 4],
  [3, 4, 1, 2],
  [2, 1, 4, 3],
  [4, 3, 2, 1],
];

/** Puzzles with one solution each, from 6 to 11 empty cells. */
export const PUZZLES = {
  easy: [
    [0, 0, 0, 4],
    [3, 4, 0, 2],
    [2, 1, 0, 3],
    [4, 3, 2, 0],
  ],
  medium: [
    [0, 0, 3, 0],
    [3, 4, 0, 2],
    [0, 1, 4, 3],
    [0, 0, 0, 0],
  ],
  hard: [
    [1, 0, 0, 0],
    [0, 0, 0, 2],
    [0, 0, 4, 0],
    [0, 3, 0, 1],
  ],
} satisfies Record<string, Grid>;

/**
 * How much each question says:
 * - plain: cell coordinates and digits only.
 * - context: each cell option shows its row, column, and box.
 * - effects: digit options also say whether the digit already appears in
 *   the cell's row, column, or box.
 */
export type SudokuQuestions = "plain" | "context" | "effects";

export const SUDOKU_INSTRUCTIONS = `You are playing a 4×4 sudoku. \`answer\` is the grid: four rows of four cells, and 0 marks an empty cell.

Fill every empty cell with a digit from 1 to 4 so that each row, each column, and each 2×2 box contains 1, 2, 3, and 4 exactly once. The boxes are the four corners of the grid: rows 1–2 or 3–4, crossed with columns 1–2 or 3–4.

Each move fills one empty cell and cannot be undone. The game ends when the grid is full. Fill the cells whose digit is certain first.`;

const row = (grid: Grid, r: number) => grid[r]!;
const column = (grid: Grid, c: number) => grid.map((cells) => cells[c]!);
const box = (grid: Grid, r: number, c: number) => {
  const [r0, c0] = [r - (r % 2), c - (c % 2)];
  return [r0, r0 + 1].flatMap((i) => [c0, c0 + 1].map((j) => grid[i]![j]!));
};
const show = (cells: number[]) =>
  `[${cells.map((cell) => (cell === 0 ? "_" : cell)).join(", ")}]`;

export function isSolved(grid: Grid) {
  return JSON.stringify(grid) === JSON.stringify(SOLUTION);
}

/** Count the filled cells that differ from the solution. */
export function wrongCells(grid: Grid, puzzle: Grid) {
  return grid
    .flat()
    .filter((cell, i) => puzzle.flat()[i] === 0 && cell !== SOLUTION.flat()[i])
    .length;
}

export function sudokuGame(
  puzzle: Grid,
  questions: SudokuQuestions,
): Game & { task: string } {
  const task = `Solve this 4×4 sudoku. Rows, with 0 for empty cells: ${puzzle.map((cells) => cells.join(" ")).join(" / ")}.`;
  const initial: MachineState = {
    task,
    inputs: [],
    vars: {},
    list: [],
    answer: puzzle.map((cells) => [...cells]),
  };
  const menu = (state: MachineState): MenuNode => {
    const grid = state.answer as Grid;
    const empty = grid.flatMap((cells, r) =>
      cells.flatMap((cell, c) => (cell === 0 ? [[r, c] as const] : [])),
    );
    const name = (r: number, c: number) => `row ${r + 1}, column ${c + 1}`;
    return {
      id: "cell",
      question: "Which empty cell should be filled next?",
      choices: Object.fromEntries(
        empty.map(([r, c]) => [
          name(r, c),
          {
            description:
              questions === "plain"
                ? `The empty cell at ${name(r, c)}.`
                : `Its row holds ${show(row(grid, r))}, its column holds ${show(column(grid, c))}, and its box holds ${show(box(grid, r, c))}.`,
            next: () => ({
              id: "digit",
              question: `Which digit goes in ${name(r, c)}?`,
              choices: Object.fromEntries(
                [1, 2, 3, 4].map((digit) => {
                  const conflicts = [
                    row(grid, r).includes(digit) ? "row" : null,
                    column(grid, c).includes(digit) ? "column" : null,
                    box(grid, r, c).includes(digit) ? "box" : null,
                  ].filter((place) => place !== null);
                  const next = row(grid, r).map((cell, j) =>
                    j === c ? digit : cell,
                  );
                  const description =
                    questions === "plain"
                      ? `Write ${digit} in ${name(r, c)}.`
                      : questions === "context"
                        ? `Row ${r + 1} becomes ${show(next)}.`
                        : `Row ${r + 1} becomes ${show(next)}. ${
                            conflicts.length
                              ? `${digit} already appears in its ${conflicts.join(" and ")}.`
                              : `${digit} does not appear in its row, column, or box.`
                          }`;
                  return [
                    String(digit),
                    {
                      description,
                      next: () => ({
                        kind: "instruction" as const,
                        instruction: {
                          op: "set" as const,
                          target: ["answer", r, c],
                          value: { kind: "literal" as const, value: digit },
                        },
                      }),
                    },
                  ];
                }),
              ),
            }),
          },
        ]),
      ),
    };
  };
  return {
    task,
    initial,
    instructions: SUDOKU_INSTRUCTIONS,
    menu,
    over: (state) => !(state.answer as Grid).flat().includes(0),
  };
}
