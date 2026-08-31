import { describe, expect, it } from "vitest";
import { serializeError } from "../src/security/log-safety.js";

describe("structured log redaction", () => {
  it("serializes errors without arbitrary credential-bearing properties", () => {
    const error = Object.assign(new Error("provider failed"), {
      apiKey: "fake-secret-that-must-not-be-logged",
      requestBody: { email: "private@example.test" },
    });
    const serialized = JSON.stringify(serializeError(error));
    expect(serialized).not.toContain("fake-secret");
    expect(serialized).not.toContain("private@example.test");
    expect(serialized).toContain("provider failed");
  });
});
