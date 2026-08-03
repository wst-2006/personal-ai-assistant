import { z } from "zod";

export const conversationDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const conversationMessageInputSchema = z.object({
  content: z.string().trim().min(1).max(4_000)
}).strict();

export const conversationRoleSchema = z.enum(["user", "assistant"]);
