import { mkdir, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { seededRandom } from "./sampling.js";
import type { Json } from "./machine.js";
import { runInterpreter, type Run } from "./run.js";
import { setup } from "./setup.js";

type Case = {
  name: string;
  prompt: string;
  /** Returns whether the answer is correct, or null when unscored. */
  check: (answer: Json) => boolean | null;
  maxSteps?: number;
};

const equals = (expected: Json) => (answer: Json) =>
  JSON.stringify(answer) === JSON.stringify(expected);

/** Earlier prompts, then tasks where Jev must branch on the values it sees. */
export const CASES: Case[] = [
  {
    name: "add",
    prompt: "Calculate 7 plus 5. Return the sum.",
    check: equals(12),
  },
  { name: "add-one", prompt: "Calculate 7 plus 1.", check: equals(8) },
  { name: "subtract", prompt: "Subtract 5 from 7.", check: equals(2) },
  {
    name: "factorial",
    prompt: "Compute the factorial of 5 using a loop.",
    check: equals(120),
  },
  {
    name: "sort-4",
    prompt: "sort numbers 9 -1 5 7",
    check: equals([-1, 5, 7, 9]),
  },
  {
    name: "sort-5",
    prompt: "sort numbers 5 9 20 -1 5",
    check: equals([-1, 5, 5, 9, 20]),
  },
  {
    name: "haiku",
    prompt: "Write a haiku about the number 7 and output it",
    check: (answer) =>
      typeof answer === "string" && answer.trim().split("\n").length === 3,
  },
  {
    name: "greeting",
    prompt: "Write a friendly greeting for Ada.",
    check: (answer) => typeof answer === "string" && answer.includes("Ada"),
  },
  {
    // Ambiguous: it does not say which factorial.
    name: "sort-and-factorial",
    prompt: "sort numbers 9 -1 5 7 and compute the factorial",
    check: () => null,
  },
  {
    name: "collatz",
    prompt:
      "Start with n = 6. Repeat until n is 1: if n is even, halve it; otherwise replace it with 3n + 1. Return how many steps it took.",
    check: equals(8),
    maxSteps: 80,
  },
  {
    name: "gcd",
    prompt:
      "Return the greatest common divisor of 84 and 36, using Euclid's algorithm.",
    check: equals(12),
  },
  {
    name: "fibonacci",
    prompt:
      "Return the 10th Fibonacci number, where the first two are 1 and 1.",
    check: equals(55),
    maxSteps: 80,
  },
  {
    name: "digit-sum",
    prompt: "Return the sum of the digits of 2026.",
    check: equals(10),
  },
  {
    name: "maximum",
    prompt: "Return the largest of 3 17 8 12.",
    check: equals(17),
  },
  {
    name: "reverse",
    prompt: "Reverse the list 3 1 4 1 5.",
    check: equals([5, 1, 4, 1, 3]),
  },
  {
    name: "count-even",
    prompt: "How many of 4 7 10 13 22 are even?",
    check: equals(3),
  },
  {
    name: "sum",
    prompt: "Return the sum of 4 8 15 16 23 42.",
    check: equals(108),
  },
];

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      model: { type: "string", default: process.env.JEV_MODEL ?? "jev-1.13.0" },
      "infer-model": {
        type: "string",
        default: process.env.OPENAI_MODEL ?? "gpt-6-luna",
      },
      temperature: { type: "string", default: "0,0.1" },
      seed: { type: "string", default: "1" },
      concurrency: { type: "string", default: "4" },
      only: { type: "string" },
      out: { type: "string", default: ".context/jev-vm-eval" },
    },
  });
  if (!process.env.TYPESAFE_API_KEY)
    throw new Error("TYPESAFE_API_KEY is required");
  const { provider, infer } = setup({
    model: values.model,
    inferModel: values["infer-model"],
    infer: true,
  });
  const only = values.only?.split(",");
  const jobs = CASES.filter(({ name }) => !only || only.includes(name)).flatMap(
    (task) =>
      values.temperature
        .split(",")
        .map((t) => ({ task, temperature: Number(t) })),
  );
  await mkdir(values.out, { recursive: true });
  const results: Record<string, unknown>[] = [];
  let next = 0;
  // A few runs at a time, in one process.
  await Promise.all(
    Array.from({ length: Number(values.concurrency) }, async () => {
      while (next < jobs.length) {
        const { task, temperature } = jobs[next++]!;
        let run: Run | undefined;
        let error: string | undefined;
        try {
          run = await runInterpreter(task.prompt, {
            provider,
            temperature,
            maxSteps: task.maxSteps ?? 60,
            rng: seededRandom(Number(values.seed)),
            ...(infer ? { infer } : {}),
          });
          await writeFile(
            `${values.out}/${task.name}-${temperature}.json`,
            JSON.stringify(run, null, 2) + "\n",
          );
        } catch (caught) {
          error = caught instanceof Error ? caught.message : String(caught);
        }
        const result = {
          case: task.name,
          temperature,
          correct: run ? task.check(run.answer) : false,
          status: run?.status ?? "error",
          edits: run?.steps.length,
          answer: run?.answer,
          replayMatches: run?.replayMatches,
          ...(error ? { error } : {}),
        };
        results.push(result);
        console.log(JSON.stringify(result));
      }
    }),
  );
  const scored = results.filter(({ correct }) => correct !== null);
  console.log(
    `correct ${scored.filter(({ correct }) => correct).length}/${scored.length} scored runs`,
  );
  await writeFile(
    `${values.out}/summary.json`,
    JSON.stringify(results, null, 2) + "\n",
  );
}
