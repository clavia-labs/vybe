import { describe, expect, it } from "bun:test";
import { jev, type Provider } from "../../src/index.js";
import { runInterpreter } from "./run.js";

/** Answers in order: numbers for is questions, keys for pick questions. */
function scripted(answers: (string | number)[]): Provider {
  let index = 0;
  return {
    decide(request) {
      const answer = answers[index++];
      if (request.kind === "is") {
        if (typeof answer !== "number")
          throw new Error(`Expected a probability, got ${answer}`);
        return { noul: answer };
      }
      const keys = Object.keys(request.rubric as Record<string, string>);
      if (typeof answer !== "string" || !keys.includes(answer))
        throw new Error(
          `Invalid scripted choice ${answer}; options: ${keys.join(" | ")}`,
        );
      return {
        choice: answer,
        probabilities: Object.fromEntries(
          keys.map((key) => [key, key === answer ? 1 : 0]),
        ),
      };
    },
  };
}

describe("Jev JSON interpreter", () => {
  it("sorts by editing its state and replays the edits with jq", async () => {
    const swap = (pair: string) => ["swap two list items", pair];
    const run = await runInterpreter("sort numbers 9 -1 5 7", {
      provider: scripted([
        // The only valid value for list is inputs, so it is not asked.
        "set a field",
        "`list` (now [])",
        ...swap("`list[0]` (9) with `list[1]` (-1)"),
        ...swap("`list[1]` (9) with `list[2]` (5)"),
        ...swap("`list[2]` (9) with `list[3]` (7)"),
        "set a field",
        "`answer` (now null)",
        "`list` ([-1,5,7,9])",
        // Complete: the batched action answer is discarded.
        0.9,
        "set a field",
      ]),
      temperature: 0,
    });
    expect(run.status).toBe("done");
    expect(run.answer).toEqual([-1, 5, 7, 9]);
    expect(run.steps.map(({ edit }) => edit)).toEqual([
      "`list` = `inputs`",
      "swap `list[0]` and `list[1]`",
      "swap `list[1]` and `list[2]`",
      "swap `list[2]` and `list[3]`",
      "`answer` = `list`",
    ]);
    expect(run.steps[1]!.decisions.at(-1)!.choices).toMatchObject({
      "`list[0]` (9) with `list[1]` (-1)": "`list` becomes [-1,9,5,7].",
    });
    expect(run.replayMatches).toBe(true);
    expect(run.program).toContain("| (.answer = .list)");
  });

  it("asks the completion check and the next edit in one request", async () => {
    const choices = [
      "compute a value",
      "+",
      "7",
      "5",
      "`answer` (now null)",
      "compute a value",
    ];
    const requests: {
      questions: Record<
        string,
        { type: string; criteria?: Record<string, string> }
      >;
    }[] = [];
    const provider = jev({
      apiKey: "test-key",
      fetch: async (_input, init) => {
        const request = JSON.parse(
          String(init?.body),
        ) as (typeof requests)[number];
        requests.push(request);
        const answers = Object.fromEntries(
          Object.entries(request.questions).map(([id, question]) => {
            if (question.type === "noul") return [id, { noul: 0.95 }];
            const choice = choices.shift()!;
            return [
              id,
              {
                choice,
                probabilities: Object.fromEntries(
                  Object.keys(question.criteria!).map((key) => [
                    key,
                    key === choice ? 1 : 0,
                  ]),
                ),
              },
            ];
          }),
        );
        return Response.json({ answers });
      },
    });
    const run = await runInterpreter("Calculate 7 plus 5.", {
      provider,
      temperature: 0,
    });
    expect(run.answer).toBe(12);
    expect(run.status).toBe("done");
    expect(requests).toHaveLength(6);
    expect(
      Object.values(requests.at(-1)!.questions).map(({ type }) => type),
    ).toEqual(["noul", "choice"]);
  });
});
