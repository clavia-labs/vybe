import { describe, expect, it } from "bun:test";
import {
  asProvider,
  config,
  infer,
  JevProvider,
  mock,
  PromptProvider,
  record,
  replay,
  state,
  type DecisionRequest,
  type NativeAnswer,
  type Provider,
} from "../src/index.js";

function providerFor(
  answer: (request: DecisionRequest) => NativeAnswer,
): Provider & { batches: DecisionRequest[][] } {
  const batches: DecisionRequest[][] = [];
  return {
    batches,
    decideBatch: async (requests) => {
      batches.push([...requests]);
      return requests.map(answer);
    },
  };
}

describe("vybe state", () => {
  it("uses an Open Responses client for infer", async () => {
    let request: { model?: string; input: string } | undefined;
    config({
      llm: {
        model: "test-model",
        responses: {
          create: async (value) => {
            request = value;
            return { output_text: "A concise answer" };
          },
        },
      },
    });

    expect(await infer`Summarize ${"this ticket"}`).toBe("A concise answer");
    expect(request).toEqual({
      model: "test-model",
      input: "Summarize this ticket",
    });
  });

  it("keeps refs typed at runtime and batches a state tick", async () => {
    const provider = providerFor((request) =>
      request.kind === "is"
        ? { noul: 0.93 }
        : {
            choice: "billing",
            probabilities: { billing: 0.9, technical: 0.1 },
            confidence: 0.8,
          },
    );
    const support = state(
      { ticket: { message: "I was charged twice" } },
      { provider },
    );
    const { ticket } = support.ref;

    const refund = support.is`Does ${ticket.message} request a refund?`;
    const team = support.pick`Which team should handle ${ticket}?`({
      billing: "Charges and refunds",
      technical: "Bugs and integrations",
    });
    const [probability, assignment] = await Promise.all([refund, team]);

    expect(probability).toBe(0.93);
    expect(assignment.choice).toBe("billing");
    expect(assignment.confidence).toBe(0.8);
    expect(provider.batches).toHaveLength(1);
    expect(provider.batches[0]).toHaveLength(2);
    expect(provider.batches[0]?.[0]?.text).toContain("ticket.message");
  });

  it("supports ordered rate levels and native answers", async () => {
    const provider = providerFor(() => ({
      score: 1.4,
      level: "medium",
      probabilities: { low: 0.1, medium: 0.7, high: 0.2 },
      confidence: 0.7,
      providerField: "kept",
    }));
    const support = state(
      { ticket: { message: "The workaround is slow" } },
      { provider },
    );
    const query = support.rate`How severe is ${support.ref.ticket.message}?`([
      "low",
      "medium",
      "high",
    ] as const);

    expect((await query).level).toBe("medium");
    expect((await query).score).toBe(1.4);
    expect((await query.native).providerField).toBe("kept");
  });

  it("supports deterministic mock, recording, and replay handlers", async () => {
    const handler = mock({ "Does this message request a refund?": 0.99 });
    const first = state({ message: "Please refund this" });
    expect(await first.is`Does this message request a refund?`).toBe(0.99);
    handler.dispose();

    const path = ".context/vybe-test.jsonl";
    const recorder = record(path);
    const live = state(
      { message: "Please refund this" },
      { provider: providerFor(() => ({ noul: 0.88 })) },
    );
    expect(await live.is`Does this message request a refund?`).toBe(0.88);
    recorder.dispose();

    const replayer = replay(path);
    const replayed = state(
      { message: "Please refund this" },
      { provider: providerFor(() => ({ noul: 0.01 })) },
    );
    expect(await replayed.is`Does this message request a refund?`).toBe(0.88);
    replayer.dispose();
  });

  it("bridges the provider adapter", async () => {
    const provider = asProvider({
      name: "test",
      execute: async () => ({ probability: 0.76, native: { raw: true } }),
    });
    const s = state({ message: "hello" }, { provider });
    const q = s.is`Is this a greeting?`;
    expect(await q).toBe(0.76);
    expect((await q.native).raw).toBe(true);
  });

  it("serializes a Jev batch and preserves the native answer", async () => {
    let payload: unknown;
    const provider = new JevProvider({
      apiKey: "test-key",
      baseUrl: "https://jev.test",
      fetch: async (_input, init) => {
        payload = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            answers: {
              q0: { type: "noul", noul: 0.91 },
              q1: {
                type: "choice",
                choice: "billing",
                confidence: 0.9,
                probabilities: { billing: 0.9, technical: 0.1 },
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    const support = state(
      { ticket: { message: "I was charged twice" } },
      { provider },
    );
    const { ticket } = support.ref;
    const [refund, team] = await Promise.all([
      support.is`Does ${ticket.message} request a refund?`,
      support.pick`Which team should handle ${ticket}?`({
        billing: "Payments",
        technical: "Bugs",
      }),
    ]);

    expect(refund).toBe(0.91);
    expect(team.choice).toBe("billing");
    expect(payload).toMatchObject({
      model: "jev-latest",
      state: { ticket: { message: "I was charged twice" } },
      questions: {
        q0: { type: "noul" },
        q1: {
          type: "choice",
          criteria: { billing: "Payments", technical: "Bugs" },
        },
      },
    });
  });

  it("inlines refs for a prompt provider", async () => {
    let prompt = "";
    const provider = asProvider(
      new PromptProvider({
        generate: async (value) => {
          prompt = value;
          return "yes";
        },
      }),
    );
    const support = state(
      { ticket: { message: "Please refund this" } },
      { provider },
    );
    expect(
      await support.is`Does ${support.ref.ticket.message} request a refund?`,
    ).toBe(1);
    expect(prompt).toContain('"Please refund this"');
    expect(prompt).not.toContain("`ticket.message`");
  });
});
