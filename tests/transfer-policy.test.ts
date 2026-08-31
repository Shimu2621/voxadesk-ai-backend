import { describe, expect, it } from "vitest";
import {
  isTransferAllowed,
  maskTransferDestination,
} from "../src/domain/transfer.js";

describe("transfer destination policy", () => {
  it("allows only an exact E.164 allowlist match", () => {
    expect(isTransferAllowed("+12125550199", ["+12125550199"])).toBe(true);
    expect(isTransferAllowed("+12125550198", ["+12125550199"])).toBe(false);
    expect(isTransferAllowed("tel:+12125550199", ["+12125550199"])).toBe(false);
  });
  it("stores only a masked destination", () =>
    expect(maskTransferDestination("+12125550199")).toBe("•••0199"));
});
