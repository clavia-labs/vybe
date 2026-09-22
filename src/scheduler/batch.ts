import type {
  ProviderAnswer,
  ProviderQuestion,
  VybeProvider,
} from "../providers/types.js";

export interface BatchSchedulerOptions {
  /** Maximum number of questions in one provider request. */
  maxBatchSize?: number;
  /** Override the grouping fingerprint (for redaction or tenant isolation). */
  stateKey?: (state: unknown) => string;
}

interface Pending {
  question: ProviderQuestion;
  promise: Promise<ProviderAnswer>;
  resolve: (answer: ProviderAnswer) => void;
  reject: (error: unknown) => void;
}

/** Stable JSON for grouping equal state values without a dependency. */
export function stableKey(value: unknown): string {
  const seen = new WeakSet<object>();
  const encode = (item: unknown): string => {
    if (item === null || typeof item !== "object")
      return JSON.stringify(item) ?? String(item);
    if (seen.has(item))
      throw new TypeError("Cannot fingerprint cyclic provider state");
    seen.add(item);
    let result: string;
    if (Array.isArray(item)) result = `[${item.map(encode).join(",")}]`;
    else {
      const record = item as Record<string, unknown>;
      result = `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${encode(record[key])}`)
        .join(",")}}`;
    }
    // A shared object is valid JSON and should fingerprint normally; only a
    // back-edge on the current recursion path is a cycle.
    seen.delete(item);
    return result;
  };
  return encode(value);
}

/**
 * Coalesces questions created in one JavaScript turn and sends compatible
 * questions to a provider in one batch. The scheduler is deliberately small:
 * the state runtime owns when to create it, while providers own wire format.
 */
export class BatchScheduler {
  private readonly maxBatchSize: number;
  private readonly stateKey: (state: unknown) => string;
  private readonly groups = new Map<string, Pending[]>();
  private readonly dedup = new Map<string, Pending>();
  private sequence = 0;
  private flushQueued = false;
  private flushing: Promise<void> | undefined;

  constructor(
    private readonly provider: VybeProvider,
    options: BatchSchedulerOptions = {},
  ) {
    this.maxBatchSize = Math.max(1, options.maxBatchSize ?? 64);
    this.stateKey = options.stateKey ?? stableKey;
  }

  schedule(input: ProviderQuestion): Promise<ProviderAnswer> {
    const question: ProviderQuestion = {
      ...input,
      id: input.id ?? `q${++this.sequence}`,
    };
    const grouping = `${this.provider.name}\n${this.stateKey(question.state)}\n${stableKey(question.options ?? {})}`;
    const dedupeKey = `${grouping}\n${question.kind}\n${stableKey(question.prompt)}\n${stableKey(question.rubric)}`;
    const existing = this.dedup.get(dedupeKey);
    if (existing) return existing.promise;
    let resolve!: (answer: ProviderAnswer) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<ProviderAnswer>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const pending: Pending = { question, promise, resolve, reject };
    const group = this.groups.get(grouping);
    if (group) group.push(pending);
    else this.groups.set(grouping, [pending]);
    this.dedup.set(dedupeKey, pending);
    if (!this.flushQueued) {
      this.flushQueued = true;
      queueMicrotask(() => {
        void this.flush();
      });
    }
    return promise;
  }

  /** Wait for all requests currently queued. Useful in tests and adapters. */
  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushQueued = false;
    const groups = Array.from(this.groups.values());
    this.groups.clear();
    this.dedup.clear();
    if (groups.length === 0) return;
    this.flushing = (async () => {
      try {
        for (const group of groups) {
          for (
            let offset = 0;
            offset < group.length;
            offset += this.maxBatchSize
          ) {
            await this.runBatch(
              group.slice(offset, offset + this.maxBatchSize),
            );
          }
        }
      } finally {
        this.flushing = undefined;
      }
    })();
    return this.flushing;
  }

  private async runBatch(batch: Pending[]): Promise<void> {
    try {
      const answers = this.provider.executeBatch
        ? await this.provider.executeBatch(
            batch.map((pending) => pending.question),
          )
        : await Promise.all(
            batch.map((pending) => this.provider.execute(pending.question)),
          );
      if (answers.length !== batch.length)
        throw new Error(
          `${this.provider.name} returned ${answers.length} answers for ${batch.length} questions`,
        );
      batch.forEach((pending, index) => pending.resolve(answers[index]!));
    } catch (error) {
      batch.forEach((pending) => pending.reject(error));
    }
  }
}
