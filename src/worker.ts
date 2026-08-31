import { Worker, type Job } from "bullmq";
import { redis } from "./lib/redis.js";
import { logger } from "./lib/logger.js";
import { processWebhookEvent } from "./jobs/process-webhook.js";
import { prisma } from "./lib/prisma.js";
import { queueNames, type JobPayload, type QueueName } from "./jobs/queues.js";
import { processOutboundWebhook } from "./jobs/process-outbound-webhook.js";
import {
  aggregateUsage,
  analyzeConversation,
  processNotification,
  reconcileCalendar,
} from "./jobs/process-maintenance.js";
import { failureState } from "./jobs/reliability.js";
import { processKnowledgeSource } from "./jobs/process-knowledge.js";
import { incrementMetric } from "./lib/metrics.js";

async function handle(queue: QueueName, job: Job<JobPayload>) {
  if (
    queue === "conversation-ingestion" &&
    job.data.operation === "process-webhook"
  ) {
    await processWebhookEvent(job.data.resourceId);
    return;
  }
  if (
    queue === "conversation-analysis" &&
    job.data.operation === "analyze-conversation" &&
    job.data.organizationId
  ) {
    await analyzeConversation(job.data.organizationId, job.data.resourceId);
    return;
  }
  if (
    queue === "calendar-reconciliation" &&
    job.data.operation === "reconcile-appointment" &&
    job.data.organizationId
  ) {
    await reconcileCalendar(job.data.organizationId, job.data.resourceId);
    return;
  }
  if (
    queue === "notifications" &&
    job.data.operation === "deliver-notification" &&
    job.data.organizationId
  ) {
    await processNotification(job.data.organizationId, job.data.resourceId);
    return;
  }
  if (
    queue === "analytics-aggregation" &&
    job.data.operation === "aggregate-usage" &&
    job.data.organizationId
  ) {
    await aggregateUsage(job.data.organizationId);
    return;
  }
  if (
    queue === "outbound-webhooks" &&
    job.data.operation === "deliver-webhook" &&
    job.data.organizationId
  ) {
    await processOutboundWebhook(job.data.organizationId, job.data.resourceId);
    return;
  }
  if (
    queue === "knowledge-ingestion" &&
    job.data.operation === "ingest-knowledge" &&
    job.data.organizationId
  ) {
    await processKnowledgeSource(job.data.organizationId, job.data.resourceId);
    return;
  }
  if (queue === "retention-cleanup" && job.data.operation === "expired-auth") {
    const now = new Date();
    await prisma.$transaction([
      prisma.session.deleteMany({ where: { expiresAt: { lt: now } } }),
      prisma.authToken.deleteMany({ where: { expiresAt: { lt: now } } }),
    ]);
    return;
  }
  throw new Error(`Unsupported ${queue} operation: ${job.data.operation}`);
}

const workers = queueNames.map(
  (queue) =>
    new Worker<JobPayload>(
      queue,
      async (job) => {
        const started = Date.now();
        const attempt = job.attemptsMade + 1;
        logger.info(
          {
            jobId: job.id,
            queue,
            attempt,
            organizationId: job.data.organizationId,
            operation: job.data.operation,
          },
          "Processing job",
        );
        try {
          await handle(queue, job);
          incrementMetric("queue_jobs_total", {
            queue,
            result: "completed",
            organizationId: job.data.organizationId,
          });
          await prisma.jobAttempt.upsert({
            where: {
              queue_jobId_attempt: { queue, jobId: String(job.id), attempt },
            },
            create: {
              organizationId: job.data.organizationId,
              queue,
              jobId: String(job.id),
              attempt,
              status: "completed",
              durationMs: Date.now() - started,
            },
            update: { status: "completed", durationMs: Date.now() - started },
          });
        } catch (error) {
          incrementMetric("queue_jobs_total", {
            queue,
            result: failureState(attempt, job.opts.attempts ?? 1),
            organizationId: job.data.organizationId,
          });
          const errorCode = error instanceof Error ? error.name : "UNKNOWN";
          await prisma.jobAttempt.upsert({
            where: {
              queue_jobId_attempt: { queue, jobId: String(job.id), attempt },
            },
            create: {
              organizationId: job.data.organizationId,
              queue,
              jobId: String(job.id),
              attempt,
              status: failureState(attempt, job.opts.attempts ?? 1),
              errorCode,
              durationMs: Date.now() - started,
            },
            update: {
              status: failureState(attempt, job.opts.attempts ?? 1),
              errorCode,
              durationMs: Date.now() - started,
            },
          });
          throw error;
        }
      },
      {
        connection: redis,
        lockDuration: 30_000,
        stalledInterval: 15_000,
        maxStalledCount: 2,
      },
    ),
);

workers.forEach((worker) =>
  worker.on("failed", (job, error) =>
    logger.error(
      { jobId: job?.id, queue: worker.name, attempt: job?.attemptsMade, error },
      "Job failed",
    ),
  ),
);
logger.info("VoxaDesk AI worker is ready");
