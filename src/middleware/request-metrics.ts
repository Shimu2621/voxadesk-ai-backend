import type { NextFunction, Request, Response } from "express";
import { incrementMetric } from "../lib/metrics.js";

export function requestMetrics(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const started = performance.now();
  res.once("finish", () => {
    const labels = {
      method: req.method,
      status: res.statusCode,
      organizationId: req.auth?.organizationId,
    };
    incrementMetric("http_requests_total", labels);
    incrementMetric(
      "http_request_duration_ms_total",
      labels,
      Math.max(0, Math.round(performance.now() - started)),
    );
  });
  next();
}
