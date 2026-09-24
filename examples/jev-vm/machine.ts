/**
 * A JSON state machine. The state is Jev's memory; each instruction is a
 * small edit that also renders as jq, so a run replays with plain `jq`.
 */

export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };

export type MachineState = {
  task: string;
  inputs: number[];
  vars: Record<string, Json>;
  list: Json[];
  answer: Json;
};

/** A path such as ["vars", "n"] or ["list", 2]. */
export type Path = readonly (string | number)[];

export type Operand =
  { kind: "literal"; value: Json } | { kind: "path"; path: Path };

export const OPERATORS = {
  "+": "a + b",
  "-": "a - b",
  "*": "a * b",
  "/": "a / b, rounded down",
  "%": "the remainder of a / b, with the sign of a",
  "<": "true if a < b",
  ">": "true if a > b",
  "<=": "true if a <= b",
  ">=": "true if a >= b",
  "==": "true if a equals b",
  "!=": "true if a differs from b",
} as const;
export type Operator = keyof typeof OPERATORS;

export type Instruction =
  | { op: "set"; target: Path; value: Operand }
  | {
      op: "compute";
      target: Path;
      operator: Operator;
      left: Operand;
      right: Operand;
    }
  | { op: "swap"; list: Path; i: number; j: number }
  | { op: "append"; list: Path; value: Operand }
  | { op: "remove"; list: Path; index: number }
  /** Text from a language model, frozen as a literal for replay. */
  | { op: "text"; target: Path; text: string };

export function initialState(prompt: string): MachineState {
  if (!prompt.trim()) throw new Error("A nonempty prompt is required");
  const inputs = [...prompt.matchAll(/(?<![\w.])-?\d+(?!\.\d)(?!\w)/g)]
    .map((match) => Number(match[0]))
    .filter(Number.isSafeInteger);
  return { task: prompt, inputs, vars: {}, list: [], answer: null };
}

/** Jev's reference syntax: vars.n, list[2]. */
export function formatPath(path: Path) {
  return path
    .map((key, index) =>
      typeof key === "number" ? `[${key}]` : index === 0 ? key : `.${key}`,
    )
    .join("");
}

function jqPath(path: Path) {
  return path
    .map((key) => (typeof key === "number" ? `[${key}]` : `.${key}`))
    .join("");
}

export function getAt(state: MachineState, path: Path) {
  let value: Json | undefined = state as unknown as Json;
  for (const key of path) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<string, Json>)[key as string];
  }
  return value;
}

function setAt(state: MachineState, path: Path, value: Json) {
  const next = structuredClone(state);
  let parent = next as unknown as Record<string | number, Json>;
  for (const key of path.slice(0, -1))
    parent = parent[key] as unknown as Record<string | number, Json>;
  parent[path.at(-1)!] = value;
  return next;
}

function operandValue(state: MachineState, operand: Operand) {
  if (operand.kind === "literal") return operand.value;
  const value = getAt(state, operand.path);
  if (value === undefined)
    throw new Error(`Missing path ${formatPath(operand.path)}`);
  return value;
}

/** The value of a binary operation, or undefined when it is not valid. */
export function evaluate(operator: Operator, a: Json, b: Json) {
  if (typeof a !== "number" || typeof b !== "number") return undefined;
  switch (operator) {
    case "+":
      return a + b;
    case "-":
      return a - b;
    case "*":
      return a * b;
    // jq errors on division by zero; its / is floating point, so the jq
    // rendering applies floor to match.
    case "/":
      return b === 0 ? undefined : Math.floor(a / b);
    case "%":
      return b === 0 ? undefined : a % b;
    case "<":
      return a < b;
    case ">":
      return a > b;
    case "<=":
      return a <= b;
    case ">=":
      return a >= b;
    case "==":
      return a === b;
    case "!=":
      return a !== b;
  }
}

function listAt(state: MachineState, path: Path) {
  const list = getAt(state, path);
  if (!Array.isArray(list))
    throw new Error(`${formatPath(path)} is not a list`);
  return list;
}

/** Apply an instruction. It throws when the instruction is not valid now. */
export function apply(state: MachineState, instruction: Instruction) {
  const writable = (path: Path) => {
    if (path[0] === "task" || path[0] === "inputs")
      throw new Error(`${formatPath(path)} is read-only`);
  };
  switch (instruction.op) {
    case "set": {
      writable(instruction.target);
      const value = operandValue(state, instruction.value);
      if (
        instruction.target.length === 1 &&
        instruction.target[0] === "list" &&
        !Array.isArray(value)
      )
        throw new Error("list must remain a list");
      return setAt(state, instruction.target, value);
    }
    case "compute": {
      writable(instruction.target);
      const value = evaluate(
        instruction.operator,
        operandValue(state, instruction.left),
        operandValue(state, instruction.right),
      );
      if (
        value === undefined ||
        (typeof value === "number" && !Number.isSafeInteger(value))
      )
        throw new Error("Computation is not valid for these values");
      return setAt(state, instruction.target, value);
    }
    case "swap": {
      writable(instruction.list);
      const list = [...listAt(state, instruction.list)];
      const { i, j } = instruction;
      if (i === j || !(i in list) || !(j in list))
        throw new Error("Swap indices are out of range");
      [list[i], list[j]] = [list[j]!, list[i]!];
      return setAt(state, instruction.list, list);
    }
    case "append":
      writable(instruction.list);
      return setAt(state, instruction.list, [
        ...listAt(state, instruction.list),
        operandValue(state, instruction.value),
      ]);
    case "remove": {
      writable(instruction.list);
      const list = listAt(state, instruction.list);
      if (!(instruction.index in list))
        throw new Error("Remove index is out of range");
      return setAt(
        state,
        instruction.list,
        list.filter((_, index) => index !== instruction.index),
      );
    }
    case "text":
      writable(instruction.target);
      return setAt(state, instruction.target, instruction.text);
  }
}

function jqOperand(operand: Operand) {
  return operand.kind === "literal"
    ? JSON.stringify(operand.value)
    : jqPath(operand.path);
}

/** The instruction as a jq filter over the whole state. */
export function toJq(instruction: Instruction) {
  switch (instruction.op) {
    case "set":
      return `${jqPath(instruction.target)} = ${jqOperand(instruction.value)}`;
    case "compute": {
      const expression = `${jqOperand(instruction.left)} ${instruction.operator} ${jqOperand(instruction.right)}`;
      return `${jqPath(instruction.target)} = (${instruction.operator === "/" ? `(${expression}) | floor` : expression})`;
    }
    case "swap": {
      const list = jqPath(instruction.list);
      const [i, j] = [instruction.i, instruction.j];
      return `${list}[${i}] as $a | ${list}[${j}] as $b | ${list}[${i}] = $b | ${list}[${j}] = $a`;
    }
    case "append":
      return `${jqPath(instruction.list)} += [${jqOperand(instruction.value)}]`;
    case "remove":
      return `del(${jqPath(instruction.list)}[${instruction.index}])`;
    case "text":
      return `${jqPath(instruction.target)} = ${JSON.stringify(instruction.text)}`;
  }
}

/** A jq program that rebuilds the final state from the initial one. */
export function jqProgram(
  initial: MachineState,
  instructions: readonly Instruction[],
) {
  return [
    JSON.stringify(initial),
    ...instructions.map((instruction) => `| (${toJq(instruction)})`),
  ].join("\n");
}

function canonical(value: unknown) {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)),
        )
      : entry,
  );
}

/** Identify a state independent of key order. */
export function stateKey(state: MachineState) {
  return canonical(state);
}

/** Run a program with the jq binary. Returns null when jq is not installed. */
export async function runJq(program: string) {
  if (!Bun.which("jq")) return null;
  const process = Bun.spawn(["jq", "-n", "-c", program], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (code !== 0) throw new Error(`jq failed: ${stderr.trim()}`);
  return JSON.parse(stdout) as Json;
}

export function sameState(a: unknown, b: unknown) {
  return canonical(a) === canonical(b);
}
