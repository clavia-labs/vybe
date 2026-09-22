/** The JSON values that can be sent to a soft provider. */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** A rubric entry accepted by Jev and prompt based providers. */
export type RubricEntry = string | Record<string, unknown>;
export type Rubric = RubricEntry | Record<string, RubricEntry>;

export interface QuestionReference {
  path: string;
  value: unknown;
}

export interface LocalInstruction {
  name: string;
  value: unknown;
}

export type QuestionKind = "is" | "pick" | "rate";

export interface DecisionRequest {
  kind: QuestionKind;
  state: JsonObject;
  text: string;
  references: QuestionReference[];
  locals: LocalInstruction[];
  rubric?: Rubric;
}

/** Provider-specific answer. Adapters may attach any native fields they need. */
export interface NativeAnswer {
  [key: string]: unknown;
  /** Jev's noul probability. */
  noul?: number;
  value?: number;
  /** Choice and score fields used by Jev. */
  choice?: string;
  level?: string;
  score?: number;
  probabilities?: Record<string, number>;
  confidence?: number;
}

export interface Provider {
  decide?(request: DecisionRequest): Promise<NativeAnswer> | NativeAnswer;
  decideBatch?(
    requests: readonly DecisionRequest[],
  ): Promise<readonly NativeAnswer[]> | readonly NativeAnswer[];
}

export interface Handler {
  handle(
    request: DecisionRequest,
  ): NativeAnswer | undefined | Promise<NativeAnswer | undefined>;
  after?(
    request: DecisionRequest,
    answer: NativeAnswer,
  ): NativeAnswer | Promise<NativeAnswer>;
  /** A sampling policy. The innermost defined value wins. */
  sampling?: boolean;
  dispose(): void;
}

export interface StateOptions {
  provider?: Provider;
  handlers?: readonly Handler[];
}

export interface IsOptions {
  /** Optional two-way rubric for an `is` question. */
  rubric?: Rubric;
}

export type ChoiceResult<K extends string> = {
  choice: K;
  confidence: number;
  probabilities: Record<K, number>;
};

export type RateLevel<L extends string> = {
  level: L;
  summary?: string;
  signals?: readonly string[];
  [key: string]: unknown;
};

export type RateResult<L extends string> = {
  score: number;
  level: L;
  confidence: number;
  probabilities: Record<L, number>;
};

export type UnwrapKeys<T> = Extract<keyof T, string>;
