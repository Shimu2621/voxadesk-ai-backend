import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { logger } from "../lib/logger.js";

export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  if (error instanceof ZodError) {
    res.status(400).json({ code: "VALIDATION_ERROR", message: "The request is invalid.", details: error.flatten(), requestId: req.requestId });
    return;
  }
  logger.error({ error, requestId: req.requestId }, "Unhandled request error");
  res.status(500).json({ code: "INTERNAL_ERROR", message: "An unexpected error occurred.", requestId: req.requestId });
};
