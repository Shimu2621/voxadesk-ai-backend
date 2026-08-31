declare global {
  namespace Express {
    interface Request {
      requestId: string;
      auth?: {
        userId: string;
        organizationId: string;
        role: "OWNER" | "MANAGER" | "OPERATOR" | "VIEWER";
      };
      toolAuth?: {
        organizationId: string;
        agentVersionId: string;
        conversationId: string;
        scopes: Array<
          | "availability"
          | "appointments:create"
          | "appointments:update"
          | "appointments:cancel"
          | "callbacks:create"
          | "transfer:create"
        >;
      };
    }
  }
}
export {};
