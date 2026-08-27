import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";

const createAgentSchema = z.object({
  name: z.string().trim().min(2).max(80),
  greeting: z.string().trim().min(5).max(500),
  voiceId: z.string().min(1),
  timezone: z.string().min(1),
});

export const agentsRouter = Router();
agentsRouter.use(requireAuth);
agentsRouter.get("/", async (req, res) => {
  const agents = await prisma.agent.findMany({ where: { organizationId: req.auth!.organizationId }, orderBy: { createdAt: "desc" } });
  res.json({ data: agents });
});
agentsRouter.post("/", async (req, res) => {
  const input = createAgentSchema.parse(req.body);
  const agent = await prisma.agent.create({ data: { organizationId: req.auth!.organizationId, name: input.name, draftConfig: input } });
  res.status(201).json({ data: agent });
});
