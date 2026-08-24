import dotenv from "dotenv";
import path from "node:path";
dotenv.config({ path: path.resolve(process.cwd(), ".env") });
dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });
import { z } from "zod";
const booleanFromEnv = z
  .enum(["true", "false"])
  .transform((value) => value === "true")
  .default(false);
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  STORAGE_MODE: z.enum(["memory", "mongo"]).default("memory"),
  MONGODB_URI: z.string().default("mongodb://localhost:27017"),
  MONGODB_DATABASE: z.string().default("efagram_vacaciones"),
  JWT_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32).optional(),
  JWT_EXPIRES_IN: z.string().default("15m"),
  JWT_REFRESH_EXPIRES_IN: z.string().default("7d"),
  BOOTSTRAP_ADMIN_USERNAME: z.string().min(1),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(8),
  SEED_DEMO_DATA: booleanFromEnv,
  SCHEDULER_ENABLED: booleanFromEnv,
  SCHEDULER_INTERVAL_MS: z.coerce.number().int().positive().default(86_400_000),
  CORS_ORIGINS: z.string().default("http://localhost:5173"),
  MAX_UPLOAD_MB: z.coerce.number().positive().default(10),
  MAX_IMPORT_ROWS: z.coerce.number().int().positive().default(5000),
  MAX_PAGE_SIZE: z.coerce.number().int().positive().default(200),
});
export const env = schema.parse(process.env);
