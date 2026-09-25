import { afterEach, describe, expect, it, vi } from "vitest";
import { isProviderConfigured } from "../src/config/providers.js";

vi.mock("dotenv/config", () => ({}));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("independent provider configuration", () => {
  const stripe = {
    STRIPE_SECRET_KEY: "sk_test_fixture",
    STRIPE_WEBHOOK_SECRET: "whsec_fixture",
  };
  it("enables Stripe without unrelated providers", () => {
    expect(isProviderConfigured("STRIPE", stripe)).toBe(true);
    for (const provider of ["ELEVENLABS", "TWILIO", "GOOGLE_CALENDAR"] as const)
      expect(isProviderConfigured(provider, stripe)).toBe(false);
  });
  it.each([
    undefined,
    "",
    " ",
    "placeholder",
    "change-me",
    "your-secret",
    "<secret>",
  ])("rejects missing or placeholder credentials", (value) => {
    expect(
      isProviderConfigured("STRIPE", {
        ...stripe,
        STRIPE_WEBHOOK_SECRET: value,
      }),
    ).toBe(false);
  });
  it.each([
    [
      "ELEVENLABS",
      { ELEVENLABS_API_KEY: "fixture", ELEVENLABS_WEBHOOK_SECRET: "fixture" },
    ],
    ["TWILIO", { TWILIO_ACCOUNT_SID: "fixture", TWILIO_AUTH_TOKEN: "fixture" }],
    [
      "GOOGLE_CALENDAR",
      {
        GOOGLE_CLIENT_ID: "fixture",
        GOOGLE_CLIENT_SECRET: "fixture",
        GOOGLE_REFRESH_TOKEN: "fixture",
      },
    ],
    ["STRIPE", stripe],
  ] as const)("requires every %s setting", (provider, config) => {
    expect(isProviderConfigured(provider, config)).toBe(true);
    for (const key of Object.keys(config))
      expect(
        isProviderConfigured(provider, { ...config, [key]: undefined }),
      ).toBe(false);
  });

  function core(mode: string) {
    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://fixture:fixture@localhost:5432/fixture",
    );
    vi.stubEnv("AUTH_SECRET", "configuration-test-auth-secret-32-characters");
    vi.stubEnv("PROVIDER_MODE", mode);
    vi.stubEnv("MOCK_WEBHOOK_SECRET", undefined);
    for (const key of [
      "ELEVENLABS_API_KEY",
      "ELEVENLABS_WEBHOOK_SECRET",
      "TWILIO_ACCOUNT_SID",
      "TWILIO_AUTH_TOKEN",
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "GOOGLE_REFRESH_TOKEN",
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
    ])
      vi.stubEnv(key, undefined);
  }
  it("starts live mode with Stripe alone and leaves other adapters unavailable", async () => {
    core("live");
    vi.stubEnv("STRIPE_SECRET_KEY", stripe.STRIPE_SECRET_KEY);
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", stripe.STRIPE_WEBHOOK_SECRET);
    const { env } = await import("../src/config/env.js");
    expect(env.PROVIDER_MODE).toBe("live");
    const { providers } =
      await import("../src/integrations/provider-factory.js");
    const { StripeBillingProvider } =
      await import("../src/integrations/providers.js");
    expect(providers.billing).toBeInstanceOf(StripeBillingProvider);
    // The unavailable proxy implements every provider operation without network calls.
    for (const provider of [
      providers.voice,
      providers.telephony,
      providers.calendar,
    ]) {
      const result = await (
        provider as unknown as { check(): Promise<{ code: string }> }
      ).check();
      expect(result.code).toBe("NOT_CONFIGURED");
    }
  });
  it("does not construct Stripe with missing credentials", async () => {
    core("live");
    const { providers } =
      await import("../src/integrations/provider-factory.js");
    expect(
      await providers.billing.createPortal({
        customerId: "fixture",
        returnUrl: "http://localhost:3000",
      }),
    ).toMatchObject({ code: "NOT_CONFIGURED" });
  });
  it("preserves application secret validation", async () => {
    core("live");
    vi.stubEnv("AUTH_SECRET", "short");
    await expect(import("../src/config/env.js")).rejects.toThrow();
  });
  it("preserves database configuration validation", async () => {
    core("live");
    vi.stubEnv("DATABASE_URL", undefined);
    await expect(import("../src/config/env.js")).rejects.toThrow();
  });
  it("still requires a mock signing secret", async () => {
    core("mock");
    await expect(import("../src/config/env.js")).rejects.toThrow(
      "MOCK_WEBHOOK_SECRET is required",
    );
  });
  it.each(["mock", "disabled"])(
    "preserves %s provider selection",
    async (mode) => {
      core(mode);
      if (mode === "mock")
        vi.stubEnv(
          "MOCK_WEBHOOK_SECRET",
          "mock-configuration-test-secret-32-characters",
        );
      const { providers, providersEnabled } =
        await import("../src/integrations/provider-factory.js");
      expect(providersEnabled).toBe(mode === "mock");
      const result = await providers.billing.createPortal({
        customerId: "fixture",
        returnUrl: "http://localhost:3000",
      });
      expect(result.success).toBe(mode === "mock");
    },
  );
});
