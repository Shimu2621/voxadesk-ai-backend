import { isIP } from "node:net";
import { z } from "zod";

const blockedNames = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
]);
const blockedIpv4 = (host: string) => {
  const octets = host.split(".").map(Number);
  if (octets.length !== 4) return false;
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b !== undefined && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a !== undefined && a >= 224)
  );
};
const blockedIpv6 = (host: string) =>
  host === "::1" ||
  host === "::" ||
  host.toLowerCase().startsWith("fc") ||
  host.toLowerCase().startsWith("fd") ||
  host.toLowerCase().startsWith("fe80:");

export const safePublicUrlSchema = z
  .string()
  .url()
  .transform((value, context) => {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    if (
      !["http:", "https:"].includes(url.protocol) ||
      Boolean(url.username) ||
      Boolean(url.password) ||
      blockedNames.has(hostname) ||
      hostname.endsWith(".localhost") ||
      (isIP(hostname) === 4 && blockedIpv4(hostname)) ||
      (isIP(hostname) === 6 && blockedIpv6(hostname))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Only credential-free public HTTP(S) URLs are allowed.",
      });
      return z.NEVER;
    }
    url.hash = "";
    return url.toString();
  });
