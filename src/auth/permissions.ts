import type { Role } from "@prisma/client";

export const actions = [
  "organization:read",
  "organization:update",
  "members:manage",
  "agents:read",
  "agents:write",
  "agents:publish",
  "operations:read",
  "operations:write",
  "billing:manage",
  "audit:read",
] as const;
export type Action = (typeof actions)[number];

const permissions: Record<Role, ReadonlySet<Action>> = {
  OWNER: new Set(actions),
  MANAGER: new Set([
    "organization:read",
    "organization:update",
    "agents:read",
    "agents:write",
    "agents:publish",
    "operations:read",
    "operations:write",
  ]),
  OPERATOR: new Set([
    "organization:read",
    "agents:read",
    "operations:read",
    "operations:write",
  ]),
  VIEWER: new Set(["organization:read", "agents:read", "operations:read"]),
};

export function can(role: Role, action: Action): boolean {
  return permissions[role].has(action);
}
