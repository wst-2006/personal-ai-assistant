import { z } from "zod";

const serverConfigSchema = z.object({
  API_HOST: z.string().default("127.0.0.1"),
  API_PORT: z.coerce.number().int().positive().default(3000)
});

export type ServerConfig = z.infer<typeof serverConfigSchema>;

export function loadServerConfig(): ServerConfig {
  return serverConfigSchema.parse(process.env);
}
