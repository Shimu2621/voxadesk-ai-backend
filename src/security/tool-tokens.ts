import { SignJWT, jwtVerify } from "jose";
import { z } from "zod";

const encoder = new TextEncoder();
const toolClaimsSchema = z.object({
  organizationId: z.string().cuid(),
  agentVersionId: z.string().cuid(),
  conversationId: z.string().cuid(),
  scopes: z.array(
    z.enum([
      "availability",
      "appointments:create",
      "appointments:update",
      "appointments:cancel",
      "callbacks:create",
      "transfer:create",
    ]),
  ),
});
export type ToolClaims = z.infer<typeof toolClaimsSchema>;

export async function signToolToken(
  claims: ToolClaims,
  secret: string,
  expiresInSeconds = 300,
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setAudience("voxadesk-tools")
    .setIssuer("voxadesk-ai")
    .setExpirationTime(`${expiresInSeconds}s`)
    .sign(encoder.encode(secret));
}

export async function verifyToolToken(
  token: string,
  secret: string,
): Promise<ToolClaims> {
  const verified = await jwtVerify(token, encoder.encode(secret), {
    audience: "voxadesk-tools",
    issuer: "voxadesk-ai",
    algorithms: ["HS256"],
  });
  return toolClaimsSchema.parse(verified.payload);
}

const slotClaimsSchema = z.object({
  organizationId: z.string().cuid(),
  serviceId: z.string().cuid(),
  locationId: z.string().cuid(),
  calendarId: z.string().min(1),
  startAt: z.string().datetime(),
  endAt: z.string().datetime(),
  timezone: z.string().min(1),
});
export type SlotClaims = z.infer<typeof slotClaimsSchema>;

export async function signSlotToken(
  claims: SlotClaims,
  secret: string,
  expiresInSeconds = 600,
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setAudience("voxadesk-slot")
    .setIssuer("voxadesk-ai")
    .setExpirationTime(`${expiresInSeconds}s`)
    .sign(encoder.encode(secret));
}

export async function verifySlotToken(
  token: string,
  secret: string,
): Promise<SlotClaims> {
  const verified = await jwtVerify(token, encoder.encode(secret), {
    audience: "voxadesk-slot",
    issuer: "voxadesk-ai",
    algorithms: ["HS256"],
  });
  return slotClaimsSchema.parse(verified.payload);
}
