import { Router } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { planCodeSchema, plans } from "../domain/entitlements.js";
import {
  providers,
  providersEnabled,
} from "../integrations/provider-factory.js";
import { audit } from "../lib/audit.js";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const billingProvider = providers.billing;
const returnUrlSchema = z
  .string()
  .url()
  .refine(
    (value) => new URL(value).origin === new URL(env.FRONTEND_URL).origin,
    "Return URL must use the configured frontend origin.",
  );
export const billingRouter = Router();
billingRouter.use(requireAuth);
billingRouter.get("/", async (req, res) => {
  const subscription = await prisma.subscription.findUnique({
    where: { organizationId: req.auth!.organizationId },
  });
  const planCode = planCodeSchema
    .catch("starter")
    .parse(subscription?.planCode);
  res.json({
    data: {
      subscription,
      planCode,
      entitlements: plans[planCode],
      providerMode: env.PROVIDER_MODE,
    },
  });
});
billingRouter.post("/checkout", requireRole("OWNER"), async (req, res) => {
  const input = z
    .object({ planCode: planCodeSchema, returnUrl: returnUrlSchema })
    .parse(req.body);
  if (!providersEnabled) {
    res.status(503).json({
      code: "PROVIDER_DISABLED",
      message: "Billing is disabled until Stripe is configured.",
    });
    return;
  }
  const result = await billingProvider.createCheckout({
    organizationId: req.auth!.organizationId,
    planCode: input.planCode,
    returnUrl: input.returnUrl,
  });
  if (!result.success) {
    res.status(503).json({ code: result.code, message: result.message });
    return;
  }
  await audit({
    organizationId: req.auth!.organizationId,
    actorId: req.auth!.userId,
    action: "billing.checkout_created",
    targetType: "subscription",
    metadata: { planCode: input.planCode },
  });
  res.status(201).json({ data: result.data });
});
billingRouter.post("/portal", requireRole("OWNER"), async (req, res) => {
  const { returnUrl } = z
    .object({ returnUrl: returnUrlSchema })
    .parse(req.body);
  const subscription = await prisma.subscription.findUnique({
    where: { organizationId: req.auth!.organizationId },
  });
  if (!subscription?.providerCustomerId) {
    res.status(409).json({
      code: "CUSTOMER_NOT_FOUND",
      message: "No billing customer exists for this organization.",
    });
    return;
  }
  if (!providersEnabled) {
    res.status(503).json({
      code: "PROVIDER_DISABLED",
      message: "Billing is disabled until Stripe is configured.",
    });
    return;
  }
  const result = await billingProvider.createPortal({
    customerId: subscription.providerCustomerId,
    returnUrl,
  });
  if (!result.success) {
    res.status(503).json({ code: result.code, message: result.message });
    return;
  }
  res.status(201).json({ data: result.data });
});
