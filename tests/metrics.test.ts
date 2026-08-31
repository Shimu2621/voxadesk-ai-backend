import { beforeEach, describe, expect, it } from "vitest";
import {
  incrementMetric,
  metricSnapshot,
  resetMetricsForTest,
} from "../src/lib/metrics.js";

describe("structured application metrics", () => {
  beforeEach(resetMetricsForTest);
  it("counts queue, webhook, provider, and reconciliation outcomes", () => {
    incrementMetric("queue_jobs_total", {
      organizationId: "org-a",
      result: "completed",
    });
    incrementMetric("webhook_events_total", {
      organizationId: "org-a",
      result: "duplicate",
    });
    incrementMetric("provider_failures_total", {
      organizationId: "org-b",
      provider: "calendar",
    });
    expect(metricSnapshot("org-a")).toHaveLength(2);
    expect(metricSnapshot("org-b")).toHaveLength(1);
  });
  it("increments existing label sets without storing payload or PII", () => {
    incrementMetric("http_requests_total", { method: "GET", status: 200 });
    incrementMetric("http_requests_total", { method: "GET", status: 200 });
    expect(metricSnapshot()).toEqual([
      {
        name: "http_requests_total",
        labels: "method=GET,status=200",
        value: 2,
      },
    ]);
  });
});
