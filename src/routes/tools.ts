import { Router } from "express";
import { z } from "zod";

const availabilitySchema = z.object({
  organizationId: z.string().min(1),
  serviceId: z.string().min(1),
  locationId: z.string().min(1),
  timezone: z.string().min(1),
  dateFrom: z.coerce.date(),
  dateTo: z.coerce.date(),
});
const appointmentSchema = z.object({
  organizationId: z.string().min(1),
  slotToken: z.string().min(16),
  idempotencyKey: z.string().min(8),
  contact: z.object({ name: z.string().min(1), phone: z.string().min(7), email: z.string().email().optional() }),
});

export const toolsRouter = Router();
toolsRouter.post("/availability", (req, res) => {
  availabilitySchema.parse(req.body);
  res.json({ success: false, code: "CALENDAR_NOT_CONNECTED", message: "A calendar must be connected before availability can be checked.", slots: [] });
});
toolsRouter.post("/appointments", (req, res) => {
  appointmentSchema.parse(req.body);
  res.status(503).json({ success: false, code: "CALENDAR_NOT_CONNECTED", message: "The appointment was not created. Offer a callback instead." });
});
