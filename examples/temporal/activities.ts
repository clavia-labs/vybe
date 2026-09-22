import { state } from "../../src/index.js";

export type Ticket = {
  id: string;
  message: string;
};

/** Activities are the durable boundary: model calls happen outside workflow code. */
export async function classifyTicket(ticket: Ticket) {
  const s = state({ ticket });
  const { ticket: t } = s.ref;

  return s.pick`Which team should handle ${t.message}?`({
    billing: "Charges, invoices, and refunds",
    technical: "Bugs, outages, and integrations",
    human: "Needs human review",
  });
}
