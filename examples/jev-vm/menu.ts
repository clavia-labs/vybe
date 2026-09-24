import {
  apply,
  evaluate,
  formatPath,
  getAt,
  OPERATORS,
  stateKey,
  type Instruction,
  type Json,
  type MachineState,
  type Operand,
  type Operator,
  type Path,
} from "./machine.js";

/** One question for Jev. Each choice leads to another question or a leaf. */
export type MenuNode = {
  id: string;
  question: string;
  choices: Record<string, { description: string; next: () => MenuNode | Leaf }>;
};

export type Leaf =
  | { kind: "instruction"; instruction: Instruction }
  /** Ask a text model for a string to store at the target. */
  | { kind: "text"; target: Path };

export function isLeaf(value: MenuNode | Leaf): value is Leaf {
  return "kind" in value;
}

const LITERALS = [-1, ...Array.from({ length: 11 }, (_, n) => n), 100];
const VARIABLE_NAMES = ["n", "i", "j", "a", "b", "count", "total", "temp"];
const MAX_CHOICES = 200;

function show(value: Json | undefined) {
  const text = JSON.stringify(value) ?? "missing";
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

const ref = (path: Path) => `\`${formatPath(path)}\``;

type Source = { key: string; description: string; operand: Operand };
type Target = { key: string; description: string; path: Path };

/**
 * Questions about the current state. Every leaf is valid now and changes the
 * state, and every option that leads to a leaf states its effect, so Jev
 * compares outcomes instead of simulating edits. A branch can still turn out
 * to have no leaves; the caller removes it and asks again.
 */
export function actionMenu(
  state: MachineState,
  options: { seen?: ReadonlySet<string>; text?: boolean } = {},
): MenuNode {
  const effect = (instruction: Instruction) => {
    const next = apply(state, instruction);
    const changes: string[] = [];
    for (const key of ["list", "answer"] as const)
      if (show(next[key]) !== show(state[key]))
        changes.push(`${ref([key])} becomes ${show(next[key])}`);
    for (const [name, value] of Object.entries(next.vars))
      if (show(value) !== show(state.vars[name]))
        changes.push(`${ref(["vars", name])} becomes ${show(value)}`);
    const revisit = options.seen?.has(stateKey(next))
      ? " This recreates an earlier state."
      : "";
    return `${changes.length ? `${changes.join("; ")}.` : "No change."}${revisit}`;
  };
  const leaf = (instruction: Instruction) => ({
    description: effect(instruction),
    next: (): Leaf => ({ kind: "instruction", instruction }),
  });
  // An edit that leaves the state unchanged is valid but never useful, and a
  // fast model otherwise repeats it. Only edits that change the state count.
  const current = stateKey(state);
  const valid = (instruction: Instruction) => {
    try {
      return stateKey(apply(state, instruction)) !== current;
    } catch {
      return false;
    }
  };

  // Every value in the state, addressed by path.
  const paths: Path[] = [];
  const visit = (path: Path, value: Json) => {
    paths.push(path);
    if (Array.isArray(value))
      value.forEach((item, index) => visit([...path, index], item));
    else if (value && typeof value === "object")
      for (const [key, item] of Object.entries(value))
        visit([...path, key], item);
  };
  visit(["inputs"], state.inputs);
  for (const [name, value] of Object.entries(state.vars))
    visit(["vars", name], value);
  visit(["list"], state.list);
  visit(["answer"], state.answer);

  const sources: Source[] = [
    ...[...new Set([...LITERALS, ...state.inputs])].map((value) => ({
      key: String(value),
      description: `The number ${value}.`,
      operand: { kind: "literal" as const, value },
    })),
    ...paths.map((path) => ({
      key: `${ref(path)} (${show(getAt(state, path))})`,
      description: `The current value of ${ref(path)}.`,
      operand: { kind: "path" as const, path },
    })),
  ].slice(0, MAX_CHOICES);
  const valueOf = (operand: Operand) =>
    operand.kind === "literal" ? operand.value : getAt(state, operand.path)!;
  const numbers = sources.filter(
    ({ operand }) => typeof valueOf(operand) === "number",
  );

  const targets: Target[] = [
    ...paths
      .filter(([root]) => root !== "inputs")
      .map((path) => ({
        key: `${ref(path)} (now ${show(getAt(state, path))})`,
        description: `Replace the value of ${ref(path)}.`,
        path,
      })),
    ...VARIABLE_NAMES.filter((name) => !(name in state.vars)).map((name) => ({
      key: `new ${ref(["vars", name])}`,
      description: `Create the variable ${ref(["vars", name])}.`,
      path: ["vars", name],
    })),
  ].slice(0, MAX_CHOICES);
  const lists = paths.filter(
    (path) => path[0] !== "inputs" && Array.isArray(getAt(state, path)),
  );
  const pickList = (
    question: string,
    usable: (list: Json[]) => boolean,
    then: (path: Path, list: Json[]) => MenuNode,
  ): MenuNode => ({
    id: "list",
    question,
    choices: Object.fromEntries(
      lists
        .filter((path) => usable(getAt(state, path) as Json[]))
        .map((path) => {
          const list = getAt(state, path) as Json[];
          return [
            `${ref(path)} (${show(list)})`,
            {
              description: `The list ${ref(path)}.`,
              next: () => then(path, list),
            },
          ];
        }),
    ),
  });
  const withChoices = (node: MenuNode) => Object.keys(node.choices).length > 0;

  const choices: MenuNode["choices"] = {};
  choices["set a field"] = {
    description:
      "Copy a number, list, or field into a field of the state, or create a variable.",
    next: () => ({
      id: "target",
      question: "Which field should be set?",
      choices: Object.fromEntries(
        targets.map((target) => [
          target.key,
          {
            description: target.description,
            next: () => ({
              id: "value",
              question: `Which value should ${ref(target.path)} get? Each option shows the effect.`,
              choices: Object.fromEntries(
                sources
                  .filter(
                    ({ operand }) =>
                      operand.kind === "literal" ||
                      formatPath(operand.path) !== formatPath(target.path),
                  )
                  .map((source) => ({
                    source,
                    instruction: {
                      op: "set",
                      target: target.path,
                      value: source.operand,
                    } satisfies Instruction,
                  }))
                  .filter(({ instruction }) => valid(instruction))
                  .map(({ source, instruction }) => [
                    source.key,
                    leaf(instruction),
                  ]),
              ),
            }),
          },
        ]),
      ),
    }),
  };
  if (numbers.length > 0)
    choices["compute a value"] = {
      description:
        "Combine two numbers with arithmetic or a comparison, and store the result in a field.",
      next: () => ({
        id: "operator",
        question: "Which operation should compute the value?",
        choices: Object.fromEntries(
          (Object.entries(OPERATORS) as [Operator, string][]).map(
            ([operator, meaning]) => [
              operator,
              {
                description: `Compute ${meaning}.`,
                next: () => ({
                  id: "left",
                  question: `Which value is a in ${meaning}?`,
                  choices: Object.fromEntries(
                    numbers.map((left) => [
                      left.key,
                      {
                        description: left.description,
                        next: () => ({
                          id: "right",
                          question: `a is ${left.key}. Which value is b in ${meaning}?`,
                          choices: Object.fromEntries(
                            numbers
                              .filter(
                                ({ operand }) =>
                                  evaluate(
                                    operator,
                                    valueOf(left.operand),
                                    valueOf(operand),
                                  ) !== undefined,
                              )
                              .map((right) => {
                                const result = evaluate(
                                  operator,
                                  valueOf(left.operand),
                                  valueOf(right.operand),
                                );
                                return [
                                  right.key,
                                  {
                                    description: `${right.description} The result is ${show(result)}.`,
                                    next: () => ({
                                      id: "target",
                                      question: `Where should the result, ${show(result)}, go? Each option shows the effect.`,
                                      choices: Object.fromEntries(
                                        targets
                                          .map((target) => ({
                                            target,
                                            instruction: {
                                              op: "compute",
                                              target: target.path,
                                              operator,
                                              left: left.operand,
                                              right: right.operand,
                                            } satisfies Instruction,
                                          }))
                                          .filter(({ instruction }) =>
                                            valid(instruction),
                                          )
                                          .map(({ target, instruction }) => [
                                            target.key,
                                            leaf(instruction),
                                          ]),
                                      ),
                                    }),
                                  },
                                ];
                              }),
                          ),
                        }),
                      },
                    ]),
                  ),
                }),
              },
            ],
          ),
        ),
      }),
    };
  const swaps = pickList(
    "Which list should have two items exchanged?",
    (list) => new Set(list.map((item) => show(item))).size >= 2,
    (path, list) => ({
      id: "swap",
      question: `Which two items of ${ref(path)} should exchange places? Each option shows the effect.`,
      choices: Object.fromEntries(
        list
          .flatMap((_, i) => list.slice(i + 1).map((__, k) => [i, i + 1 + k]))
          .filter(([i, j]) => show(list[i!]) !== show(list[j!]))
          .slice(0, MAX_CHOICES)
          .map(([i, j]) => [
            `${ref([...path, i!])} (${show(list[i!])}) with ${ref([...path, j!])} (${show(list[j!])})`,
            leaf({ op: "swap", list: path, i: i!, j: j! }),
          ]),
      ),
    }),
  );
  if (withChoices(swaps))
    choices["swap two list items"] = {
      description: "Exchange two items of a list, for example to reorder it.",
      next: () => swaps,
    };
  const appends = pickList(
    "Which list should get a new last item?",
    () => true,
    (path) => ({
      id: "value",
      question: `Which value should be added to the end of ${ref(path)}? Each option shows the effect.`,
      choices: Object.fromEntries(
        sources.map((source) => [
          source.key,
          leaf({ op: "append", list: path, value: source.operand }),
        ]),
      ),
    }),
  );
  if (withChoices(appends))
    choices["append to a list"] = {
      description: "Add a value to the end of a list.",
      next: () => appends,
    };
  const removals = pickList(
    "Which list should lose an item?",
    (list) => list.length > 0,
    (path, list) => ({
      id: "index",
      question: `Which item of ${ref(path)} should be removed? Each option shows the effect.`,
      choices: Object.fromEntries(
        list
          .slice(0, MAX_CHOICES)
          .map((item, index) => [
            `${ref([...path, index])} (${show(item)})`,
            leaf({ op: "remove", list: path, index }),
          ]),
      ),
    }),
  );
  if (withChoices(removals))
    choices["remove a list item"] = {
      description: "Delete one item from a list.",
      next: () => removals,
    };
  if (options.text)
    choices["generate text"] = {
      description:
        "Ask a text model for prose the task needs, such as a poem or a message, and store it in a field. Compute numbers and orderings with edits instead.",
      next: () => ({
        id: "target",
        question: "Which field should receive the generated text?",
        choices: Object.fromEntries(
          targets.map((target) => [
            target.key,
            {
              description: target.description,
              next: (): Leaf => ({ kind: "text", target: target.path }),
            },
          ]),
        ),
      }),
    };
  return {
    id: "action",
    question: "Which edit should the interpreter make next?",
    choices,
  };
}

/** A short, human-readable form of an instruction. */
export function describeInstruction(instruction: Instruction) {
  const operand = (value: Operand) =>
    value.kind === "literal" ? show(value.value) : ref(value.path);
  switch (instruction.op) {
    case "set":
      return `${ref(instruction.target)} = ${operand(instruction.value)}`;
    case "compute":
      return `${ref(instruction.target)} = ${operand(instruction.left)} ${instruction.operator} ${operand(instruction.right)}`;
    case "swap":
      return `swap ${ref([...instruction.list, instruction.i])} and ${ref([...instruction.list, instruction.j])}`;
    case "append":
      return `append ${operand(instruction.value)} to ${ref(instruction.list)}`;
    case "remove":
      return `remove ${ref([...instruction.list, instruction.index])}`;
    case "text":
      return `${ref(instruction.target)} = generated text`;
  }
}
