import { config, jev, openai, state, type Provider } from "../../src/index.js";
import type { InferText } from "./run.js";

/** The Jev provider, and infer backed by OpenAI when OPENAI_API_KEY is set. */
export function setup(options: {
  model: string;
  inferModel: string;
  infer: boolean;
  fetch?: (provider: string) => typeof globalThis.fetch;
}): { provider: Provider; infer: InferText | undefined } {
  const provider = jev({
    model: options.model,
    ...(options.fetch ? { fetch: options.fetch("jev") } : {}),
  });
  if (!options.infer || !process.env.OPENAI_API_KEY)
    return { provider, infer: undefined };
  config({
    llm: openai({
      model: options.inferModel,
      ...(options.fetch ? { fetch: options.fetch("openai") } : {}),
    }),
  });
  return {
    provider,
    infer: async ({ task, state: machine, field }) => {
      const s = state({ task, machine, field });
      return s.infer`An interpreter is solving ${s.ref.task} by editing ${s.ref.machine}. It needs text to store in ${s.ref.field}. Write only that text: plain text with no quotes, markdown, or commentary. Supply prose only; the interpreter computes numbers and orderings itself.`;
    },
  };
}
