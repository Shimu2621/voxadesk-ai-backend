import { describe, expect, it } from "vitest";
import { maskEmail, maskPhone, maskTranscript } from "../src/security/pii.js";

describe("viewer PII masking", () => {
  it("preserves only the last four phone digits", () =>
    expect(maskPhone("+1 (212) 555-0199")).toBe("•••-•••-0199"));
  it("masks the local email part", () =>
    expect(maskEmail("caller@example.com")).toBe("c•••@example.com"));
  it("hides transcript content", () =>
    expect(maskTranscript("My address is private")).toBe(
      "[Transcript hidden by viewer policy]",
    ));
});
