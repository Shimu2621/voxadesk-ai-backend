import { z } from "zod";

export const outcomeSchema = z.enum([
  "booked",
  "rescheduled",
  "cancelled",
  "qualified_lead",
  "faq_resolved",
  "transferred",
  "callback_created",
  "abandoned",
  "failed",
  "unknown",
]);
export type NormalizedOutcome = z.infer<typeof outcomeSchema>;

const statusOrder = {
  STARTED: 0,
  IN_PROGRESS: 1,
  COMPLETED: 2,
  FAILED: 2,
} as const;
export type ConversationState = keyof typeof statusOrder;

export function nextConversationState(
  current: ConversationState,
  incoming: ConversationState,
): ConversationState {
  if (statusOrder[incoming] < statusOrder[current]) return current;
  if (
    statusOrder[incoming] === statusOrder[current] &&
    statusOrder[current] === 2
  )
    return current;
  return incoming;
}

const aliases: Record<string, NormalizedOutcome> = {
  appointment_booked: "booked",
  booking: "booked",
  lead: "qualified_lead",
  faq: "faq_resolved",
  transfer: "transferred",
  callback: "callback_created",
  error: "failed",
};
export function normalizeOutcome(
  value: string | null | undefined,
): NormalizedOutcome {
  if (!value) return "unknown";
  const normalized = value.trim().toLowerCase().replace(/[ -]+/g, "_");
  return outcomeSchema.safeParse(normalized).success
    ? (normalized as NormalizedOutcome)
    : (aliases[normalized] ?? "unknown");
}
