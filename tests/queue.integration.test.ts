import { Queue, QueueEvents, Worker } from "bullmq";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertJobTenant } from "../src/jobs/reliability.js";

const redisUrl = process.env.TEST_REDIS_URL;
const run = redisUrl ? describe : describe.skip;
const connection = redisUrl
  ? (() => {
      const url = new URL(redisUrl);
      return {
        host: url.hostname,
        port: Number(url.port || 6379),
        username: url.username || undefined,
        password: url.password || undefined,
        db: Number(url.pathname.slice(1) || 0),
      };
    })()
  : { host: "127.0.0.1", port: 6379 };

run("BullMQ reliability with Redis", () => {
  const resources: Array<Queue | QueueEvents | Worker> = [];
  const queueName = () => `plan2-integration-${crypto.randomUUID()}`;

  afterEach(async () => {
    for (const resource of resources.reverse()) await resource.close();
    resources.length = 0;
  });

  it("retries poison jobs and retains the terminal failed state", async () => {
    const name = queueName();
    const queue = new Queue(name, {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 10 },
        removeOnFail: false,
      },
    });
    const events = new QueueEvents(name, { connection });
    const handler = vi.fn().mockRejectedValue(new Error("poison fixture"));
    const worker = new Worker(name, handler, { connection });
    resources.push(queue, events, worker);
    await events.waitUntilReady();
    const job = await queue.add("poison", { organizationId: "org-a" });
    await expect(job.waitUntilFinished(events, 10_000)).rejects.toThrow();
    const retained = await queue.getJob(job.id!);
    expect(await retained!.getState()).toBe("failed");
    expect(retained!.attemptsMade).toBe(3);
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it("deduplicates stable job IDs and performs one confirmed external action", async () => {
    const name = queueName();
    const queue = new Queue(name, { connection });
    const events = new QueueEvents(name, { connection });
    resources.push(queue, events);
    await events.waitUntilReady();
    const first = await queue.add(
      "external",
      { organizationId: "org-a" },
      { jobId: "stable-action" },
    );
    const duplicate = await queue.add(
      "external",
      { organizationId: "org-a" },
      { jobId: "stable-action" },
    );
    expect(duplicate.id).toBe(first.id);
    const action = vi.fn().mockResolvedValue("provider-confirmed");
    const worker = new Worker(name, action, { connection });
    resources.push(worker);
    await expect(first.waitUntilFinished(events, 10_000)).resolves.toBe(
      "provider-confirmed",
    );
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("moves a cross-tenant job to a retained failed state", async () => {
    const name = queueName();
    const queue = new Queue(name, { connection });
    const events = new QueueEvents(name, { connection });
    const worker = new Worker(
      name,
      async (job) => assertJobTenant(job.data.organizationId, "org-b"),
      { connection },
    );
    resources.push(queue, events, worker);
    await events.waitUntilReady();
    const job = await queue.add(
      "tenant-check",
      { organizationId: "org-a" },
      { attempts: 1, removeOnFail: false },
    );
    await expect(job.waitUntilFinished(events, 10_000)).rejects.toThrow(
      "JOB_TENANT_MISMATCH",
    );
    expect(await (await queue.getJob(job.id!))!.getState()).toBe("failed");
  });
});
