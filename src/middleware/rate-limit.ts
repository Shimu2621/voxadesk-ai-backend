import type { NextFunction, Request, Response } from "express";
import { redis } from "../lib/redis.js";
import { logger } from "../lib/logger.js";

export function rateLimit(options: {
  name: string;
  limit: number;
  windowSeconds: number;
}) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const identity = req.auth?.organizationId ?? req.ip ?? "unknown";
    const bucket = Math.floor(Date.now() / (options.windowSeconds * 1000));
    const key = `rate:${options.name}:${identity}:${bucket}`;
    try {
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, options.windowSeconds + 1);
      const remaining = Math.max(0, options.limit - count);
      res.setHeader("x-ratelimit-limit", options.limit);
      res.setHeader("x-ratelimit-remaining", remaining);
      if (count > options.limit) {
        res.setHeader("retry-after", options.windowSeconds);
        res.status(429).json({
          code: "RATE_LIMITED",
          message: "Too many requests. Try again later.",
          requestId: req.requestId,
        });
        return;
      }
      next();
    } catch (error) {
      logger.error(
        {
          error,
          requestId: req.requestId,
          operation: `rate-limit:${options.name}`,
        },
        "Rate limiter unavailable",
      );
      res.status(503).json({
        code: "RATE_LIMIT_UNAVAILABLE",
        message: "Request protection is temporarily unavailable.",
        requestId: req.requestId,
      });
    }
  };
}
