import { z } from "zod";

export const planCodeSchema = z.enum(["starter", "growth", "agency"]);
export type PlanCode = z.infer<typeof planCodeSchema>;
export type Entitlements = {
  activeAgents: number;
  seats: number;
  locations: number;
  phoneNumbers: number;
  monthlyMinutes: number;
  concurrency: number;
  knowledgeBytes: number;
};
export const plans: Record<PlanCode, Entitlements> = {
  starter: {
    activeAgents: 1,
    seats: 3,
    locations: 1,
    phoneNumbers: 1,
    monthlyMinutes: 500,
    concurrency: 1,
    knowledgeBytes: 25 * 1024 * 1024,
  },
  growth: {
    activeAgents: 5,
    seats: 15,
    locations: 10,
    phoneNumbers: 10,
    monthlyMinutes: 5_000,
    concurrency: 5,
    knowledgeBytes: 250 * 1024 * 1024,
  },
  agency: {
    activeAgents: 50,
    seats: 250,
    locations: 100,
    phoneNumbers: 100,
    monthlyMinutes: 50_000,
    concurrency: 50,
    knowledgeBytes: 2 * 1024 * 1024 * 1024,
  },
};

export function entitlementAllows(
  planCode: PlanCode,
  resource: keyof Entitlements,
  currentCount: number,
  requested = 1,
): boolean {
  return currentCount + requested <= plans[planCode][resource];
}
