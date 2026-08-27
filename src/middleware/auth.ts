import type { NextFunction, Request, Response } from "express";

// Development authentication boundary. Replace this header adapter with verified
// cookie sessions before exposing the API publicly.
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const organizationId = req.header("x-organization-id");
  const userId = req.header("x-user-id");
  if (!organizationId || !userId) {
    res.status(401).json({ code: "UNAUTHENTICATED", message: "Authentication is required.", requestId: req.requestId });
    return;
  }
  req.auth = { userId, organizationId, role: "OWNER" };
  next();
}
