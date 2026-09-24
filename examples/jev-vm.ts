import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { seededRandom } from "./jev-vm/sampling.js";
import { runInterpreter } from "./jev-vm/run.js";
import { setup } from "./jev-vm/setup.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    prompt: { type: "string" },
    model: { type: "string", default: process.env.JEV_MODEL ?? "jev-1.13.0" },
    "infer-model": {
      type: "string",
      default: process.env.OPENAI_MODEL ?? "gpt-6-luna",
    },
    "no-infer": { type: "boolean", default: false },
    "max-steps": { type: "string", default: "60" },
    seed: { type: "string", default: "1" },
    temperature: { type: "string", default: "1" },
    out: { type: "string" },
    jq: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(`Solve a prompt with Jev editing a JSON state, and emit a jq program.

bun run vm --prompt "sort numbers 9 -1 5 7" --temperature 0 --jq program.jq
jq -n -f program.jq

--prompt       Problem to solve (or supply it as a positional argument)
--model        Jev model, default JEV_MODEL or jev-1.13.0
--infer-model  Text model, default OPENAI_MODEL or gpt-6-luna
--no-infer     Disable text generation
--max-steps    Edit budget, default 60
--seed         Unsigned 32-bit sampling seed, default 1
--temperature  Decision temperature, default 1; 0 selects the argmax
--jq           Save the jq program (default: print it to stdout)
--out          Save the decisions, states, and replay result as JSON

Set TYPESAFE_API_KEY for Jev. Set OPENAI_API_KEY to enable text generation.`);
} else {
  if (values.prompt !== undefined && positionals.length)
    throw new Error("Use --prompt or a positional prompt, not both");
  const prompt = values.prompt ?? positionals.join(" ");
  const number = (value: string, name: string) => {
    const n = Number(value);
    if (!value.trim() || !Number.isFinite(n) || n < 0)
      throw new RangeError(`Invalid ${name}: ${value}`);
    return n;
  };
  const maxSteps = number(values["max-steps"], "max-steps");
  const temperature = number(values.temperature, "temperature");
  const seed = number(values.seed, "seed");
  if (maxSteps > 0 && !process.env.TYPESAFE_API_KEY)
    throw new Error("TYPESAFE_API_KEY is required");
  const { provider, infer } = setup({
    model: values.model,
    inferModel: values["infer-model"],
    infer: !values["no-infer"],
  });
  const run = await runInterpreter(prompt, {
    provider,
    temperature,
    maxSteps,
    rng: seededRandom(seed),
    ...(infer ? { infer } : {}),
    onStep: (step) => {
      console.error(
        JSON.stringify({
          action: step.action.join(" > "),
          edit: step.edit,
        }),
      );
    },
  });
  const save = async (path: string, data: string) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  };
  if (values.out)
    await save(
      values.out,
      JSON.stringify({ model: values.model, seed, ...run }, null, 2) + "\n",
    );
  if (values.jq) await save(values.jq, run.program + "\n");
  else process.stdout.write(run.program + "\n");
  console.error(
    JSON.stringify({
      status: run.status,
      steps: run.steps.length,
      answer: run.answer,
      replayMatches: run.replayMatches,
    }),
  );
  if (run.status !== "done" || run.replayMatches === false)
    process.exitCode = 1;
}
