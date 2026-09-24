import { config } from "./vybe/index.js";
import { jev, openai } from "./providers/index.js";

// Jev selects finite answers; OpenAI generates text for infer().
// Applications can replace either default through config().
config({ provider: jev(), llm: openai() });

export * from "./vybe/index.js";
export {
  JevProvider,
  PromptProvider,
  DeterministicProvider,
  MockProvider,
  ProviderAdapter,
  asProvider,
  jev,
  openai,
} from "./providers/index.js";
export type {
  ProviderAnswer,
  ProviderQuestion,
  VybeProvider,
  PromptProviderOptions,
  JevProviderOptions,
  OpenAIOptions,
  DeterministicResolver,
  MockValue,
} from "./providers/index.js";
