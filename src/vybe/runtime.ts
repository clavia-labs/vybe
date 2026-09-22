import { createRef, isRef, refMetadata, type Refs } from "./refs.js";
import type {
  ChoiceResult,
  DecisionRequest,
  JsonObject,
  NativeAnswer,
  Provider,
  RateResult,
  Rubric,
  StateOptions,
  UnwrapKeys,
} from "./types.js";

export type {
  ChoiceResult,
  DecisionRequest,
  NativeAnswer,
  Provider,
  RateResult,
  Rubric,
  StateOptions,
} from "./types.js";
export type { Ref, Refs } from "./refs.js";

type TemplateValues = readonly unknown[];
type RubricMap = Record<string, unknown>;

export interface OpenResponses {
  responses: {
    create(request: { model?: string; input: string }): Promise<{
      output_text?: string;
      [key: string]: unknown;
    }>;
  };
  model?: string;
}

interface BuiltQuestion {
  text: string;
  references: Array<{ path: string; value: unknown }>;
  locals: Array<{ name: string; value: unknown }>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function renderInterpolation(
  value: unknown,
  state: StateImpl,
  index: number,
  built: BuiltQuestion,
): string {
  if (isRef(value)) {
    const metadata = refMetadata(value)!;
    if (metadata.state !== state) {
      throw new Error(
        `The ref \`${metadata.path}\` belongs to a different state`,
      );
    }
    built.references.push({ path: metadata.path, value: metadata.value });
    return `\`${metadata.path}\``;
  }

  // A one-key object is a named, question-local instruction. This mirrors
  // Jev's instruction object while keeping the call site terse:
  // s.is`Does ${{ invoice }} match ${{ field }}?`.
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1) {
      const name = keys[0]!;
      built.locals.push({ name, value: value[name] });
      return `\`${name}\``;
    }
  }

  const name = `value_${index}`;
  built.locals.push({ name, value });
  if (typeof value === "string") return JSON.stringify(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function buildQuestion(
  strings: TemplateStringsArray,
  values: TemplateValues,
  state: StateImpl,
): BuiltQuestion {
  const built: BuiltQuestion = { text: "", references: [], locals: [] };
  for (let index = 0; index < strings.length; index += 1) {
    built.text += strings[index] ?? "";
    if (index < values.length)
      built.text += renderInterpolation(values[index], state, index + 1, built);
  }
  return built;
}

function confidence(probabilities: Record<string, number>): number {
  const values = Object.values(probabilities).filter((value) =>
    Number.isFinite(value),
  );
  if (values.length < 2) return values.length === 1 ? 1 : 0;
  const max = Math.max(...values);
  return (values.length * max - 1) / (values.length - 1);
}

function asAnswer(value: unknown): NativeAnswer {
  if (typeof value === "number") return { value };
  if (typeof value === "string") return { choice: value };
  if (value && typeof value === "object") return value as NativeAnswer;
  return {};
}

function normalizeIs(answer: NativeAnswer): number {
  const value =
    answer.noul ??
    answer.value ??
    (answer as { probability?: unknown }).probability;
  if (typeof value === "number") return Math.max(0, Math.min(1, value));
  if (answer.choice === "true" || answer.choice === "yes") return 1;
  if (answer.choice === "false" || answer.choice === "no") return 0;
  return 0;
}

function winner<K extends string>(
  probabilities: Record<K, number>,
  fallback: K,
): K {
  let best = fallback;
  let bestValue = -Infinity;
  for (const [key, raw] of Object.entries(probabilities)) {
    const value = Number(raw);
    if (value > bestValue) {
      best = key as K;
      bestValue = value;
    }
  }
  return best;
}

function normalizePick<K extends string>(
  answer: NativeAnswer,
  keys: readonly K[],
): ChoiceResult<K> {
  const given = answer.probabilities ?? {};
  const probabilities = {} as Record<K, number>;
  for (const key of keys) probabilities[key] = Number(given[key] ?? 0);
  const choice =
    typeof answer.choice === "string" && keys.includes(answer.choice as K)
      ? (answer.choice as K)
      : winner(probabilities, keys[0]!);
  if (Object.values(probabilities).every((value) => value === 0))
    probabilities[choice] = 1;
  return {
    choice,
    probabilities,
    confidence:
      typeof answer.confidence === "number"
        ? answer.confidence
        : confidence(probabilities),
  };
}

function normalizeRate<L extends string>(
  answer: NativeAnswer,
  levels: readonly L[],
): RateResult<L> {
  const given = answer.probabilities ?? {};
  const probabilities = {} as Record<L, number>;
  for (const level of levels) probabilities[level] = Number(given[level] ?? 0);
  const level =
    typeof answer.level === "string" && levels.includes(answer.level as L)
      ? (answer.level as L)
      : winner(probabilities, levels[0]!);
  if (Object.values(probabilities).every((value) => value === 0))
    probabilities[level] = 1;
  let score = typeof answer.score === "number" ? answer.score : Number.NaN;
  if (!Number.isFinite(score)) {
    const total = Object.values(probabilities).reduce<number>(
      (sum, value) => sum + Number(value),
      0,
    );
    score =
      total > 0
        ? levels.reduce(
            (sum, item, index) => sum + index * probabilities[item]!,
            0,
          ) / total
        : levels.indexOf(level);
  }
  return {
    score,
    level,
    probabilities,
    confidence:
      typeof answer.confidence === "number"
        ? answer.confidence
        : confidence(probabilities),
  };
}

function sampleKey(
  probabilities: Record<string, number>,
  rng: () => number,
): string | undefined {
  const entries = Object.entries(probabilities).filter(
    ([, value]) => Number.isFinite(value) && value > 0,
  );
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  if (total <= 0) return undefined;
  let remaining = Math.min(1 - Number.EPSILON, Math.max(0, rng())) * total;
  for (const [key, value] of entries) {
    remaining -= value;
    if (remaining <= 0) return key;
  }
  return entries.at(-1)?.[0];
}

let configuredProvider: Provider | undefined;
let configuredLLM: OpenResponses | undefined;

/** Configure the process default. State-level providers always take precedence. */
export function config(
  options: { provider?: Provider; llm?: OpenResponses } = {},
): void {
  if (options.provider !== undefined) configuredProvider = options.provider;
  if (options.llm !== undefined) configuredLLM = options.llm;
}

/** @deprecated Use `config({ provider })`. */
export const configure = config;

async function runInfer(
  input: string,
  state?: JsonObject,
  locals: readonly { name: string; value: unknown }[] = [],
): Promise<string> {
  if (!configuredLLM)
    throw new Error(
      "No LLM configured for infer(). Pass { llm } to config() before calling infer().",
    );
  const context = [
    state === undefined ? "" : `\n\nState:\n${JSON.stringify(state, null, 2)}`,
    locals.length === 0
      ? ""
      : `\n\nQuestion data:\n${JSON.stringify(
          Object.fromEntries(locals.map(({ name, value }) => [name, value])),
          null,
          2,
        )}`,
  ].join("");
  const response = await configuredLLM.responses.create({
    ...(configuredLLM.model === undefined
      ? {}
      : { model: configuredLLM.model }),
    input: `${input}${context}`,
  });
  if (typeof response.output_text !== "string")
    throw new Error("Open Responses provider returned no output_text");
  return response.output_text;
}

/** Run a conventional text-generation model without state. Prefer `state().infer`. */
export async function infer(
  strings: TemplateStringsArray,
  ...values: readonly unknown[]
): Promise<string> {
  let input = "";
  for (let index = 0; index < strings.length; index += 1) {
    input += strings[index] ?? "";
    if (index < values.length) {
      const value = values[index];
      input += typeof value === "string" ? value : JSON.stringify(value);
    }
  }
  return runInfer(input);
}

class Scheduler {
  private pending: Array<{
    request: DecisionRequest;
    resolve: (answer: NativeAnswer) => void;
    reject: (reason: unknown) => void;
  }> = [];
  private scheduled = false;

  constructor(private readonly state: StateImpl) {}

  enqueue(request: DecisionRequest): Promise<NativeAnswer> {
    return new Promise<NativeAnswer>((resolve, reject) => {
      this.pending.push({ request, resolve, reject });
      if (!this.scheduled) {
        this.scheduled = true;
        queueMicrotask(() => void this.flush());
      }
    });
  }

  private async flush(): Promise<void> {
    this.scheduled = false;
    const batch = this.pending.splice(0);
    if (!batch.length) return;
    try {
      const provider = this.state.provider ?? configuredProvider;
      if (!provider)
        throw new Error(
          "No Vybe provider configured. Pass { provider } to state() or call config().",
        );
      let answers: readonly NativeAnswer[];
      if (provider.decideBatch) {
        answers = await provider.decideBatch(
          batch.map(({ request }) => request),
        );
      } else if (provider.decide) {
        answers = await Promise.all(
          batch.map(({ request }) => provider.decide!(request)),
        );
      } else {
        throw new Error(
          "Vybe provider must implement decide() or decideBatch()",
        );
      }
      if (answers.length !== batch.length)
        throw new Error(
          `Vybe provider returned ${answers.length} answers for ${batch.length} questions`,
        );
      answers.forEach((answer, index) => {
        batch[index]!.resolve(asAnswer(answer));
      });
    } catch (error) {
      batch.forEach((item) => item.reject(error));
    }
  }
}

class Query<T> implements PromiseLike<T> {
  private promise?: Promise<T>;
  private nativePromise?: Promise<NativeAnswer>;
  constructor(
    private readonly state: StateImpl,
    private readonly request: DecisionRequest,
    private readonly convert: (answer: NativeAnswer) => T,
  ) {}
  private run(): Promise<T> {
    if (!this.promise) this.promise = this.native.then(this.convert);
    return this.promise;
  }
  // oxlint-disable-next-line unicorn/no-thenable -- Vybe queries intentionally integrate with await.
  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.run().then(onfulfilled ?? undefined, onrejected ?? undefined);
  }
  get native(): Promise<NativeAnswer> {
    if (!this.nativePromise)
      this.nativePromise = this.state.scheduler.enqueue(this.request);
    return this.nativePromise;
  }
}

type IsQuestion = Query<number> & ((rubric?: Rubric) => Query<number>);

function callableIs(state: StateImpl, question: BuiltQuestion): IsQuestion {
  const baseRequest = (rubric?: Rubric): DecisionRequest => ({
    kind: "is",
    state: state.value,
    text: question.text,
    references: question.references,
    locals: question.locals,
    ...(rubric === undefined ? {} : { rubric }),
  });
  const first = new Query(state, baseRequest(), normalizeIs);
  const callable = ((rubric?: Rubric) =>
    new Query(state, baseRequest(rubric), normalizeIs)) as IsQuestion;
  // oxlint-disable-next-line unicorn/no-thenable -- The tagged query is awaitable by design.
  callable.then = first.then.bind(first);
  Object.defineProperty(callable, "native", {
    configurable: false,
    enumerable: true,
    get: () => first.native,
  });
  return callable;
}

export interface State<T extends JsonObject> {
  readonly ref: Refs<T>;
  readonly is: IsTag;
  readonly pick: PickTag;
  readonly rate: RateTag;
  readonly infer: InferTag;
}

export interface IsTag {
  (strings: TemplateStringsArray, ...values: TemplateValues): IsQuestion;
}

export interface InferTag {
  (strings: TemplateStringsArray, ...values: TemplateValues): Promise<string>;
}

export interface PickTag {
  (
    strings: TemplateStringsArray,
    ...values: TemplateValues
  ): <O extends RubricMap>(options: O) => Query<ChoiceResult<UnwrapKeys<O>>>;
}

export interface RateTag {
  (
    strings: TemplateStringsArray,
    ...values: TemplateValues
  ): <
    L extends readonly (string | { level: string; [key: string]: unknown })[],
  >(
    levels: L,
  ) => Query<
    RateResult<
      L[number] extends string
        ? L[number]
        : Extract<L[number], { level: string }>["level"]
    >
  >;
}

class StateImpl<T extends JsonObject = JsonObject> implements State<T> {
  readonly ref: Refs<T>;
  readonly scheduler: Scheduler;
  constructor(
    readonly value: T,
    readonly provider?: Provider,
  ) {
    this.scheduler = new Scheduler(this);
    const root = {} as Refs<T>;
    for (const [key, entry] of Object.entries(this.value))
      (root as Record<string, unknown>)[key] = createRef(this, entry, key);
    this.ref = root;
  }

  readonly is: IsTag = ((
    strings: TemplateStringsArray,
    ...values: TemplateValues
  ) => callableIs(this, buildQuestion(strings, values, this))) as IsTag;
  readonly infer: InferTag = ((
    strings: TemplateStringsArray,
    ...values: TemplateValues
  ) => {
    const question = buildQuestion(strings, values, this);
    return runInfer(question.text, this.value, question.locals);
  }) as InferTag;
  readonly pick: PickTag = ((
    strings: TemplateStringsArray,
    ...values: TemplateValues
  ) => {
    const question = buildQuestion(strings, values, this);
    return <O extends RubricMap>(options: O) => {
      const keys = Object.keys(options) as Array<UnwrapKeys<O>>;
      const request: DecisionRequest = {
        kind: "pick",
        state: this.value,
        text: question.text,
        references: question.references,
        locals: question.locals,
        rubric: options as Rubric,
      };
      return new Query(this, request, (answer) => normalizePick(answer, keys));
    };
  }) as PickTag;
  readonly rate: RateTag = ((
    strings: TemplateStringsArray,
    ...values: TemplateValues
  ) => {
    const question = buildQuestion(strings, values, this);
    return <
      L extends readonly (string | { level: string; [key: string]: unknown })[],
    >(
      levels: L,
    ) => {
      const names = levels.map((entry) =>
        typeof entry === "string" ? entry : entry.level,
      ) as Array<
        L[number] extends string
          ? L[number]
          : Extract<L[number], { level: string }>["level"]
      >;
      const request: DecisionRequest = {
        kind: "rate",
        state: this.value,
        text: question.text,
        references: question.references,
        locals: question.locals,
        rubric: levels as unknown as Rubric,
      };
      return new Query(this, request, (answer) => normalizeRate(answer, names));
    };
  }) as RateTag;
}

export function state<T extends JsonObject>(
  value: T,
  options: StateOptions = {},
): State<T> {
  return new StateImpl(value, options.provider);
}

export type Random = () => number;

export function sample(probability: number, rng?: Random): boolean;
export function sample<K extends string>(
  result: ChoiceResult<K>,
  rng?: Random,
): K;
export function sample<L extends string>(
  result: RateResult<L>,
  rng?: Random,
): L;
export function sample(
  value: number | ChoiceResult<string> | RateResult<string>,
  rng: Random = Math.random,
): boolean | string {
  if (typeof value === "number") return rng() < Math.max(0, Math.min(1, value));
  const selected = sampleKey(value.probabilities, rng);
  if (selected !== undefined) return selected;
  return "choice" in value ? value.choice : value.level;
}
