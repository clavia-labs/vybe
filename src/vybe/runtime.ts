import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createRef, isRef, refMetadata, type Refs } from "./refs.js";
import type {
  ChoiceResult,
  DecisionRequest,
  Handler,
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
  Handler,
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

function sampleKey(probabilities: Record<string, number>): string | undefined {
  const entries = Object.entries(probabilities).filter(
    ([, value]) => Number.isFinite(value) && value > 0,
  );
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  if (total <= 0) return undefined;
  let remaining = Math.random() * total;
  for (const [key, value] of entries) {
    remaining -= value;
    if (remaining <= 0) return key;
  }
  return entries.at(-1)?.[0];
}

function applySampling(
  answer: NativeAnswer,
  request: DecisionRequest,
  sampling: boolean | undefined,
): NativeAnswer {
  if (!sampling || request.kind === "is" || !answer.probabilities)
    return answer;
  const selected = sampleKey(answer.probabilities);
  if (!selected) return answer;
  return request.kind === "pick"
    ? { ...answer, choice: selected }
    : { ...answer, level: selected };
}

const handlerStorage = new AsyncLocalStorage<readonly Handler[]>();
let configuredProvider: Provider | undefined;
let configuredLLM: OpenResponses | undefined;

function activeHandlers(stateHandlers: readonly Handler[] = []): Handler[] {
  return [...(handlerStorage.getStore() ?? []), ...stateHandlers];
}

function registerHandler(handler: Handler): void {
  handlerStorage.enterWith([...(handlerStorage.getStore() ?? []), handler]);
}

function unregisterHandler(handler: Handler): void {
  const local = handlerStorage.getStore();
  if (local)
    handlerStorage.enterWith(local.filter((entry) => entry !== handler));
}

/** Configure the process default. State-level providers always take precedence. */
export function config(
  options: { provider?: Provider; llm?: OpenResponses } = {},
): void {
  if (options.provider !== undefined) configuredProvider = options.provider;
  if (options.llm !== undefined) configuredLLM = options.llm;
}

/** @deprecated Use `config({ provider })`. */
export const configure = config;

/** Run a conventional text-generation model through an Open Responses client. */
export async function infer(
  strings: TemplateStringsArray,
  ...values: readonly unknown[]
): Promise<string> {
  if (!configuredLLM)
    throw new Error(
      "No LLM configured for infer(). Pass { llm } to config() before calling infer().",
    );
  let input = "";
  for (let index = 0; index < strings.length; index += 1) {
    input += strings[index] ?? "";
    if (index < values.length) {
      const value = values[index];
      input += typeof value === "string" ? value : JSON.stringify(value);
    }
  }
  const response = await configuredLLM.responses.create({
    ...(configuredLLM.model === undefined
      ? {}
      : { model: configuredLLM.model }),
    input,
  });
  if (typeof response.output_text !== "string")
    throw new Error("Open Responses provider returned no output_text");
  return response.output_text;
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
      const handlers = activeHandlers(this.state.handlers);
      const handled: Array<NativeAnswer | undefined> = [];
      for (const item of batch) {
        let answer: NativeAnswer | undefined;
        for (
          let index = handlers.length - 1;
          index >= 0 && answer === undefined;
          index -= 1
        ) {
          answer = await handlers[index]!.handle(item.request);
        }
        handled.push(answer);
      }
      const unanswered = batch
        .map((item, index) => ({ item, index }))
        .filter(({ index }) => handled[index] === undefined);
      if (unanswered.length) {
        const provider = this.state.provider ?? configuredProvider;
        if (!provider)
          throw new Error(
            "No Vybe provider configured. Pass { provider } to state() or call configure().",
          );
        let answers: readonly NativeAnswer[];
        if (provider.decideBatch) {
          answers = await provider.decideBatch(
            unanswered.map(({ item }) => item.request),
          );
        } else if (provider.decide) {
          answers = await Promise.all(
            unanswered.map(({ item }) => provider.decide!(item.request)),
          );
        } else {
          throw new Error(
            "Vybe provider must implement decide() or decideBatch()",
          );
        }
        if (answers.length !== unanswered.length)
          throw new Error(
            `Vybe provider returned ${answers.length} answers for ${unanswered.length} questions`,
          );
        answers.forEach((answer, index) => {
          handled[unanswered[index]!.index] = asAnswer(answer);
        });
      }
      for (const [index, item] of batch.entries()) {
        let answer = applySampling(
          asAnswer(handled[index]),
          item.request,
          [...handlers]
            .reverse()
            .find((handler) => handler.sampling !== undefined)?.sampling,
        );
        for (const handler of handlers) {
          if (handler.after) answer = await handler.after(item.request, answer);
        }
        item.resolve(answer);
      }
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
}

export interface IsTag {
  (strings: TemplateStringsArray, ...values: TemplateValues): IsQuestion;
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
    readonly handlers: readonly Handler[] = [],
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
  return new StateImpl(value, options.provider, options.handlers);
}

/** A scoped deterministic handler for tests and local development. */
export function mock(answers: Record<string, unknown>): Handler {
  const handler: Handler = {
    handle(request) {
      if (!(request.text in answers)) return undefined;
      return asAnswer(answers[request.text]);
    },
    dispose() {
      unregisterHandler(handler);
    },
  };
  registerHandler(handler);
  return handler;
}

function journalKey(request: DecisionRequest): string {
  return JSON.stringify([
    request.kind,
    request.state,
    request.text,
    request.references,
    request.locals,
    request.rubric,
  ]);
}

interface JournalEntry {
  key: string;
  request: DecisionRequest;
  answer: NativeAnswer;
}

type DisposableHandler = Handler & Disposable & AsyncDisposable;

function disposable(handler: Handler, close: () => void): DisposableHandler {
  const result = handler as DisposableHandler;
  result.dispose = close;
  result[Symbol.dispose] = close;
  result[Symbol.asyncDispose] = async () => close();
  registerHandler(result);
  return result;
}

/** Record provider answers as JSONL. The handler does not alter answers. */
export function record(path: string): DisposableHandler {
  const entries: JournalEntry[] = [];
  let closed = false;
  const handler: Handler = {
    handle: () => undefined,
    after(request, answer) {
      if (!closed) entries.push({ key: journalKey(request), request, answer });
      return answer;
    },
    dispose: () => undefined,
  };
  return disposable(handler, () => {
    if (closed) return;
    closed = true;
    const parent = dirname(path);
    if (parent !== ".") mkdirSync(parent, { recursive: true });
    writeFileSync(
      path,
      entries.map((entry) => JSON.stringify(entry)).join("\n") +
        (entries.length ? "\n" : ""),
      "utf8",
    );
    unregisterHandler(handler);
  });
}

/** Replay answers previously written by record(). */
export function replay(path: string): DisposableHandler {
  const entries = readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JournalEntry);
  const answers = new Map(entries.map((entry) => [entry.key, entry.answer]));
  const handler: Handler = {
    handle(request) {
      return answers.get(journalKey(request));
    },
    dispose: () => undefined,
  };
  return disposable(handler, () => unregisterHandler(handler));
}

/** Enable probability sampling for pick and rate answers in this scope. */
export function sample(enabled = true): DisposableHandler {
  const handler: Handler = {
    handle: () => undefined,
    sampling: enabled,
    dispose: () => undefined,
  };
  return disposable(handler, () => unregisterHandler(handler));
}
