import { z } from "zod";

export const reviewDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const reviewMessageSchema = z.object({
  content: z.string().trim().min(1).max(2000),
  source: z.enum(["app", "ai"]).default("app")
}).strict();
