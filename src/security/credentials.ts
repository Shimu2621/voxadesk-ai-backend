import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";

const keyringSchema = z.record(z.string().min(1));
export type EncryptedCredential = {
  keyVersion: string;
  ciphertext: string;
  iv: string;
  authTag: string;
};

export class CredentialCipher {
  readonly #keys: Map<string, Buffer>;
  constructor(
    keys: Record<string, string>,
    readonly activeKeyVersion: string,
  ) {
    const parsed = keyringSchema.parse(keys);
    this.#keys = new Map(
      Object.entries(parsed).map(([version, encoded]) => {
        const key = Buffer.from(encoded, "base64");
        if (key.byteLength !== 32)
          throw new Error(`Credential key ${version} must decode to 32 bytes.`);
        return [version, key];
      }),
    );
    if (!this.#keys.has(activeKeyVersion))
      throw new Error("Active credential key is unavailable.");
  }
  encrypt(value: Record<string, string>): EncryptedCredential {
    const iv = randomBytes(12);
    const cipher = createCipheriv(
      "aes-256-gcm",
      this.#keys.get(this.activeKeyVersion)!,
      iv,
    );
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ]);
    return {
      keyVersion: this.activeKeyVersion,
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
    };
  }
  decrypt(value: EncryptedCredential): Record<string, string> {
    const key = this.#keys.get(value.keyVersion);
    if (!key) throw new Error("Credential key version is unavailable.");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(value.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(value.authTag, "base64"));
    return z
      .record(z.string())
      .parse(
        JSON.parse(
          Buffer.concat([
            decipher.update(Buffer.from(value.ciphertext, "base64")),
            decipher.final(),
          ]).toString("utf8"),
        ),
      );
  }
  rotate(value: EncryptedCredential) {
    return this.encrypt(this.decrypt(value));
  }
}

export function credentialCipherFromEnvironment(serialized?: string) {
  if (!serialized) return null;
  const keys = keyringSchema.parse(JSON.parse(serialized));
  const active = Object.keys(keys).sort().at(-1);
  return active ? new CredentialCipher(keys, active) : null;
}
