import { config } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(sourceDirectory, "../../../.env") });

const databaseConfigSchema = z.object({
  DATABASE_URL: z.string().url(),
  EXPECTED_DB_HOST: z.string().min(1),
  EXPECTED_DB_PORT: z.coerce.number().int().positive().max(65535),
  EXPECTED_DB_NAME: z.literal("personal_ai_assistant"),
  EXPECTED_DB_USER: z.literal("personal_ai_app"),
  EXPECTED_PG_MAJOR: z.coerce.number().int().positive()
});

export type DatabaseConfig = z.infer<typeof databaseConfigSchema>;

export function loadDatabaseConfig(): DatabaseConfig {
  return databaseConfigSchema.parse(process.env);
}
