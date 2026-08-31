import { describe, expect, it } from "vitest";
import {
  nextConversationState,
  normalizeOutcome,
} from "../src/domain/conversations.js";

describe("conversation event normalization", () => {
  it("does not regress terminal state for an out-of-order event", () => {
    expect(nextConversationState("COMPLETED", "IN_PROGRESS")).toBe("COMPLETED");
    expect(nextConversationState("FAILED", "STARTED")).toBe("FAILED");
  });
  it("does not replace one terminal state with a later peer state", () =>
    expect(nextConversationState("COMPLETED", "FAILED")).toBe("COMPLETED"));
  it("normalizes known aliases and safely maps unknown values", () => {
    expect(normalizeOutcome("Appointment Booked")).toBe("booked");
    expect(normalizeOutcome("something-new")).toBe("unknown");
  });
});
