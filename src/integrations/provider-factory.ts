import { env } from "../config/env.js";
import { isProviderConfigured } from "../config/providers.js";
import {
  ElevenLabsVoiceProvider,
  GoogleCalendarProvider,
  MockBillingProvider,
  MockCalendarProvider,
  MockTelephonyProvider,
  MockVoiceProvider,
  StripeBillingProvider,
  TwilioTelephonyProvider,
  type BillingProvider,
  type CalendarProvider,
  type TelephonyProvider,
  type VoiceProvider,
} from "./providers.js";

const unavailable = <T extends object>(name: string) =>
  new Proxy({} as T, {
    get: () => async () => ({
      success: false,
      code: "NOT_CONFIGURED",
      message: `${name} is not configured.`,
    }),
  });

export const providers: {
  voice: VoiceProvider;
  telephony: TelephonyProvider;
  calendar: CalendarProvider;
  billing: BillingProvider;
} =
  env.PROVIDER_MODE === "mock"
    ? {
        voice: new MockVoiceProvider(),
        telephony: new MockTelephonyProvider(),
        calendar: new MockCalendarProvider(),
        billing: new MockBillingProvider(),
      }
    : env.PROVIDER_MODE === "live"
      ? {
          voice: isProviderConfigured("ELEVENLABS", env)
            ? new ElevenLabsVoiceProvider(env.ELEVENLABS_API_KEY!)
            : unavailable<VoiceProvider>("ElevenLabs"),
          telephony: isProviderConfigured("TWILIO", env)
            ? new TwilioTelephonyProvider(
                env.TWILIO_ACCOUNT_SID!,
                env.TWILIO_AUTH_TOKEN!,
              )
            : unavailable<TelephonyProvider>("Twilio"),
          calendar: isProviderConfigured("GOOGLE_CALENDAR", env)
            ? new GoogleCalendarProvider({
                clientId: env.GOOGLE_CLIENT_ID!,
                clientSecret: env.GOOGLE_CLIENT_SECRET!,
                refreshToken: env.GOOGLE_REFRESH_TOKEN!,
              })
            : unavailable<CalendarProvider>("Google Calendar"),
          billing: isProviderConfigured("STRIPE", env)
            ? new StripeBillingProvider(env.STRIPE_SECRET_KEY!, {
                growth: env.STRIPE_GROWTH_PRICE_ID,
                agency: env.STRIPE_AGENCY_PRICE_ID,
              })
            : unavailable<BillingProvider>("Stripe"),
        }
      : {
          voice: unavailable<VoiceProvider>("Voice provider"),
          telephony: unavailable<TelephonyProvider>("Telephony provider"),
          calendar: unavailable<CalendarProvider>("Calendar provider"),
          billing: unavailable<BillingProvider>("Billing provider"),
        };

export const providersEnabled = env.PROVIDER_MODE !== "disabled";
