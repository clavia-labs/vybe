import { asProvider, MockProvider, state } from "../src/index.js";

const ticket = {
  id: "A-104",
  messages: [
    { text: "I was charged twice. Please refund one of the charges." },
  ],
};

const provider = asProvider(
  new MockProvider((question) => {
    if (question.kind === "is")
      return question.prompt.toString().includes("refund") ? 0.97 : 0.08;
    if (question.kind === "pick") return "billing";
    return {
      score: 0.9,
      level: "high",
      probabilities: { low: 0.1, high: 0.9 },
      confidence: 0.8,
    };
  }),
);

const support = state({ ticket }, { provider });
const { ticket: t } = support.ref;

const refund = support.is`Does ${t.messages[0].text} request a refund?`;
const team = support.pick`Which team should handle ${t}?`({
  billing: "Charges, invoices, and refunds",
  technical: "Bugs, outages, and integrations",
  human: "Needs human review",
});

const [refundProbability, assignment] = await Promise.all([refund, team]);
console.log({ refundProbability, assignment });

const severity = await support.rate`How severe is the problem in ${t}?`([
  { level: "low", summary: "The user can continue working" },
  { level: "high", summary: "The service is unusable" },
] as const);
console.log({ severity });
