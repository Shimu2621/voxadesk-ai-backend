declare global {
  namespace Express {
    interface Request {
      requestId: string;
      auth?: { userId: string; organizationId: string; role: "OWNER" | "MANAGER" | "OPERATOR" | "VIEWER" };
    }
  }
}
export {};
