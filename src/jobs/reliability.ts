export const MAX_JOB_ATTEMPTS = 5;
export const BASE_BACKOFF_MS = 1_000;

export function exponentialBackoff(attempt: number) {
  if (!Number.isInteger(attempt) || attempt < 1)
    throw new Error("Attempt must be a positive integer.");
  return BASE_BACKOFF_MS * 2 ** (attempt - 1);
}

export function failureState(attempt: number, maxAttempts = MAX_JOB_ATTEMPTS) {
  return attempt >= maxAttempts ? "dead_letter" : "retrying";
}

export function assertJobTenant(
  jobOrganizationId: string | undefined,
  resourceOrganizationId: string,
) {
  if (!jobOrganizationId || jobOrganizationId !== resourceOrganizationId)
    throw new Error("JOB_TENANT_MISMATCH");
}

export class IdempotencyLedger {
  readonly #completed = new Set<string>();

  async once<T>(key: string, action: () => Promise<T>): Promise<T | undefined> {
    if (this.#completed.has(key)) return undefined;
    const result = await action();
    this.#completed.add(key);
    return result;
  }
}
