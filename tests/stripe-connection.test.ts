import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";

vi.mock("../src/config/env.js", () => ({
  env: {
    PROVIDER_MODE: "live",
    STRIPE_SECRET_KEY: "fixture-key",
    STRIPE_WEBHOOK_SECRET: "fixture-webhook",
  },
}));
vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    session: { findFirst: vi.fn() },
    integration: { upsert: vi.fn(), findMany: vi.fn() },
    auditLog: { create: vi.fn() },
    providerHealth: { create: vi.fn() },
  },
}));
import { env } from "../src/config/env.js";
import { prisma } from "../src/lib/prisma.js";
import { hashToken, requireCsrf } from "../src/middleware/auth.js";
import { integrationsRouter } from "../src/routes/integrations.js";

const app = express();
app.use(express.json(), cookieParser());
app.use("/api/v1", requireCsrf);
app.use("/api/v1/integrations", integrationsRouter);
const record = {
  id: "integration-fixture",
  type: "STRIPE",
  status: "connected",
  configJson: { label: "Stripe" },
  encryptedCredentialRef: "environment",
};
const connect = () =>
  request(app)
    .post("/api/v1/integrations/live/STRIPE")
    .set(
      "Cookie",
      "voxadesk_session=session-fixture; voxadesk_csrf=csrf-fixture",
    )
    .set("x-csrf-token", "csrf-fixture");
function session(role = "OWNER") {
  vi.mocked(prisma.session.findFirst).mockResolvedValue({
    userId: "user-fixture",
    organizationId: "org-current",
    csrfHash: hashToken("csrf-fixture"),
    user: { memberships: [{ organizationId: "org-current", role }] },
  } as never);
}

describe("existing owner Stripe connection workflow", () => {
  it.each(["ELEVENLABS", "TWILIO", "GOOGLE_CALENDAR"])(
    "reports %s as unconfigured independently",
    async (type) => {
      const response = await request(app)
        .post(`/api/v1/integrations/live/${type}`)
        .set(
          "Cookie",
          "voxadesk_session=session-fixture; voxadesk_csrf=csrf-fixture",
        )
        .set("x-csrf-token", "csrf-fixture")
        .send({});
      expect(response.status).toBe(503);
      expect(response.body.code).toBe("PROVIDER_NOT_CONFIGURED");
      expect(prisma.integration.upsert).not.toHaveBeenCalled();
    },
  );
  beforeEach(() => {
    vi.clearAllMocks();
    env.PROVIDER_MODE = "live";
    env.STRIPE_SECRET_KEY = "fixture-key";
    session();
    vi.mocked(prisma.integration.upsert).mockResolvedValue(record as never);
  });
  it("connects only the session organization and returns safe fields", async () => {
    const response = await connect().send({
      label: "Stripe",
      organizationId: "org-other",
      secret: "untrusted-input",
    });
    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      data: {
        id: record.id,
        type: "STRIPE",
        status: "connected",
        configJson: record.configJson,
      },
    });
    expect(prisma.integration.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId_type: {
            organizationId: "org-current",
            type: "STRIPE",
          },
        },
        create: expect.objectContaining({
          organizationId: "org-current",
          type: "STRIPE",
          encryptedCredentialRef: "environment",
          configJson: { label: "Stripe" },
        }),
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: "org-current",
          action: "integration.live_connected",
        }),
      }),
    );
    expect(JSON.stringify(response.body)).not.toContain(env.STRIPE_SECRET_KEY!);
    expect(JSON.stringify(response.body)).not.toContain(
      env.STRIPE_WEBHOOK_SECRET!,
    );
  });
  it.each(["MANAGER", "OPERATOR", "VIEWER"])("rejects %s", async (role) => {
    session(role);
    expect((await connect().send({})).status).toBe(403);
    expect(prisma.integration.upsert).not.toHaveBeenCalled();
  });
  it("requires CSRF", async () => {
    const response = await request(app)
      .post("/api/v1/integrations/live/STRIPE")
      .set("Cookie", "voxadesk_session=session-fixture")
      .send({});
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("CSRF_INVALID");
    expect(prisma.integration.upsert).not.toHaveBeenCalled();
  });
  it("requires a session even with a bearer header", async () => {
    const response = await request(app)
      .post("/api/v1/integrations/live/STRIPE")
      .set("Authorization", "Bearer fixture")
      .send({});
    expect(response.status).toBe(401);
    expect(prisma.integration.upsert).not.toHaveBeenCalled();
  });
  it("rejects expired or invalid sessions", async () => {
    vi.mocked(prisma.session.findFirst).mockResolvedValue(null);
    expect((await connect().send({})).status).toBe(403);
    expect(prisma.integration.upsert).not.toHaveBeenCalled();
  });
  it.each(["mock", "disabled"] as const)(
    "does not connect live Stripe in %s mode",
    async (mode) => {
      env.PROVIDER_MODE = mode;
      expect((await connect().send({})).status).toBe(503);
      expect(prisma.integration.upsert).not.toHaveBeenCalled();
    },
  );
  it("fails closed without server credentials", async () => {
    env.STRIPE_SECRET_KEY = undefined;
    expect((await connect().send({})).status).toBe(503);
    expect(prisma.integration.upsert).not.toHaveBeenCalled();
  });
  it("lists integrations only for the current organization", async () => {
    vi.mocked(prisma.integration.findMany).mockResolvedValue([]);
    const response = await request(app)
      .get("/api/v1/integrations")
      .set("Cookie", "voxadesk_session=session-fixture");
    expect(response.status).toBe(200);
    expect(prisma.integration.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: "org-current" },
        select: expect.objectContaining({ id: true, type: true, status: true }),
      }),
    );
  });
});
