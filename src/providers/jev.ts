import type {
  ProviderAnswer,
  ProviderQuestion,
  VybeProvider,
} from "./types.js";
import type { DecisionRequest, NativeAnswer } from "../vybe/types.js";

export interface JevProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  fetch?: typeof globalThis.fetch;
  headers?: Record<string, string>;
}

type JevNativeAnswer = {
  type?: string;
  noul?: number;
  choice?: string;
  score?: number;
  probabilities?: Record<string, number>;
  confidence?: number;
  [key: string]: unknown;
};

function questionType(question: ProviderQuestion): "noul" | "choice" | "score" {
  if (question.kind === "is") return "noul";
  if (question.kind === "pick") return "choice";
  return "score";
}

function normalize(
  native: JevNativeAnswer,
  question: ProviderQuestion,
): ProviderAnswer {
  const answer: ProviderAnswer = { native };
  if (native.probabilities !== undefined)
    answer.probabilities = native.probabilities;
  if (native.confidence !== undefined) answer.confidence = native.confidence;
  if (question.kind === "is") {
    const probability =
      native.noul ??
      (typeof native.probability === "number" ? native.probability : undefined);
    if (probability !== undefined) answer.probability = probability;
  }
  if (question.kind === "pick" && native.choice !== undefined)
    answer.choice = native.choice;
  if (question.kind === "rate") {
    if (native.score !== undefined) answer.score = native.score;
    if (native.probabilities) {
      const level = Object.entries(native.probabilities).sort(
        (a, b) => b[1] - a[1],
      )[0]?.[0];
      if (level !== undefined) answer.level = level;
    }
  }
  return answer;
}

/** Jev/System One adapter. */
export class JevProvider implements VybeProvider {
  readonly name = "jev";
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly requestFetch: typeof globalThis.fetch;
  private readonly headers: Record<string, string>;

  constructor(options: JevProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY;
    this.baseUrl = (options.baseUrl ?? "https://api.typesafe.ai").replace(
      /\/$/,
      "",
    );
    this.model = options.model ?? process.env.JEV_MODEL ?? "jev-latest";
    this.requestFetch = options.fetch ?? globalThis.fetch;
    this.headers = options.headers ?? {};
    if (!this.requestFetch)
      throw new Error("A fetch implementation is required for JevProvider");
  }

  async execute(question: ProviderQuestion): Promise<ProviderAnswer> {
    const answers = await this.executeBatch([question]);
    const answer = answers[0];
    if (!answer) throw new Error("Jev returned no answer");
    return answer;
  }

  /** Compatibility methods for the public `state(..., { provider })` API. */
  async decide(request: DecisionRequest): Promise<NativeAnswer> {
    return toLegacy(await this.execute(fromLegacy(request)));
  }

  async decideBatch(
    requests: readonly DecisionRequest[],
  ): Promise<readonly NativeAnswer[]> {
    const answers = await this.executeBatch(requests.map(fromLegacy));
    return answers.map(toLegacy);
  }

  async executeBatch(
    questions: readonly ProviderQuestion[],
  ): Promise<readonly ProviderAnswer[]> {
    if (!this.apiKey)
      throw new Error("TYPESAFE_API_KEY is required for Jev execution");
    if (questions.length === 0) return [];
    const entries = questions.map((question, index) => {
      const id = question.id ?? `q${index}`;
      const body: Record<string, unknown> = {
        type: questionType(question),
        // Jev receives the original state separately. Instructions contain
        // only the question (or Jev's structured instruction object).
        instructions: question.prompt,
      };
      if (question.rubric !== undefined) body.criteria = question.rubric;
      return [id, body] as const;
    });
    // System One accepts one shared state and a map of named questions.
    const state = questions[0]!.state;
    const response = await this.requestFetch(`${this.baseUrl}/v1/systemone`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
        ...this.headers,
      },
      body: JSON.stringify({
        state,
        model: this.model,
        questions: Object.fromEntries(entries),
      }),
    });
    if (!response.ok)
      throw new Error(
        `Jev request failed (${response.status}): ${await response.text()}`,
      );
    const payload = (await response.json()) as {
      answers?: Record<string, JevNativeAnswer>;
    };
    if (!payload.answers)
      throw new Error("Jev response did not contain answers");
    return questions.map((question, index) => {
      const id = question.id ?? `q${index}`;
      const native = payload.answers?.[id];
      if (!native)
        throw new Error(`Jev response did not contain answers.${id}`);
      return normalize(native, question);
    });
  }
}

export function fromLegacy(request: DecisionRequest): ProviderQuestion {
  // Jev can reference fields in the shared state by path. Locals are encoded
  // as a structured instruction object, which also works for one-off values.
  const prompt =
    request.locals.length === 0
      ? request.text
      : Object.fromEntries([
          ...request.locals.map((local) => [local.name, local.value]),
          ["question", request.text],
        ]);
  return {
    kind: request.kind,
    state: request.state,
    prompt,
    references: request.references,
    locals: request.locals,
    ...(request.rubric === undefined ? {} : { rubric: request.rubric }),
  };
}

export function toLegacy(answer: ProviderAnswer): NativeAnswer {
  const native: NativeAnswer =
    answer.native && typeof answer.native === "object"
      ? { ...(answer.native as NativeAnswer) }
      : {};
  if (answer.probability !== undefined) native.noul = answer.probability;
  if (answer.choice !== undefined) native.choice = answer.choice;
  if (answer.score !== undefined) native.score = answer.score;
  if (answer.level !== undefined) native.level = answer.level;
  if (answer.probabilities !== undefined)
    native.probabilities = answer.probabilities;
  if (answer.confidence !== undefined) native.confidence = answer.confidence;
  return native;
}

export function jev(options?: JevProviderOptions): JevProvider {
  return new JevProvider(options);
}
