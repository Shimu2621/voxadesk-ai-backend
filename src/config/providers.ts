// Configuration presence is checked per provider. Actual credentials are verified
// by the provider; never supply fallback credentials for missing configuration.
const requirements = {
  ELEVENLABS: ["ELEVENLABS_API_KEY", "ELEVENLABS_WEBHOOK_SECRET"],
  TWILIO: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"],
  GOOGLE_CALENDAR: [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_REFRESH_TOKEN",
  ],
  STRIPE: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
} as const;

export function isProviderConfigured(
  provider: keyof typeof requirements,
  config: Partial<Record<string, unknown>>,
) {
  return requirements[provider].every((key) => {
    const value = config[key];
    return (
      typeof value === "string" &&
      value.trim().length > 0 &&
      !/^(?:placeholder|changeme|change-me|replace[-_].*|your[-_].*|<.*>)$/i.test(
        value.trim(),
      )
    );
  });
}
