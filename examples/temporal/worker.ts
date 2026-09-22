import { Worker } from "@temporalio/worker";
import * as activities from "./activities.js";

const worker = await Worker.create({
  workflowsPath: new URL("./workflow.ts", import.meta.url).pathname,
  activities,
  taskQueue: "vybe-support",
});

await worker.run();
