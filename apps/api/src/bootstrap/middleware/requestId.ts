import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";
import type { RequestContext } from "../lib/http.js";

export const requestId: RequestHandler = (req, res, next) => {
  const id = req.header("X-Request-Id") ?? randomUUID();
  res.setHeader("X-Request-Id", id);
  (req as RequestContext).requestId = id;
  next();
};
