import { z } from "zod";

const optionalTrimmedString = z.preprocess(
  (value) => typeof value === "string" ? value.trim() || undefined : value,
  z.string().min(1).optional()
);

const deepSeekConfigSchema = z.object({
  DEEPSEEK_API_KEY: z.string().trim().min(1),
  DEEPSEEK_BASE_URL: z.string().trim().url(),
  DEEPSEEK_MODEL: z.string().trim().min(1),
  // Keep multimodal support opt-in until a configured model has been verified to accept image input.
  DEEPSEEK_VISION_MODEL: optionalTrimmedString,
  DEEPSEEK_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  DEEPSEEK_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  DEEPSEEK_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().max(4096).default(1200),
  DEEPSEEK_USER_CONTEXT_MAX_CHARS: z.coerce.number().int().min(0).max(20_000).default(6_000)
});

export type DeepSeekConfig = z.infer<typeof deepSeekConfigSchema>;

export function loadDeepSeekConfig(): DeepSeekConfig {
  return deepSeekConfigSchema.parse(process.env);
}
