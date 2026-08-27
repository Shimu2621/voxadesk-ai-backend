import { Router, raw } from "express";

export const webhooksRouter = Router();

// Provider-specific signature verification is intentionally a hard requirement
// before these endpoints enqueue any event.
webhooksRouter.post("/elevenlabs", raw({ type: "application/json", limit: "1mb" }), (_req, res) => res.status(501).json({ code: "WEBHOOK_NOT_CONFIGURED" }));
webhooksRouter.post("/twilio", raw({ type: "application/x-www-form-urlencoded", limit: "256kb" }), (_req, res) => res.status(501).json({ code: "WEBHOOK_NOT_CONFIGURED" }));
webhooksRouter.post("/stripe", raw({ type: "application/json", limit: "1mb" }), (_req, res) => res.status(501).json({ code: "WEBHOOK_NOT_CONFIGURED" }));
