import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CredentialCipher } from "../src/security/credentials.js";

describe("provider credential encryption", () => {
  const oldKey = randomBytes(32).toString("base64");
  const newKey = randomBytes(32).toString("base64");
  it("encrypts fake credentials with authenticated encryption", () => {
    const cipher = new CredentialCipher({ v1: oldKey }, "v1");
    const encrypted = cipher.encrypt({ apiKey: "fake-provider-secret" });
    expect(encrypted.ciphertext).not.toContain("fake-provider-secret");
    expect(cipher.decrypt(encrypted)).toEqual({
      apiKey: "fake-provider-secret",
    });
    expect(() =>
      cipher.decrypt({
        ...encrypted,
        ciphertext: `${encrypted.ciphertext.slice(0, -2)}aa`,
      }),
    ).toThrow();
  });
  it("rotates safely while retaining versioned decryption", () => {
    const oldCipher = new CredentialCipher({ v1: oldKey }, "v1");
    const original = oldCipher.encrypt({ token: "fake-token" });
    const rotating = new CredentialCipher({ v1: oldKey, v2: newKey }, "v2");
    const rotated = rotating.rotate(original);
    expect(rotated.keyVersion).toBe("v2");
    expect(rotating.decrypt(rotated)).toEqual({ token: "fake-token" });
  });
});
