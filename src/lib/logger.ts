import pino from "pino";
import { env } from "../config/env.js";
import { serializeError } from "../security/log-safety.js";

export const logger = pino({
  level: env.NODE_ENV === "development" ? "debug" : "info",
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "request.headers.authorization",
      "request.headers.cookie",
      "password",
      "passwordHash",
      "token",
      "apiKey",
      "secret",
      "credential",
      "credentials",
      "*.password",
      "*.token",
      "*.apiKey",
      "*.secret",
    ],
    censor: "[REDACTED]",
  },
  serializers: { error: serializeError },
});
