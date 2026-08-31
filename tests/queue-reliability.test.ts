import { describe, expect, it, vi } from "vitest";
import {
  assertJobTenant,
  exponentialBackoff,
  failureState,
  IdempotencyLedger,
  MAX_JOB_ATTEMPTS,
} from "../src/jobs/reliability.js";

describe("background-job reliability", () => {
  it("uses bounded exponential retry backoff and a terminal dead-letter state", () => {
    expect([1, 2, 3, 4, 5].map(exponentialBackoff)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000,
    ]);
    expect(failureState(MAX_JOB_ATTEMPTS - 1)).toBe("retrying");
    expect(failureState(MAX_JOB_ATTEMPTS)).toBe("dead_letter");
  });

  it("allows a retry after a worker crash but suppresses a completed duplicate", async () => {
    const ledger = new IdempotencyLedger();
    const externalAction = vi
      .fn()
      .mockRejectedValueOnce(new Error("worker crashed"))
      .mockResolvedValueOnce("confirmed");
    await expect(ledger.once("job-1", externalAction)).rejects.toThrow(
      "worker crashed",
    );
    await expect(ledger.once("job-1", externalAction)).resolves.toBe(
      "confirmed",
    );
    await expect(ledger.once("job-1", externalAction)).resolves.toBeUndefined();
    expect(externalAction).toHaveBeenCalledTimes(2);
  });

  it("keeps poison jobs retryable until they enter dead-letter state", async () => {
    const poison = vi.fn().mockRejectedValue(new Error("invalid payload"));
    for (let attempt = 1; attempt <= MAX_JOB_ATTEMPTS; attempt += 1) {
      await expect(poison()).rejects.toThrow("invalid payload");
      expect(failureState(attempt)).toBe(
        attempt === MAX_JOB_ATTEMPTS ? "dead_letter" : "retrying",
      );
    }
    expect(poison).toHaveBeenCalledTimes(MAX_JOB_ATTEMPTS);
  });

  it("rejects missing and cross-tenant job resource access", () => {
    expect(() => assertJobTenant(undefined, "org-a")).toThrow(
      "JOB_TENANT_MISMATCH",
    );
    expect(() => assertJobTenant("org-a", "org-b")).toThrow(
      "JOB_TENANT_MISMATCH",
    );
    expect(() => assertJobTenant("org-a", "org-a")).not.toThrow();
  });
});
