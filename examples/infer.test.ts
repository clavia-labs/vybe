import { afterEach, describe, expect, it } from "bun:test";
import { config, openai, state } from "../src/index.js";

afterEach(() => config({ llm: openai() }));

const message = (text: string) => ({
  type: "message",
  content: [{ type: "output_text", text }],
});

describe("OpenAI-backed infer example", () => {
  it("sends state and refs to Luna and combines text across response items", async () => {
    config({
      llm: openai({
        apiKey: "test-key",
        model: "gpt-6-luna",
        maxOutputTokens: 128,
        fetch: async (url, init) => {
          expect(String(url)).toBe("https://api.openai.com/v1/responses");
          expect(new Headers(init?.headers).get("authorization")).toBe(
            "Bearer test-key",
          );
          const body = JSON.parse(String(init?.body));
          expect(body).toMatchObject({
            model: "gpt-6-luna",
            store: false,
            max_output_tokens: 128,
          });
          expect(body.input).toContain('"task": "Generate a greeting"');
          expect(body.input).toContain("`task`");
          expect(init?.signal).toBeInstanceOf(AbortSignal);
          return Response.json({
            status: "completed",
            output: [
              { type: "reasoning", summary: [] },
              message("Hello"),
              message(" world!"),
            ],
          });
        },
      }),
    });
    const s = state({ task: "Generate a greeting" });
    expect(await s.infer`Complete ${s.ref.task}`).toBe("Hello world!");
  });

  it("requires credentials at execution time", async () => {
    const llm = openai({
      apiKey: "",
      fetch: async () => {
        throw new Error("No request expected");
      },
    });
    await expect(llm.responses.create({ input: "Hello" })).rejects.toThrow(
      "OPENAI_API_KEY",
    );
  });

  it.each([401, 429, 500])(
    "propagates HTTP %s without exposing the response body",
    async (status) => {
      const llm = openai({
        apiKey: "test-key",
        fetch: async () => new Response("private response body", { status }),
      });
      await expect(llm.responses.create({ input: "Hello" })).rejects.toThrow(
        `OpenAI request failed (${status})`,
      );
    },
  );

  it("rejects partial output instead of treating it as a complete string", async () => {
    const llm = openai({
      apiKey: "test-key",
      fetch: async () =>
        Response.json({
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output: [message("partial")],
        }),
    });
    await expect(llm.responses.create({ input: "Hello" })).rejects.toThrow(
      "incomplete (max_output_tokens)",
    );
  });

  it("rejects a response without generated text", async () => {
    const llm = openai({
      apiKey: "test-key",
      fetch: async () =>
        Response.json({
          status: "completed",
          output: [
            {
              type: "message",
              content: [{ type: "refusal", refusal: "Cannot comply" }],
            },
          ],
        }),
    });
    await expect(llm.responses.create({ input: "Hello" })).rejects.toThrow(
      "no output text",
    );
  });

  it("preserves native metadata for direct client calls and allows custom clients", async () => {
    const llm = openai({
      apiKey: "test-key",
      fetch: async () =>
        Response.json({
          status: "completed",
          model: "gpt-6-luna",
          usage: { output_tokens: 2 },
          output: [message("Hello")],
        }),
    });
    expect(await llm.responses.create({ input: "Hello" })).toMatchObject({
      output_text: "Hello",
      model: "gpt-6-luna",
      usage: { output_tokens: 2 },
    });
    config({
      llm: {
        responses: { create: async () => ({ output_text: "Custom client" }) },
      },
    });
    expect(await state({}).infer`Hello`).toBe("Custom client");
  });
});
