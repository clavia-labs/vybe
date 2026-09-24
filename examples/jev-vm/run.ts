import {
  state,
  type JsonValue,
  type NativeAnswer,
  type Provider,
  type Random,
} from "../../src/index.js";
import {
  checkDistribution,
  checkTemperature,
  sampleWithTemperature,
} from "./sampling.js";
import {
  apply,
  initialState,
  jqProgram,
  runJq,
  sameState,
  stateKey,
  toJq,
  type Instruction,
  type Json,
  type MachineState,
} from "./machine.js";
import {
  actionMenu,
  describeInstruction,
  isLeaf,
  type Leaf,
  type MenuNode,
} from "./menu.js";

/** Shared instructions sent with every question. */
export const INTERPRETER_INSTRUCTIONS = `You are an interpreter. The state is your memory, and you solve the task by editing it one step at a time.

State:
- \`task\` states the problem. \`inputs\` holds the numbers that appear in it, in order; it is read-only.
- \`vars\` holds named values you create. \`list\` is a working list. \`answer\` holds the result.
- \`recentActions\` lists your latest edits, oldest first.

Editing:
- Each edit is chosen through a short series of questions: first the kind of edit, then its details. \`path\` lists your answers so far for the current edit; answer only the current question.
- Each edit applies immediately, and the next question shows the new state. There are no loops or branches: you are the control flow. Repeat an edit when the task needs repetition, and decide each step from the current values.
- Options state their effect on the state. Choose the effect that moves the state toward the answer. Avoid options that recreate an earlier state.

Completion:
- The run ends when \`answer\` holds the complete, correct answer. A number answer is a number; a list answer is a list; a text answer is a string.
- Compute numbers, counts, and orderings with edits. Generate text only when the task asks for prose.`;

export type InferText = (context: {
  task: string;
  state: MachineState;
  field: string;
}) => Promise<string>;

export type Decision = {
  field: string;
  question: string;
  choices: Record<string, string>;
  selected: string;
  probabilities: Record<string, number>;
  samplingProbabilities: Record<string, number>;
  /** Null when the question had one choice and Jev was not asked. */
  native: NativeAnswer | null;
  draw: number | null;
};

export type Step = {
  /** Answers that selected the edit. */
  action: string[];
  instruction: Instruction;
  edit: string;
  jq: string;
  decisions: Decision[];
  state: MachineState;
  elapsedMs: number;
};

export type Run = {
  prompt: string;
  temperature: number;
  status: "done" | "step-limit";
  initial: MachineState;
  final: MachineState;
  answer: Json;
  steps: Step[];
  /** The final "is the answer complete?" decision, when the run ended that way. */
  completion: Decision | null;
  program: string;
  /** The final state computed by the jq binary, or null without jq. */
  replay: Json | null;
  replayMatches: boolean | null;
};

/** Call a tagged-template verb with text built at runtime. */
function template(parts: string[]): TemplateStringsArray {
  return Object.assign([...parts], { raw: [...parts] });
}

export async function runInterpreter(
  prompt: string,
  options: {
    provider?: Provider;
    rng?: Random;
    temperature?: number;
    maxSteps?: number;
    infer?: InferText;
    onStep?: (step: Step) => void | Promise<void>;
  } = {},
): Promise<Run> {
  const temperature = options.temperature ?? 1;
  checkTemperature(temperature);
  const maxSteps = options.maxSteps ?? 60;
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 0)
    throw new RangeError("maxSteps must be a non-negative integer");
  const rng = options.rng ?? Math.random;
  const initial = initialState(prompt);
  let current = initial;
  const seen = new Set([stateKey(current)]);
  const history: string[] = [];
  const steps: Step[] = [];
  let completion: Decision | null = null;

  const sample = async (
    field: string,
    question: string,
    choices: Record<string, string>,
    native: Promise<NativeAnswer>,
    probabilities: () => Promise<Record<string, number>>,
  ): Promise<Decision> => {
    const answer = await native;
    const distribution = await probabilities();
    const sampled = sampleWithTemperature(
      { choice: "", confidence: 0, probabilities: distribution },
      temperature,
      rng,
    );
    return {
      field,
      question,
      choices,
      selected: sampled.selected,
      probabilities: distribution,
      samplingProbabilities: sampled.probabilities,
      native: answer,
      draw: sampled.draw,
    };
  };

  while (steps.length < maxSteps) {
    const started = performance.now();
    let node: MenuNode | Leaf = actionMenu(current, {
      seen,
      text: options.infer !== undefined,
    });
    const view = { ...current, recentActions: history.slice(-6) };
    const path: string[] = [];
    const trail: { node: MenuNode; key: string }[] = [];
    const decisions: Decision[] = [];
    let done = false;
    let checked = false;
    while (!isLeaf(node)) {
      if (Object.keys(node.choices).length === 0) {
        // A dead end: no edit below this option changes the state. Remove
        // the option and ask the previous question again.
        const parent = trail.pop();
        if (!parent) throw new Error("No edit can change the state");
        delete parent.node.choices[parent.key];
        path.pop();
        node = parent.node;
        continue;
      }
      const choices = Object.fromEntries(
        Object.entries(node.choices).map(([key, { description }]) => [
          key,
          description,
        ]),
      );
      const keys = Object.keys(choices);
      const context = state(
        {
          ...(view as unknown as Record<string, JsonValue>),
          path: [...path],
          question: node.question,
        },
        options.provider === undefined ? {} : { provider: options.provider },
      );
      // The first question of a step shares one request with the
      // completion check, which is only meaningful once answer is set.
      const status =
        !checked && current.answer !== null
          ? context.is`Follow the shared instructions in ${{ interpreterRole: INTERPRETER_INSTRUCTIONS }}. Does ${context.ref.answer} already hold the complete, correct answer to ${context.ref.task}?`
          : null;
      const query =
        keys.length === 1
          ? null
          : context.pick(
              template([
                "Follow the shared instructions in ",
                `. ${node.question} Your answers so far for this edit are `,
                ". Choose using the effect described for each option.",
              ]),
              { interpreterRole: INTERPRETER_INSTRUCTIONS },
              context.ref.path,
            )(choices);
      checked = true;
      const statusNative = status?.native;
      const queryNative = query?.native;
      if (status && statusNative) {
        const decision = await sample(
          "complete",
          "Does answer hold the complete, correct answer?",
          { yes: "The answer is complete.", no: "More edits are needed." },
          statusNative,
          async () => {
            const probability = await status;
            return { yes: probability, no: 1 - probability };
          },
        );
        if (decision.selected === "yes") {
          completion = decision;
          done = true;
          // Settle the batched action question before stopping.
          await queryNative?.catch(() => undefined);
          break;
        }
        decisions.push(decision);
      }
      let selected: string;
      if (query && queryNative) {
        const decision = await sample(
          node.id,
          node.question,
          choices,
          queryNative,
          async () => {
            checkDistribution(await queryNative, keys);
            return (await query).probabilities;
          },
        );
        decisions.push(decision);
        selected = decision.selected;
      } else {
        // A question with one answer needs no model call.
        selected = keys[0]!;
        decisions.push({
          field: node.id,
          question: node.question,
          choices,
          selected,
          probabilities: { [selected]: 1 },
          samplingProbabilities: { [selected]: 1 },
          native: null,
          draw: null,
        });
      }
      path.push(selected);
      trail.push({ node, key: selected });
      node = node.choices[selected]!.next();
    }
    if (done) break;
    const leaf = node as Leaf;
    const instruction: Instruction =
      leaf.kind === "instruction"
        ? leaf.instruction
        : {
            op: "text",
            target: leaf.target,
            text: (
              await options.infer!({
                task: prompt,
                state: current,
                field: leaf.target.join("."),
              })
            ).trim(),
          };
    current = apply(current, instruction);
    seen.add(stateKey(current));
    const edit = describeInstruction(instruction);
    history.push(edit);
    const step: Step = {
      action: path,
      instruction,
      edit,
      jq: toJq(instruction),
      decisions,
      state: current,
      elapsedMs: performance.now() - started,
    };
    steps.push(step);
    await options.onStep?.(step);
  }
  const program = jqProgram(
    initial,
    steps.map(({ instruction }) => instruction),
  );
  const replay = await runJq(program);
  return {
    prompt,
    temperature,
    status: completion ? "done" : "step-limit",
    initial,
    final: current,
    answer: current.answer,
    steps,
    completion,
    program,
    replay,
    replayMatches: replay === null ? null : sameState(replay, current),
  };
}
