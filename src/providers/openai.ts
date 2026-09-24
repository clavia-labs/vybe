import type { OpenResponses } from "../vybe/runtime.js";

export interface OpenAIOptions {
  apiKey?: string;
  model?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxOutputTokens?: number;
}

/** OpenAI Responses client for infer(). Decisions still use the Jev provider. */
export function openai(options: OpenAIOptions = {}): OpenResponses {
  const model = options.model ?? process.env.OPENAI_MODEL ?? "gpt-6-luna";
  const requestFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxOutputTokens = options.maxOutputTokens ?? 2048;
  for (const [name, value] of Object.entries({ timeoutMs, maxOutputTokens })) {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new RangeError(`${name} must be a positive safe integer`);
  }
  return {
    model,
    responses: {
      async create(request) {
        const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
        if (!apiKey)
          throw new Error("OPENAI_API_KEY is required for infer() execution");
        const response = await requestFetch(
          "https://api.openai.com/v1/responses",
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${apiKey}`,
              "content-type": "application/json",
            },
            signal: AbortSignal.timeout(timeoutMs),
            body: JSON.stringify({
              model: request.model ?? model,
              input: request.input,
              max_output_tokens: maxOutputTokens,
              store: false,
            }),
          },
        );
        if (!response.ok)
          throw new Error(`OpenAI request failed (${response.status})`);
        const payload = (await response.json()) as {
          status?: string;
          incomplete_details?: { reason?: string };
          output?: {
            type: string;
            content?: { type: string; text?: string }[];
          }[];
          [key: string]: unknown;
        };
        if (payload.status !== "completed")
          throw new Error(
            `OpenAI response did not complete: ${payload.status ?? "missing status"}${payload.incomplete_details?.reason ? ` (${payload.incomplete_details.reason})` : ""}`,
          );
        // Raw HTTP responses contain output items; output_text is an SDK helper.
        // Reasoning items can precede messages, and messages can have many parts.
        const parts = (payload.output ?? [])
          .filter((item) => item.type === "message")
          .flatMap((item) => item.content ?? [])
          .filter(
            (part) =>
              part.type === "output_text" && typeof part.text === "string",
          );
        if (parts.length === 0)
          throw new Error("OpenAI response contained no output text");
        return {
          ...payload,
          output_text: parts.map((part) => part.text).join(""),
        };
      },
    },
  };
}
