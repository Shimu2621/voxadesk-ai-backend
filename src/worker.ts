import { Worker } from "bullmq";
import { redis } from "./lib/redis.js";
import { logger } from "./lib/logger.js";

const worker = new Worker("conversation-ingestion", async (job) => {
  logger.info({ jobId: job.id, name: job.name }, "Processing conversation job");
}, { connection: redis });

worker.on("failed", (job, error) => logger.error({ jobId: job?.id, error }, "Job failed"));
logger.info("VoxaDesk AI worker is ready");
