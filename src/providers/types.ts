/**
 * The small contract between Vybe's state runtime and an answer engine.
 *
 * Providers receive a complete state and a question.  They may answer one
 * question at a time, or implement `executeBatch` to answer all compatible
 * questions in one request (Jev's System One endpoint does this).
 */

export type QuestionKind = "is" | "pick" | "rate";

/** A JSON-like value. Providers should not mutate values they receive. */
export type ProviderValue =
  | null
  | boolean
  | number
  | string
  | ProviderValue[]
  | { [key: string]: ProviderValue };

export interface ProviderQuestion {
  /** Stable per-call identifier, assigned by the scheduler when omitted. */
  id?: string;
  kind: QuestionKind;
  state: unknown;
  /** The rendered question. Jev also accepts an instructions object. */
  prompt: string | Record<string, unknown>;
  references?: readonly { path: string; value: unknown }[];
  locals?: readonly { name: string; value: unknown }[];
  /** A choice object or ordered score levels, when the verb needs one. */
  rubric?: unknown;
  /** Optional model/provider options. These participate in batching. */
  options?: Record<string, unknown>;
}

export interface ProviderAnswer {
  /** Probability of the proposition being true, for `is`. */
  probability?: number;
  /** Selected key, for `pick`. */
  choice?: string;
  /** Expected ordered score, for `rate`. */
  score?: number;
  /** Provider distribution, keyed by choice or level. */
  probabilities?: Record<string, number>;
  /** Concentration of a categorical answer. */
  confidence?: number;
  /** Most likely level, for `rate`. */
  level?: string;
  /** The provider's original response, for escape hatches and debugging. */
  native?: unknown;
}

export interface VybeProvider {
  readonly name: string;
  execute(question: ProviderQuestion): Promise<ProviderAnswer>;
  executeBatch?(
    questions: readonly ProviderQuestion[],
  ): Promise<readonly ProviderAnswer[]>;
}

export function answerForKind(
  answer: ProviderAnswer,
  kind: QuestionKind,
): ProviderAnswer {
  if (kind === "is" && answer.probability === undefined) {
    // Jev calls this field `noul`; adapters should normally normalize it, but
    // this fallback makes custom providers pleasant to write.
    const native = answer.native as { noul?: unknown } | undefined;
    if (typeof native?.noul === "number")
      return { ...answer, probability: native.noul };
  }
  return answer;
}
