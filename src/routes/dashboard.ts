import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";

export const dashboardRouter = Router();
dashboardRouter.get("/", requireAuth, (req, res) => {
  res.json({ organization: { id: req.auth!.organizationId, name: "VoxaDesk AI Workspace" }, metrics: { totalConversations: 0, bookingRate: 0, qualifiedLeads: 0, unresolvedTasks: 0 } });
});
