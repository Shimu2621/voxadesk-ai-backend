import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  FRONTEND_URL: z.string().url().default("http://localhost:3000"),
  PUBLIC_WEBHOOK_BASE_URL: z.string().url().default("http://localhost:4000"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().url().default("redis://localhost:6379"),
  AUTH_SECRET: z.string().min(32),
  PROVIDER_MODE: z.enum(["disabled", "mock", "live"]).default("disabled"),
  MOCK_WEBHOOK_SECRET: z.string().min(32).optional(),
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_WEBHOOK_SECRET: z.string().optional(),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REFRESH_TOKEN: z.string().optional(),
  GOOGLE_CALENDAR_ID: z.string().default("primary"),
  CALENDAR_ENCRYPTION_KEY: z.string().optional(),
  CREDENTIAL_ENCRYPTION_KEYS: z.string().optional(),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_GROWTH_PRICE_ID: z.string().optional(),
  STRIPE_AGENCY_PRICE_ID: z.string().optional(),
});

const parsed = envSchema.parse(process.env);
if (parsed.PROVIDER_MODE === "mock" && !parsed.MOCK_WEBHOOK_SECRET) {
  throw new Error("MOCK_WEBHOOK_SECRET is required when PROVIDER_MODE=mock.");
}

if (parsed.PROVIDER_MODE === "live") {
  const required = [
    "ELEVENLABS_API_KEY",
    "ELEVENLABS_WEBHOOK_SECRET",
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_REFRESH_TOKEN",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
  ] as const;
  const missing = required.filter((key) => !parsed[key]);
  if (missing.length) {
    throw new Error(`Live provider mode is missing: ${missing.join(", ")}.`);
  }
}

export const env = parsed;
