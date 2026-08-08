import { z } from "zod";

const optionalTrimmedString = z.preprocess(
  (value) => typeof value === "string" ? value.trim() || undefined : value,
  z.string().min(1).optional()
);

const optionalUrl = z.preprocess(
  (value) => typeof value === "string" ? value.trim() || undefined : value,
  z.string().url().optional()
);

const visionEnvironmentSchema = z.object({
  VISION_API_KEY: optionalTrimmedString,
  VISION_BASE_URL: optionalUrl,
  VISION_MODEL: optionalTrimmedString,
  VISION_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  VISION_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  VISION_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().max(4_096).default(1_200)
});

export type VisionConfig = {
  VISION_API_KEY: string;
  VISION_BASE_URL: string;
  VISION_MODEL: string;
  VISION_TIMEOUT_MS: number;
  VISION_MAX_RETRIES: number;
  VISION_MAX_OUTPUT_TOKENS: number;
};

export function loadVisionConfig(environment: NodeJS.ProcessEnv = process.env): VisionConfig | null {
  const parsed = visionEnvironmentSchema.parse(environment);
  if (!parsed.VISION_API_KEY) return null;
  return {
    VISION_API_KEY: parsed.VISION_API_KEY,
    VISION_BASE_URL: parsed.VISION_BASE_URL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1",
    VISION_MODEL: parsed.VISION_MODEL ?? "qwen3-vl-flash",
    VISION_TIMEOUT_MS: parsed.VISION_TIMEOUT_MS,
    VISION_MAX_RETRIES: parsed.VISION_MAX_RETRIES,
    VISION_MAX_OUTPUT_TOKENS: parsed.VISION_MAX_OUTPUT_TOKENS
  };
}
