import type { Entitlements, PlanCode } from "../domain/entitlements.js";
import {
  entitlementAllows,
  planCodeSchema,
  plans,
} from "../domain/entitlements.js";
import { prisma } from "../lib/prisma.js";

export async function effectivePlan(organizationId: string): Promise<PlanCode> {
  const subscription = await prisma.subscription.findUnique({
    where: { organizationId },
    select: { planCode: true, status: true },
  });
  if (!subscription || !["active", "trialing"].includes(subscription.status))
    return "starter";
  return planCodeSchema.catch("starter").parse(subscription.planCode);
}

export async function checkEntitlement(
  organizationId: string,
  resource: keyof Entitlements,
  currentCount: number,
  requested = 1,
) {
  const planCode = await effectivePlan(organizationId);
  return {
    allowed: entitlementAllows(planCode, resource, currentCount, requested),
    planCode,
    limit: plans[planCode][resource],
    currentCount,
  };
}
