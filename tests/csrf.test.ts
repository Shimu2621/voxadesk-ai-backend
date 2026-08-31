import { describe, expect, it } from "vitest";
import { hashToken, verifyCsrfTokens } from "../src/middleware/auth.js";

describe("session-bound CSRF protection", () => {
  const token = "fake-csrf-token";
  it("accepts only matching cookie, header, and server-side session hash", () => {
    expect(
      verifyCsrfTokens({
        cookie: token,
        header: token,
        expectedHash: hashToken(token),
      }),
    ).toBe(true);
  });
  it("rejects an attacker-chosen matching cookie/header pair", () => {
    expect(
      verifyCsrfTokens({
        cookie: "attacker-token",
        header: "attacker-token",
        expectedHash: hashToken(token),
      }),
    ).toBe(false);
  });
});
