import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { Role } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

export const sessionCookieName = "voxadesk_session";
export const csrfCookieName = "voxadesk_csrf";
export const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");

export function verifyCsrfTokens(input: {
  cookie?: string;
  header?: string;
  expectedHash?: string;
}) {
  if (!input.cookie || !input.header || !input.expectedHash) return false;
  const cookieHash = Buffer.from(hashToken(input.cookie));
  const headerHash = Buffer.from(hashToken(input.header));
  const expectedHash = Buffer.from(input.expectedHash);
  return (
    cookieHash.length === headerHash.length &&
    cookieHash.length === expectedHash.length &&
    timingSafeEqual(cookieHash, headerHash) &&
    timingSafeEqual(cookieHash, expectedHash)
  );
}

export async function requireCsrf(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    next();
    return;
  }
  if (req.header("authorization")?.startsWith("Bearer ")) {
    next();
    return;
  }
  const cookie = req.cookies?.[csrfCookieName] as string | undefined;
  const header = req.header("x-csrf-token");
  const sessionToken = req.cookies?.[sessionCookieName] as string | undefined;
  const session = sessionToken
    ? await prisma.session.findFirst({
        where: {
          tokenHash: hashToken(sessionToken),
          expiresAt: { gt: new Date() },
        },
        select: { csrfHash: true },
      })
    : null;
  if (
    !verifyCsrfTokens({
      cookie,
      header: header ?? undefined,
      expectedHash: session?.csrfHash,
    })
  ) {
    res.status(403).json({
      code: "CSRF_INVALID",
      message: "A valid CSRF token is required.",
      requestId: req.requestId,
    });
    return;
  }
  next();
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const token = req.cookies?.[sessionCookieName] as string | undefined;
  if (!token) {
    res.status(401).json({
      code: "UNAUTHENTICATED",
      message: "Authentication is required.",
      requestId: req.requestId,
    });
    return;
  }
  const session = await prisma.session.findFirst({
    where: { tokenHash: hashToken(token), expiresAt: { gt: new Date() } },
    include: { user: { include: { memberships: true } } },
  });
  const organizationId = session?.organizationId;
  const membership = session?.user.memberships.find(
    (candidate) => candidate.organizationId === organizationId,
  );
  if (!session || !membership) {
    res.status(403).json({
      code: "FORBIDDEN",
      message: "You do not belong to this organization.",
      requestId: req.requestId,
    });
    return;
  }
  req.auth = {
    userId: session.userId,
    organizationId: session.organizationId,
    role: membership.role,
  };
  next();
}

export function requireRole(...allowed: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth || !allowed.includes(req.auth.role)) {
      res.status(403).json({
        code: "FORBIDDEN",
        message: "Your role cannot perform this action.",
        requestId: req.requestId,
      });
      return;
    }
    next();
  };
}
