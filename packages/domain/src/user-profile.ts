import { z } from "zod";

export const aiResponseStyleSchema = z.enum(["concise", "balanced", "detailed"]);

export const userProfileContentSchema = z.object({
  personalContext: z.string().trim().max(20_000),
  aiGuidance: z.string().trim().max(4_000),
  shareWithAi: z.boolean(),
  responseStyle: aiResponseStyleSchema
}).strict();

export const saveUserProfileSchema = userProfileContentSchema.extend({
  expectedVersion: z.number().int().min(0)
}).strict();

export type AiResponseStyle = z.infer<typeof aiResponseStyleSchema>;
export type UserProfileContent = z.infer<typeof userProfileContentSchema>;
export type SaveUserProfile = z.infer<typeof saveUserProfileSchema>;
