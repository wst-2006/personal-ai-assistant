import { z } from "zod";

export const aiResponseStyleSchema = z.enum(["concise", "balanced", "detailed"]);
export const unscheduledTaskPolicySchema = z.enum(["carry_forward", "delete_at_day_end"]);
export const focusThemeSchema = z.enum(["ink", "flip", "nixie", "vapor", "cyber"]);

export const focusSoundPreferencesSchema = z.object({
  flip: z.boolean(),
  focusStart: z.boolean(),
  breakStart: z.boolean(),
  breakEnd: z.boolean(),
  focusEnd: z.boolean()
}).strict();

export const userProfileContentSchema = z.object({
  personalContext: z.string().trim().max(20_000),
  aiGuidance: z.string().trim().max(4_000),
  shareWithAi: z.boolean(),
  responseStyle: aiResponseStyleSchema,
  unscheduledTaskPolicy: unscheduledTaskPolicySchema,
  recycleRetentionDays: z.number().int().min(1).max(30),
  focusSounds: focusSoundPreferencesSchema,
  focusTheme: focusThemeSchema.default("ink"),
  desktopFocusEnabled: z.boolean().default(true),
  focusPreparationWindowEnabled: z.boolean().default(true),
  focusTimerWindowEnabled: z.boolean().default(true),
  focusEvaluationEnabled: z.boolean().default(true),
  feishuTaskCardsEnabled: z.boolean().default(true),
  feishuT15Enabled: z.boolean().default(true),
  healthPageEnabled: z.boolean().default(true)
}).strict();

export const saveUserProfileSchema = userProfileContentSchema.extend({
  expectedVersion: z.number().int().min(0)
}).strict();

export type AiResponseStyle = z.infer<typeof aiResponseStyleSchema>;
export type UnscheduledTaskPolicy = z.infer<typeof unscheduledTaskPolicySchema>;
export type FocusSoundPreferences = z.infer<typeof focusSoundPreferencesSchema>;
export type FocusTheme = z.infer<typeof focusThemeSchema>;
export type UserProfileContent = z.infer<typeof userProfileContentSchema>;
export type SaveUserProfile = z.infer<typeof saveUserProfileSchema>;
