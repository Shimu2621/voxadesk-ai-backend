import { describe, expect, it } from "vitest";
import { safePublicUrlSchema } from "../src/security/url-policy.js";

describe("knowledge URL policy", () => {
  it.each([
    "http://localhost/admin",
    "http://127.0.0.1",
    "http://10.1.2.3",
    "http://169.254.169.254/latest",
    "http://192.168.1.2",
    "file:///etc/passwd",
    "https://user:pass@example.com",
  ])("rejects unsafe URL %s", (url) =>
    expect(safePublicUrlSchema.safeParse(url).success).toBe(false),
  );
  it("accepts and normalizes a public HTTPS URL", () =>
    expect(safePublicUrlSchema.parse("https://example.com/faq#pricing")).toBe(
      "https://example.com/faq",
    ));
});
