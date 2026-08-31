import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const run = testDatabaseUrl ? describe : describe.skip;

vi.mock("../src/lib/redis.js", () => ({
  redis: {
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    ping: vi.fn().mockResolvedValue("PONG"),
  },
}));
vi.mock("../src/jobs/queues.js", () => {
  const queue = {
    getJobCounts: vi
      .fn()
      .mockResolvedValue({ waiting: 0, active: 0, delayed: 0, failed: 0 }),
  };
  return {
    queueNames: ["webhooks"],
    queues: { webhooks: queue },
    enqueue: vi.fn(),
    enqueueWebhook: vi.fn(),
    enqueueKnowledge: vi.fn(),
    enqueueOutboundWebhook: vi.fn(),
    enqueueNotification: vi.fn(),
  };
});

run("database-backed tenant isolation", () => {
  let prisma: typeof import("../src/lib/prisma.js").prisma;
  let app: typeof import("../src/app.js").app;
  let ownerA: ReturnType<typeof request.agent>;
  let ownerB: ReturnType<typeof request.agent>;
  let viewerA: ReturnType<typeof request.agent>;
  let csrfA: string;
  let csrfB: string;
  let csrfViewer: string;
  let orgA: string;
  let orgB: string;
  const userIds: string[] = [];
  let seeded = false;
  const suffix = randomBytes(6).toString("hex");
  const hash = (value: string) =>
    createHash("sha256").update(value).digest("hex");

  async function identity(
    role: "OWNER" | "VIEWER",
    organizationId: string,
    label: string,
  ) {
    const token = `session-${suffix}-${label}`;
    const csrf = `csrf-${suffix}-${label}`;
    const user = await prisma.user.create({
      data: {
        email: `${label}-${suffix}@example.test`,
        verifiedAt: new Date(),
        memberships: { create: { organizationId, role } },
        sessions: {
          create: {
            organizationId,
            tokenHash: hash(token),
            csrfHash: hash(csrf),
            expiresAt: new Date(Date.now() + 3_600_000),
          },
        },
      },
    });
    userIds.push(user.id);
    const agent = request.agent(app);
    agent.jar.setCookie(`voxadesk_session=${token}`);
    agent.jar.setCookie(`voxadesk_csrf=${csrf}`);
    return { agent, csrf };
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl!;
    process.env.AUTH_SECRET =
      "integration-test-auth-secret-at-least-32-characters";
    process.env.PROVIDER_MODE = "disabled";
    process.env.CREDENTIAL_ENCRYPTION_KEYS = JSON.stringify({
      v1: Buffer.alloc(32, 7).toString("base64"),
    });
    ({ prisma } = await import("../src/lib/prisma.js"));
    ({ app } = await import("../src/app.js"));
    const [a, b] = await Promise.all([
      prisma.organization.create({
        data: { name: "Tenant A", slug: `tenant-a-${suffix}` },
      }),
      prisma.organization.create({
        data: { name: "Tenant B", slug: `tenant-b-${suffix}` },
      }),
    ]);
    orgA = a.id;
    orgB = b.id;
    ({ agent: ownerA, csrf: csrfA } = await identity("OWNER", orgA, "owner-a"));
    ({ agent: ownerB, csrf: csrfB } = await identity("OWNER", orgB, "owner-b"));
    ({ agent: viewerA, csrf: csrfViewer } = await identity(
      "VIEWER",
      orgA,
      "viewer-a",
    ));
    seeded = true;
  }, 30_000);

  afterAll(async () => {
    if (!prisma || !seeded) return;
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.organization.deleteMany({
      where: { id: { in: [orgA, orgB] } },
    });
    await prisma.$disconnect();
  });

  it("derives organizationId from membership for writes and blocks cross-tenant reads", async () => {
    const created = await ownerA
      .post("/api/v1/contacts")
      .set("x-csrf-token", csrfA)
      .send({
        name: "Alice",
        email: "alice@example.test",
        organizationId: orgB,
      })
      .expect(201);
    expect(created.body.data.organizationId).toBe(orgA);
    await ownerB
      .get(`/api/v1/contacts?limit=100`)
      .expect(200)
      .expect(({ body }) => {
        expect(
          body.data.some(
            (item: { id: string }) => item.id === created.body.data.id,
          ),
        ).toBe(false);
      });
  });

  it("isolates pagination and contact merging, including escalation attempts", async () => {
    const ids: string[] = [];
    for (const name of ["One", "Two", "Three"]) {
      const response = await ownerA
        .post("/api/v1/contacts")
        .set("x-csrf-token", csrfA)
        .send({ name })
        .expect(201);
      ids.push(response.body.data.id);
    }
    const page = await ownerA.get("/api/v1/contacts?limit=2").expect(200);
    expect(page.body.data).toHaveLength(2);
    expect(page.body.nextCursor).toBeTruthy();
    const foreign = await ownerB
      .post("/api/v1/contacts")
      .set("x-csrf-token", csrfB)
      .send({ name: "Foreign" })
      .expect(201);
    await ownerA
      .post(`/api/v1/contacts/${ids[0]}/merge`)
      .set("x-csrf-token", csrfA)
      .send({ targetContactId: foreign.body.data.id })
      .expect(404);
    await viewerA
      .post(`/api/v1/contacts/${ids[0]}/merge`)
      .set("x-csrf-token", csrfViewer)
      .send({ targetContactId: ids[1] })
      .expect(403);
    await ownerA
      .post(`/api/v1/contacts/${ids[0]}/merge`)
      .set("x-csrf-token", csrfA)
      .send({ targetContactId: ids[1], reason: "fixture duplicate" })
      .expect(201);
  });

  it("blocks cross-tenant updates and deletes", async () => {
    const contact = await prisma.contact.create({
      data: { organizationId: orgB, name: "Tenant B Contact" },
    });
    const location = await prisma.location.create({
      data: { organizationId: orgB, name: "B", timezone: "UTC" },
    });
    const appointment = await prisma.appointment.create({
      data: {
        organizationId: orgB,
        contactId: contact.id,
        locationId: location.id,
        startAt: new Date("2030-01-01T10:00:00Z"),
        endAt: new Date("2030-01-01T11:00:00Z"),
        timezone: "UTC",
        source: "fixture",
      },
    });
    await ownerA
      .patch(`/api/v1/appointments/${appointment.id}`)
      .set("x-csrf-token", csrfA)
      .send({ status: "CANCELLED" })
      .expect(404);
    const hook = await prisma.outboundWebhook.create({
      data: {
        organizationId: orgB,
        url: "https://example.test/hook",
        eventTypesJson: ["test"],
        secretRef: "fake:v1",
      },
    });
    await ownerA
      .delete(`/api/v1/operations/outbound-webhooks/${hook.id}`)
      .set("x-csrf-token", csrfA)
      .expect(404);
    expect(
      (
        await prisma.outboundWebhook.findUniqueOrThrow({
          where: { id: hook.id },
        })
      ).active,
    ).toBe(true);
  });

  it("isolates operations APIs and webhook replay", async () => {
    const hook = await prisma.outboundWebhook.create({
      data: {
        organizationId: orgB,
        url: "https://example.test/hook-two",
        eventTypesJson: ["test"],
        secretRef: "fake:v1",
      },
    });
    const delivery = await prisma.webhookDelivery.create({
      data: {
        organizationId: orgB,
        outboundWebhookId: hook.id,
        eventId: `event-${suffix}`,
        eventType: "test",
        payloadSafeJson: {},
        status: "failed",
      },
    });
    await ownerA
      .get("/api/v1/operations/webhook-deliveries")
      .expect(200)
      .expect(({ body }) => {
        expect(
          body.data.some((item: { id: string }) => item.id === delivery.id),
        ).toBe(false);
      });
    await ownerA
      .post(`/api/v1/operations/webhook-deliveries/${delivery.id}/replay`)
      .set("x-csrf-token", csrfA)
      .expect(404);
    await ownerB
      .post(`/api/v1/operations/webhook-deliveries/${delivery.id}/replay`)
      .set("x-csrf-token", csrfB)
      .expect(202);
    await viewerA.get("/api/v1/operations/job-attempts").expect(403);
  });

  it("stores and rotates only encrypted, tenant-scoped fake credentials", async () => {
    const integration = await prisma.integration.create({
      data: { organizationId: orgA, type: "TWILIO", status: "connected" },
    });
    const stored = await ownerA
      .post("/api/v1/integrations/TWILIO/credentials")
      .set("x-csrf-token", csrfA)
      .send({ authToken: "fake-twilio-token" })
      .expect(201);
    expect(JSON.stringify(stored.body)).not.toContain("fake-twilio-token");
    const record = await prisma.integrationCredential.findFirstOrThrow({
      where: { integrationId: integration.id, active: true },
    });
    expect(record.ciphertext).not.toContain("fake-twilio-token");
    await ownerB
      .post("/api/v1/integrations/TWILIO/credentials")
      .set("x-csrf-token", csrfB)
      .send({ authToken: "fake-escalation-token" })
      .expect(404);
    const rotated = await ownerA
      .post("/api/v1/integrations/TWILIO/credentials/rotate")
      .set("x-csrf-token", csrfA)
      .send({})
      .expect(201);
    expect(rotated.body.data.version).toBe(2);
    expect(
      await prisma.integrationCredential.count({
        where: { integrationId: integration.id, active: true },
      }),
    ).toBe(1);
  });

  it("enforces incoming webhook idempotency at the database boundary", async () => {
    const event = {
      provider: "twilio",
      providerEventId: `fixture-${suffix}`,
      organizationId: orgA,
      type: "call.completed",
      status: "accepted",
      payloadSafeJson: { providerConversationId: "fake-call" },
    };
    await prisma.webhookEvent.create({ data: event });
    await expect(
      prisma.webhookEvent.create({ data: event }),
    ).rejects.toMatchObject({ code: "P2002" });
    expect(
      await prisma.webhookEvent.count({
        where: {
          provider: event.provider,
          providerEventId: event.providerEventId,
        },
      }),
    ).toBe(1);
  });
});
