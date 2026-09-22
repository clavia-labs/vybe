import type { DecisionRequest, NativeAnswer, Provider } from "../vybe/types.js";
import { fromLegacy, toLegacy } from "./jev.js";
import type { VybeProvider } from "./types.js";
import {
  BatchScheduler,
  type BatchSchedulerOptions,
} from "../scheduler/batch.js";

/**
 * Bridges the engine-neutral provider contract to Vybe's public State provider
 * contract. The adapter is useful for custom providers and makes the generic
 * BatchScheduler available to code that uses `state(..., { provider })`.
 */
export class ProviderAdapter implements Provider {
  private readonly scheduler: BatchScheduler;
  constructor(provider: VybeProvider, options?: BatchSchedulerOptions) {
    this.scheduler = new BatchScheduler(provider, options);
  }
  async decide(request: DecisionRequest): Promise<NativeAnswer> {
    return toLegacy(await this.scheduler.schedule(fromLegacy(request)));
  }
  async decideBatch(
    requests: readonly DecisionRequest[],
  ): Promise<readonly NativeAnswer[]> {
    return Promise.all(requests.map((request) => this.decide(request)));
  }
  /** Flush questions queued by callers that do not await them immediately. */
  flush(): Promise<void> {
    return this.scheduler.flush();
  }
}

export function asProvider(
  provider: VybeProvider,
  options?: BatchSchedulerOptions,
): ProviderAdapter {
  return new ProviderAdapter(provider, options);
}
