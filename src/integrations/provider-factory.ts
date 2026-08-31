import { env } from "../config/env.js";
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
          voice: new ElevenLabsVoiceProvider(env.ELEVENLABS_API_KEY!),
          telephony: new TwilioTelephonyProvider(
            env.TWILIO_ACCOUNT_SID!,
            env.TWILIO_AUTH_TOKEN!,
          ),
          calendar: new GoogleCalendarProvider({
            clientId: env.GOOGLE_CLIENT_ID!,
            clientSecret: env.GOOGLE_CLIENT_SECRET!,
            refreshToken: env.GOOGLE_REFRESH_TOKEN!,
          }),
          billing: new StripeBillingProvider(env.STRIPE_SECRET_KEY!, {
            growth: env.STRIPE_GROWTH_PRICE_ID,
            agency: env.STRIPE_AGENCY_PRICE_ID,
          }),
        }
      : {
          voice: unavailable<VoiceProvider>("Voice provider"),
          telephony: unavailable<TelephonyProvider>("Telephony provider"),
          calendar: unavailable<CalendarProvider>("Calendar provider"),
          billing: unavailable<BillingProvider>("Billing provider"),
        };

export const providersEnabled = env.PROVIDER_MODE !== "disabled";
