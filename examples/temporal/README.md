# Durable Vybe with Temporal

Temporal owns durability and replay. The workflow contains only deterministic control flow; the Vybe call runs in an activity and can be retried safely by Temporal.

Run a local Temporal server, set `TYPESAFE_API_KEY`, then start the worker and client in separate terminals:

```sh
bunx temporal server start-dev
bun run examples/temporal/worker.ts
bun run examples/temporal/client.ts
```

The activity creates a normal Vybe state and uses the configured Jev provider. Replace the provider with `config({ provider })` or pass one to `state()` when the activity needs a different backend.
