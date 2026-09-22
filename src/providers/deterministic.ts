import type {
  ProviderAnswer,
  ProviderQuestion,
  VybeProvider,
} from "./types.js";

export type DeterministicResolver = (
  question: ProviderQuestion,
) => ProviderAnswer | Promise<ProviderAnswer>;

/** A tiny provider for tests, replay, and rules-based production handlers. */
export class DeterministicProvider implements VybeProvider {
  readonly name = "deterministic";
  constructor(private readonly resolver: DeterministicResolver) {}
  execute(question: ProviderQuestion): Promise<ProviderAnswer> {
    return Promise.resolve(this.resolver(question));
  }
  async executeBatch(
    questions: readonly ProviderQuestion[],
  ): Promise<readonly ProviderAnswer[]> {
    return Promise.all(questions.map((question) => this.execute(question)));
  }
}

export type MockValue = ProviderAnswer | number | string;

/** Convenient map-based mock. A missing key is an error, so tests do not silently pass. */
export class MockProvider extends DeterministicProvider {
  constructor(
    values:
      Record<string, MockValue> | ((question: ProviderQuestion) => MockValue),
  ) {
    super((question) => {
      const value =
        typeof values === "function"
          ? values(question)
          : values[promptToString(question)];
      if (value === undefined)
        throw new Error(
          `Mock provider has no answer for ${String(question.prompt)}`,
        );
      if (typeof value === "number")
        return question.kind === "is"
          ? { probability: value, native: value }
          : { score: value, native: value };
      if (typeof value === "string") return { choice: value, native: value };
      return value;
    });
  }
}

// Kept as a helper instead of adding methods to ProviderQuestion's public type.
function promptToString(question: ProviderQuestion): string {
  return typeof question.prompt === "string"
    ? question.prompt
    : JSON.stringify(question.prompt);
}
