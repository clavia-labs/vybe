import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "./activities.js";
import type { Ticket } from "./activities.js";

const { classifyTicket } = proxyActivities<typeof activities>({
  startToCloseTimeout: "1 minute",
});

/** Temporal replays this function; the non-deterministic Vybe call is an activity. */
export async function routeTicket(ticket: Ticket) {
  const assignment = await classifyTicket(ticket);
  if (assignment.confidence < 0.5) return { action: "review", assignment };
  return { action: "assign", team: assignment.choice, assignment };
}
