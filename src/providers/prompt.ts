import type {
  ProviderAnswer,
  ProviderQuestion,
  VybeProvider,
} from "./types.js";

export interface PromptProviderOptions {
  /** A text model call. It may return plain text or a parsed JSON value. */
  generate: (prompt: string, question: ProviderQuestion) => Promise<unknown>;
  name?: string;
}

function render(question: ProviderQuestion): string {
  const state = JSON.stringify(question.state, null, 2);
  const rubric =
    question.rubric === undefined
      ? ""
      : `\nRubric:\n${JSON.stringify(question.rubric, null, 2)}`;
  let prompt =
    typeof question.prompt === "string"
      ? question.prompt
      : JSON.stringify(question.prompt);
  for (const reference of question.references ?? []) {
    prompt = prompt
      .split(`\`${reference.path}\``)
      .join(JSON.stringify(reference.value));
  }
  for (const local of question.locals ?? []) {
    prompt = prompt
      .split(`\`${local.name}\``)
      .join(JSON.stringify(local.value));
  }
  return `${prompt}\n\nState:\n${state}${rubric}\n\nReturn only the answer.`;
}

function parse(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}

/** Adapter for a conventional text or JSON-generating model. */
export class PromptProvider implements VybeProvider {
  readonly name: string;
  private readonly generate: PromptProviderOptions["generate"];
  constructor(options: PromptProviderOptions) {
    this.name = options.name ?? "prompt";
    this.generate = options.generate;
  }
  async execute(question: ProviderQuestion): Promise<ProviderAnswer> {
    const raw = parse(await this.generate(render(question), question));
    if (question.kind === "is") {
      if (typeof raw === "number")
        return { probability: Math.max(0, Math.min(1, raw)), native: raw };
      if (typeof raw === "boolean")
        return { probability: raw ? 1 : 0, native: raw };
      const value = String(raw).toLowerCase();
      return {
        probability: value === "true" || value === "yes" ? 1 : 0,
        native: raw,
      };
    }
    if (question.kind === "pick") {
      if (typeof raw === "object" && raw !== null && "choice" in raw)
        return { ...(raw as ProviderAnswer), native: raw };
      return { choice: String(raw), native: raw };
    }
    if (typeof raw === "number") return { score: raw, native: raw };
    if (typeof raw === "object" && raw !== null && "score" in raw)
      return { ...(raw as ProviderAnswer), native: raw };
    const score = Number(raw);
    if (!Number.isFinite(score))
      throw new Error(
        `Prompt provider returned an invalid score: ${String(raw)}`,
      );
    return { score, native: raw };
  }
  async executeBatch(
    questions: readonly ProviderQuestion[],
  ): Promise<readonly ProviderAnswer[]> {
    // Prompt models do not necessarily support multi-question calls. Parallel
    // execution still preserves the scheduler contract and latency semantics.
    return Promise.all(questions.map((question) => this.execute(question)));
  }
}
