# Vybe

**Typed judgment for TypeScript.**

Vybe lets ordinary TypeScript ask questions that need judgment and get back values that move through normal code: compare them, switch on them, pass them to functions, or combine them with exact computation. Questions are answered by [Jev](https://docs.typesafe.ai/concepts/system-one), a calibrated decision model, and every reference to state is checked by the TypeScript compiler.

```ts
import { state } from "vybe";

export async function route(ticket: Ticket, order: Order, policy: string) {
  const s = state({ ticket, order, refund_policy: policy });
  const { ticket: t } = s.ref;

  const refund = await s.is`Does ${t.messages[0].text} request a refund?`;

  if (refund > 0.9 && order.charges.length > 1) {
    return issueRefund(order);
  }

  const team = await s.pick`Which team should handle ${t}?`({
    billing: "Charges, invoices, and refunds",
    technical: "Bugs, outages, and integrations",
    human: "Needs human review",
  });

  if (team.confidence < 0.5) {
    return review(ticket);
  }

  switch (team.choice) {
    case "billing":
      return assign(ticket, "billing");
    case "technical":
      return assign(ticket, "technical");
    case "human":
      return review(ticket);
  }
}
```

There is no request object, response envelope, or question ID in application code. State is a value. Questions are asked of it, and mention parts of it through typed refs. The kind of question is the verb.

## State and refs

`state(value)` takes a JSON object and returns a **state**: an object with the verbs `is`, `pick`, and `rate`, and a `ref` property holding one **ref** per key of the value. A ref is a typed handle to one part of the state. `s.ref.ticket.messages[0].text` is a ref to that field, typed from the value you passed in, so a misspelled field is a compile error and a rename follows the field. Keeping refs under `ref` means a state key can be named anything, including `is`, and you destructure the refs you use.

```ts
const s = state({ ticket, order, refund_policy });
const { ticket: t, order: o } = s.ref;

t.messages[0].text; // Ref<string>
t.mesages; // error: Property 'mesages' does not exist
```

Every question is asked of a state, and the whole state is what the model reads. A question does not have to mention a field at all:

```ts
await s.is`Is the customer asking for a human agent?`;
```

When a question should point at a specific part of the state, interpolate a ref. Refs are the only way a question refers to state. A ref carries both the path and the value, and the provider adapter decides how to render it. Jev receives the complete state unchanged and a question that names the field by path, which is how the [Jev docs](https://docs.typesafe.ai/primitives#reference-specific-fields) recommend asking. A separate prompt provider can inline the value when you choose a conventional text model. Application code is the same in both cases.

```ts
s.is`Does ${t.messages[0].text} request a refund?`;

// Jev:     state = { ticket, order, refund_policy }
//          instructions = "Does `ticket.messages[0].text` request a refund?"
//          (the state is sent separately, unchanged)
// Prompt:  "Does \"I was charged twice for order A-104.\" request a refund?"
```

A ref used in a question must belong to the state the question is asked of. To compare two things, put both in one state, which is also what Jev needs, since it reads one state per request. `state` accepts any JSON object; wrap a plain string or array in an object so it has a name to reference.

## The verbs

Three methods on the state map one to one onto Jev's question types. Each is a tagged template with refs in the holes. `pick` and `rate` need a rubric, supplied by calling the result. `is` accepts an optional one.

| Verb | Jev type | Result |
| --- | --- | --- |
| `` await s.is`...` `` | noul | `number` from `0` to `1`, the probability of yes |
| ``await s.pick`...`(options)`` | choice | `{ choice, confidence, probabilities }` with `choice` typed as the union of option keys |
| ``await s.rate`...`(levels)`` | score | `{ score, level, confidence, probabilities }` with `level` typed as the union of level names |

```ts
const refund = await s.is`Does ${t.messages[0].text} request a refund?`;

const credential = await s.is`Does ${t.messages[0].text} request a credential?`(
  {
    true: {
      what: "Asks for a password, token, or key",
      examples: ["send me the API key"],
    },
    false: {
      what: "Mentions a credential without asking for it",
      examples: ["I reset my password"],
    },
  },
);

const team = await s.pick`Which team should handle ${t}?`({
  billing: {
    what: "Charges, invoices, refunds",
    not_for: "Delivery status",
    examples: ["I was charged twice"],
  },
  shipping: {
    what: "Delivery status, delays, lost packages",
    not_for: "Payment problems",
  },
});

const severity = await s.rate`How severe is the problem in ${t}?`([
  {
    level: "cosmetic",
    summary: "No impact to functionality",
    signals: ["typo", "alignment"],
  },
  {
    level: "degraded",
    summary: "Broken feature with a workaround",
    signals: ["works in another browser"],
  },
  {
    level: "blocking",
    summary: "No workaround exists",
    signals: ["cannot log in", "data loss"],
  },
]);

const urgency = await s.rate`How urgent is ${t}?`(["low", "medium", "high"]);
```

Every question is also an escape hatch to the provider response. Keep the query before awaiting it when you need model metadata, usage, or fields that Vybe does not normalize:

```ts
const query = s.pick`Which team should handle ${t}?`(teams);
const team = await query;
const native = await query.native();

console.log(team.choice);
console.log(native); // Jev's original answer, including probabilities and usage fields
```

The query is memoized, so reading `native()` after the typed result does not issue another request.

Rubrics accept exactly the [structure Jev does](https://docs.typesafe.ai/primitives/advanced): a description string, or an object with fields such as `what`, `not_for`, `examples`, `summary`, and `signals`. Vybe passes them through unchanged. The keys type the answer; the descriptions guide the model.

Choice options are an object because options have no order. Score levels are a tuple because the position in the list is the position on the scale, and Jev's score is computed from those positions. Each entry is either a plain name or an object whose `level` field names the level for the type and whose remaining fields are sent as the description. An unordered object is not accepted as levels. A misspelled `case` is a TypeScript error, and adding an option updates the type. Forgetting the rubric is also a type error, because the result of `` s.pick`...` `` alone is a function, not an answer.

## Reading the results

**Probability versus confidence.** `probabilities` is the full calibrated distribution over the options or levels, and it sums to one. `confidence` is one number derived from that distribution that says how concentrated it is on the winner. For a choice with `n` options the docs define it as `(n × max − 1) / (n − 1)`, so a uniform distribution is `0` no matter how many options there are, and a certain answer is `1`. The raw winning probability cannot do that, because its floor is `1 / n`. Use `probabilities` when you compute with the answer, such as a weighted risk score, a margin between the top two options, or an expected cost. Use `confidence` when you route, because a threshold like `0.9` means the same thing for a three-way question and a twelve-way one. The docs suggest acting automatically above `0.9`, proceeding with caution between `0.5` and `0.9`, and not guessing below `0.5`. `is` returns no confidence because with two outcomes the probability already carries it.

**Score versus level.** Jev's score answer is the expected value over the ordered levels: each level's index times its probability, summed, so it is fractional, like `1.43` for a distribution of `0`, `0.57`, `0.43` over three levels. `score` is the right value for numeric policy: thresholds such as `> 1.5`, sorting, or averaging across many items. `level` is the single most likely level, which Vybe derives from `probabilities`, and it is the right value for branching with a `switch`. They can disagree. A distribution split evenly between the lowest and highest levels has a score exactly in the middle, while the most likely levels are the extremes; that is a case where `confidence` is low and neither number should be trusted alone.

## Data alongside the question

Sometimes a question needs data that is not part of the shared state: a record to compare against, a schema, or a value your code just computed. Jev's `instructions` field accepts a JSON object for this, not only a string. The object's keys become names the question can reference, and the whole object is what the model reads as the question. This is how the docs write it:

```json
{
  "type": "noul",
  "instructions": {
    "field": {
      "name": "invoice_number",
      "type": "string",
      "description": "The identifier printed on the invoice."
    },
    "extracted_value": "4471",
    "question": "Does `extracted_value` match the `field`?"
  }
}
```

In Vybe, interpolate a one-key object literal. The key is the name; the value is the data:

```ts
await s.is`Does ${{ extracted_value }} match ${{ field }}?`;
```

That renders to the instructions object above for Jev, and inlines the values for a prompt provider. Question-local data goes in the instructions rather than the state so that many questions with different local data can still share one state and one request.

A bare value in a hole, such as `${"4471"}`, has no name. Vybe gives it a positional one like `value_1`, which the model cannot interpret, so name your data.

## Batching follows the state

Jev answers every question in one request in parallel, and adding questions barely changes latency. Vybe batches without a separate abstraction: questions asked of the same state object in the same tick are sent as one request.

```ts
const [refund, urgent, team] = await Promise.all([
  s.is`Does ${t.messages[0].text} request a refund?`,
  s.is`Does ${t} describe an outage?`,
  s.pick`Which team should handle ${t}?`(teams),
]);
```

Because extra questions are nearly free, ask speculatively. Ask for bug severity before knowing the ticket is a bug, and let your code ignore the answers it does not need.

Sequential code is sequential work. Two `await`s in a row are two requests, because the second question does not exist until the first has resolved. Dependent questions, such as walking a taxonomy one level at a time, are written as ordinary loops:

```ts
const catalog = state({ product });
let node = taxonomy;
while (node.children) {
  const next =
    await catalog.pick`Which branch best fits ${catalog.ref.product}?`(
      node.children,
    );
  node = node.children[next.choice];
}
```

## Handlers and `using`

A handler decides what happens at a question: call the provider, read a recording, return a fixed answer, or sample. Handlers are scoped, and TypeScript's `using` declaration opens a scope for a block:

```ts
import { mock, record, replay, sample } from "vybe";

test("duplicate charges are refunded", async () => {
  using _ = mock({
    "Does `ticket.messages[0].text` request a refund?": 0.97,
    "Which team should handle `ticket`?": "billing",
  });
  expect(await route(ticket, order, policy)).toEqual(refunded);
});

// record every answer of a run, then replay it without calling the provider
{
  await using _ = record("runs/incident-42.jsonl");
  await route(ticket, order, policy);
}
{
  await using _ = replay("runs/incident-42.jsonl");
  await route(ticket, order, policy);
}
```

`sample()` draws each answer from its probability distribution instead of taking the most likely one. A choice with probabilities `0.6` and `0.4` takes the second branch four times in ten. Use it to explore the behavior of a program under uncertainty, to generate varied test runs, or to A/B a policy:

```ts
{
  using _ = sample();
  await route(ticket, order, policy); // sampled
  {
    using _ = sample(false);
    await route(ticket, order, policy); // most likely
  }
  await route(ticket, order, policy); // sampled again
}
```

`sample()` sets a decision policy; it keeps the provider's probability distribution and changes which choice or level is selected at the call site. The innermost policy wins, so `sample(false)` inside a sampling scope restores the most likely answer for its block.

Scopes are tracked per async context with `AsyncLocalStorage` on Node and Bun, so two concurrent requests never see each other's handlers. Where no async context is available, pass handlers to `state(value, { handlers })`, which is also the portable form for library code.

`using` is a convenience for tests, recordings, and overrides, because those have block-shaped lifetimes. It is not used for batching, which is defined by the state and the tick, not by a block.

## Providers

The same question can be answered by different engines. Configuration chooses the provider; application code does not change.

- **Jev** receives the state once and questions that reference it by path. It is the default for `is`, `pick`, and `rate`.
- **Prompt-based models** receive the values inlined into the question text and a constrained output for the rubric.
- **Deterministic handlers** answer from rules, caches, or recordings, for tests and replay.
- **Human review** is a handler that suspends until a person answers.

Refs make this possible. Because a ref carries the path and the value, the adapter can name the field or inline it, whichever the provider needs.

Text generation and structured extraction are not part of the core. They want a prompt rather than a state and have a different cost model. If they are added later they will be separate verbs, not new result shapes on `is`, `pick`, and `rate`.

## Optional transform

Nothing above needs a build step. An optional `"use vybe"` directive and a syntax-only transform can add three things for functions that opt in:

- hoist independent questions above earlier `await`s so they join one request;
- assign stable site IDs from file, function, and question text for tracing and caching;
- report soft-site diagnostics in the editor, such as the last observed probability.

The transform never changes the meaning of the runtime API.

## Why not the Jev SDK directly

The [official SDK](https://docs.typesafe.ai/sdk/javascript) is the right choice when a program only needs to make one request and read one response. Vybe is a small authoring layer for programs that weave judgment through ordinary control flow:

- questions live beside the code that uses their answers;
- references to state are typed refs, checked by the compiler;
- answers unwrap to numbers and typed unions;
- batching follows the state instead of a hand-built request;
- handlers make tests, recordings, sampling, and overrides scoped and explicit;
- the same code runs against Jev or a prompt-based provider.

If those properties do not help a project, the SDK alone is simpler.

## Configuration

Vybe configures Jev by default. Set `TYPESAFE_API_KEY` and import `config` only when you need to replace the backing provider:

```ts
import { config, PromptProvider } from "vybe";

config({
  provider: new PromptProvider({
    generate: (prompt) => myModel.generate(prompt),
  }),
});
```

The provider can also be selected per state with `state(value, { provider })`, which takes precedence over the process configuration. Vybe passes the state to Jev as state; it does not turn Jev requests into prompts.

## Installation and status

The API in this document is implemented in this checkout. It is an early package and is not published yet.

```sh
bun add vybe
# or
npm install vybe
```

The package is built for Bun and modern TypeScript. `bun run check`, `bun test`, and `bun run build` are the repository checks. The Jev provider reads `TYPESAFE_API_KEY` from the environment; pass an explicit key to `jev({ apiKey })` when preferred.

The original JevScript compiler prototype has been removed. Vybe keeps the authoring surface in ordinary TypeScript, with the optional transform described above available as a future build-tool layer.

## License

TBD.
