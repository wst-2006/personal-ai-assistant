import { z } from "zod";

const deepSeekConfigSchema = z.object({
  DEEPSEEK_API_KEY: z.string().trim().min(1),
  DEEPSEEK_BASE_URL: z.string().trim().url(),
  DEEPSEEK_MODEL: z.string().trim().min(1),
  DEEPSEEK_VISION_MODEL: z.string().trim().min(1).optional(),
  DEEPSEEK_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  DEEPSEEK_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  DEEPSEEK_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().max(4096).default(4096),
  DEEPSEEK_USER_CONTEXT_MAX_CHARS: z.coerce.number().int().min(0).max(20_000).default(6_000)
});

export type DeepSeekConfig = z.infer<typeof deepSeekConfigSchema>;

export function loadDeepSeekConfig(environment: NodeJS.ProcessEnv = process.env): DeepSeekConfig {
  return deepSeekConfigSchema.parse(environment);
}
