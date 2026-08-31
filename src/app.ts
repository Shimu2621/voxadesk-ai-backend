import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { pinoHttp } from "pino-http";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { requestContext } from "./middleware/request-context.js";
import { errorHandler } from "./middleware/error-handler.js";
import { agentsRouter } from "./routes/agents.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { toolsRouter } from "./routes/tools.js";
import { webhooksRouter } from "./routes/webhooks.js";
import { authRouter } from "./routes/auth.js";
import { workspaceRouter } from "./routes/workspace.js";
import { requireCsrf } from "./middleware/auth.js";
import { billingRouter } from "./routes/billing.js";
import { analyticsRouter } from "./routes/analytics.js";
import { integrationsRouter } from "./routes/integrations.js";
import { telephonyRouter } from "./routes/telephony.js";
import { rateLimit } from "./middleware/rate-limit.js";
import { operationsRouter } from "./routes/operations.js";
import { prisma } from "./lib/prisma.js";
import { redis } from "./lib/redis.js";
import { requestMetrics } from "./middleware/request-metrics.js";

export const app = express();
app.disable("x-powered-by");
app.use(requestContext);
app.use(requestMetrics);
app.use(pinoHttp({ logger }));
app.use(helmet());
app.use(cors({ origin: env.FRONTEND_URL, credentials: true }));
app.use(
  "/webhooks",
  rateLimit({ name: "webhook", limit: 600, windowSeconds: 60 }),
  webhooksRouter,
);
app.use(
  "/telephony",
  rateLimit({ name: "telephony", limit: 300, windowSeconds: 60 }),
  telephonyRouter,
);
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.get("/health", (_req, res) =>
  res.json({ status: "ok", service: "voxadesk-ai-backend" }),
);
app.get("/health/live", (_req, res) => res.json({ status: "ok" }));
app.get("/health/ready", async (_req, res) => {
  try {
    await Promise.all([prisma.$queryRaw`SELECT 1`, redis.ping()]);
    res.json({ status: "ready" });
  } catch {
    res.status(503).json({ status: "not_ready" });
  }
});
app.use(
  "/api/v1/auth",
  rateLimit({ name: "auth", limit: 30, windowSeconds: 60 }),
  authRouter,
);
app.use("/api/v1", requireCsrf);
app.use("/api/v1", workspaceRouter);
app.use("/api/v1/billing", billingRouter);
app.use("/api/v1/analytics", analyticsRouter);
app.use("/api/v1/integrations", integrationsRouter);
app.use("/api/v1/operations", operationsRouter);
app.use("/api/v1/dashboard", dashboardRouter);
app.use(
  "/api/v1/agents",
  rateLimit({ name: "agents", limit: 120, windowSeconds: 60 }),
  agentsRouter,
);
app.use(
  "/api/v1/tools",
  rateLimit({ name: "tools", limit: 180, windowSeconds: 60 }),
  toolsRouter,
);
app.use((_req, res) =>
  res.status(404).json({ code: "NOT_FOUND", message: "Route not found." }),
);
app.use(errorHandler);
