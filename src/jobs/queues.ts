import { Queue, type JobsOptions } from "bullmq";
import { redis } from "../lib/redis.js";
import { BASE_BACKOFF_MS, MAX_JOB_ATTEMPTS } from "./reliability.js";

export const queueNames = [
  "conversation-ingestion",
  "conversation-analysis",
  "knowledge-ingestion",
  "calendar-reconciliation",
  "notifications",
  "analytics-aggregation",
  "outbound-webhooks",
  "retention-cleanup",
] as const;
export type QueueName = (typeof queueNames)[number];
export type JobPayload = {
  organizationId?: string;
  resourceId: string;
  operation: string;
};
export const queueDefaults: JobsOptions = {
  attempts: MAX_JOB_ATTEMPTS,
  backoff: { type: "exponential", delay: BASE_BACKOFF_MS },
  removeOnComplete: 1_000,
  removeOnFail: false,
};
export const queues = Object.fromEntries(
  queueNames.map((name) => [
    name,
    new Queue<JobPayload>(name, {
      connection: redis,
      defaultJobOptions: queueDefaults,
    }),
  ]),
) as Record<QueueName, Queue<JobPayload>>;
export const webhookQueue = queues["conversation-ingestion"];

export async function enqueue(
  queue: QueueName,
  payload: JobPayload,
  jobId: string,
) {
  return queues[queue].add(payload.operation, payload, { jobId });
}

export async function enqueueWebhook(webhookEventId: string) {
  await enqueue(
    "conversation-ingestion",
    { resourceId: webhookEventId, operation: "process-webhook" },
    `webhook-${webhookEventId}`,
  );
}

export async function enqueueKnowledge(
  organizationId: string,
  knowledgeId: string,
) {
  await enqueue(
    "knowledge-ingestion",
    { organizationId, resourceId: knowledgeId, operation: "ingest-knowledge" },
    `knowledge-${knowledgeId}`,
  );
}

export async function enqueueOutboundWebhook(
  organizationId: string,
  deliveryId: string,
) {
  await enqueue(
    "outbound-webhooks",
    { organizationId, resourceId: deliveryId, operation: "deliver-webhook" },
    `outbound-${deliveryId}`,
  );
}
