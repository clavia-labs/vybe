import { Connection, Client } from "@temporalio/client";
import type { Ticket } from "./activities.js";
import { routeTicket } from "./workflow.js";

const connection = await Connection.connect();
const client = new Client({ connection });
const ticket: Ticket = {
  id: "A-104",
  message: "I was charged twice. Please refund one of the charges.",
};

const handle = await client.workflow.start(routeTicket, {
  args: [ticket],
  taskQueue: "vybe-support",
  workflowId: `ticket-${ticket.id}`,
});

console.log(await handle.result());
