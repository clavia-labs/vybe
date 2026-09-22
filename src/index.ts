import { config } from "./vybe/index.js";
import { jev } from "./providers/index.js";

// The public package defaults to Jev. Applications can replace it with
// config({ provider }) or pass a provider to state(...).
config({ provider: jev() });

export * from "./vybe/index.js";
export {
  JevProvider,
  PromptProvider,
  DeterministicProvider,
  MockProvider,
  ProviderAdapter,
  asProvider,
  jev,
} from "./providers/index.js";
export type {
  ProviderAnswer,
  ProviderQuestion,
  VybeProvider,
  PromptProviderOptions,
  JevProviderOptions,
  DeterministicResolver,
  MockValue,
} from "./providers/index.js";
