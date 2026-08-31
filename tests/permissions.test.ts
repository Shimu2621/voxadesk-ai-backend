import { describe, expect, it } from "vitest";
import { actions, can } from "../src/auth/permissions.js";

describe("deny-by-default permissions", () => {
  it("allows owners to perform every declared action", () => {
    for (const action of actions) expect(can("OWNER", action)).toBe(true);
  });

  it("prevents viewers from mutating and operators from publishing", () => {
    expect(can("VIEWER", "operations:write")).toBe(false);
    expect(can("VIEWER", "organization:update")).toBe(false);
    expect(can("OPERATOR", "agents:publish")).toBe(false);
    expect(can("MANAGER", "billing:manage")).toBe(false);
  });
});
