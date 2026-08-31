import { describe, expect, it } from "vitest";
import { entitlementAllows, plans } from "../src/domain/entitlements.js";

describe("server entitlements", () => {
  it("blocks only a new action beyond the limit", () => {
    expect(
      entitlementAllows("starter", "activeAgents", plans.starter.activeAgents),
    ).toBe(false);
    expect(entitlementAllows("starter", "activeAgents", 0)).toBe(true);
  });
  it("keeps plan limits ordered without provider price IDs", () =>
    expect(plans.growth.monthlyMinutes).toBeGreaterThan(
      plans.starter.monthlyMinutes,
    ));
});
