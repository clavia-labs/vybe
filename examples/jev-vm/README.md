# Jev virtual machine

This experiment runs Jev as a virtual machine. It solves a prompt by letting Jev edit a JSON state, one step at a time. The state is Jev's memory. Each edit applies immediately, and the next question shows the new state. Every edit also renders as jq, so a run is a jq program that reproduces the final state without Jev.

## Run

Set `TYPESAFE_API_KEY` in the environment. Then supply a prompt:

```sh
bun run vm --prompt "sort numbers 9 -1 5 7" --temperature 0 \
  --jq .context/sort.jq --out .context/sort.json
```

Replay the edits with plain jq:

```sh
jq -n -f .context/sort.jq
```

The command prints each edit to stderr and ends with a summary line. `--jq` saves the program; without it, the program goes to stdout. `--out` saves the decisions, probabilities, states, and replay result. `--temperature` defaults to `1`; at `0`, each decision selects the highest-probability choice. With `OPENAI_API_KEY` set, Jev can also generate text through Vybez `infer`.

## State

```json
{
  "task": "sort numbers 9 -1 5 7",
  "inputs": [9, -1, 5, 7],
  "vars": {},
  "list": [],
  "answer": null
}
```

`task` is the prompt, and `inputs` holds the integers in it. Both are read-only. `vars` holds named values that Jev creates, such as `vars.n` or `vars.count`. `list` is a working list. `answer` holds the result, which can be a number, a list, or text. Jev's questions refer to fields with backtick paths, such as `` `list[2]` ``, which Jev resolves against the state it receives.

## Edits

| Edit | Example | jq |
| --- | --- | --- |
| Set a field | `` `list` = `inputs` `` | `.list = .inputs` |
| Compute a value | `` `vars.n` = `vars.n` / 2 `` | `.vars.n = ((.vars.n / 2) \| floor)` |
| Swap two list items | swap `` `list[0]` `` and `` `list[1]` `` | `.list[0] as $a \| .list[1] as $b \| .list[0] = $b \| .list[1] = $a` |
| Append to a list | append `` `vars.x` `` to `` `list` `` | `.list += [.vars.x]` |
| Remove a list item | remove `` `list[2]` `` | `del(.list[2])` |
| Generate text | `` `answer` `` = generated text | `.answer = "..."` |

Computations use `+`, `-`, `*`, `/` (rounded down), `%`, and the comparisons `<`, `>`, `<=`, `>=`, `==`, and `!=`. Operands are literals from `-1` through `10`, `100`, the prompt's integers, and any field in the state. There are no loops or branches. Jev is the control flow: it repeats edits and decides each step from the current values.

## Questions

Each step starts with one request that carries two questions about the same state:

- A yes-or-no question: does `answer` already hold the complete, correct answer? It is asked once `answer` is set. A yes ends the run.
- The first menu question: which edit comes next?

Later questions choose the edit's details: the operator, operands, target field, list, or pair of items. The menu is defined in [`menu.ts`](menu.ts). It follows these rules:

- Every offered option leads to an edit that is valid for the current state and changes it. Inputs are read-only, division by zero is excluded, and `list` remains a list. Edits that would leave the state unchanged are not offered, because a fast model otherwise repeats them.
- If an option turns out to have no such edits below it, the loop removes it and asks the previous question again.
- Options that complete an edit state its effect, such as `` `list` becomes [-1,9,5,7]. ``
- An option that recreates an earlier state says so.
- Option keys show current values, such as `` `vars.n` (6) ``.
- A question with one valid answer is answered without a model call.

Every question includes the shared instructions in [`run.ts`](run.ts), the state, `recentActions`, and `path`, the answers already given for the current edit.

## Replay

The program starts with the initial state and applies each edit in order:

```jq
{"task":"sort numbers 9 -1 5 7","inputs":[9,-1,5,7],"vars":{},"list":[],"answer":null}
| (.list = .inputs)
| (.list[0] as $a | .list[1] as $b | .list[0] = $b | .list[1] = $a)
| (.answer = .list)
```

After a run, the CLI executes the program with the `jq` binary and compares the result with the interpreter's final state. `replayMatches` is `null` when `jq` is not installed. Generated text is embedded as a string literal, so replay makes no model calls.

## Tests and evaluation

```sh
bun test examples/jev-vm
```

The tests check the machine against jq for every edit, random menu walks, effect descriptions, a scripted sort, the batched first request, and temperature sampling.

The live evaluation runs every case in [`eval.ts`](eval.ts) at temperatures `0` and `0.1`:

```sh
bun run vm:eval --out .context/jev-vm-eval
```

`--only sort-4,gcd` selects cases, and `--temperature` accepts a comma-separated list. The cases include arithmetic, factorial, sorting, text, Collatz, Euclid's algorithm, Fibonacci, digit sums, maximum, reversal, counting, and sums. Each result reports whether `answer` is correct, the status, the number of edits, and whether jq replay matched.

In two full evaluations on September 23, 2026, with Jev 1.13.0, 25 and 23 of 32 scored runs were correct. Arithmetic, sorting, text, Euclid's algorithm, digit sums, maximum, and counting succeeded in every run. Factorial and reversal succeeded in half the runs. Sum, Collatz, and Fibonacci failed: these tasks require Jev to track its position across many repeated edits. Every run replayed exactly with jq. Temperature `0` selects the most likely choice, but Jev's probabilities can vary between requests, so repeated runs can differ.
