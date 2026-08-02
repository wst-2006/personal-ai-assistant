import { z } from "zod";
import { reviewDateSchema } from "./review.js";

const textList = z.array(z.string().trim().min(1).max(160)).max(24);

export const healthProfileSchema = z.object({
  city: z.string().trim().min(1).max(120).nullable(),
  basics: z.object({
    sex: z.enum(["male", "female", "other"]),
    age: z.number().int().min(16).max(120),
    heightCm: z.number().int().min(120).max(230),
    weightKg: z.number().min(30).max(300),
    bodyFatPercent: z.number().min(1).max(70).nullable(),
    waistCm: z.number().min(40).max(200).nullable()
  }).strict(),
  goals: textList.min(1),
  stageWeightGoal: z.object({ minimumKg: z.number().min(30).max(300), maximumKg: z.number().min(30).max(300) }).strict(),
  considerations: textList,
  activity: z.object({
    sessionsPerWeek: z.number().int().min(0).max(14),
    usualDurationMinutes: z.object({ minimum: z.number().int().min(0).max(360), maximum: z.number().int().min(0).max(480) }).strict(),
    preferredActivities: textList,
    avoidHighRisk: z.boolean()
  }).strict(),
  food: z.object({
    mealContext: z.string().trim().min(1).max(400),
    mealTimes: z.object({ breakfast: z.string().trim().min(1).max(20), lunch: z.string().trim().min(1).max(20), dinner: z.string().trim().min(1).max(20) }).strict(),
    dislikes: textList,
    commonFoods: textList
  }).strict(),
  supplements: z.object({ current: textList, considering: textList, avoids: textList }).strict(),
  notes: z.string().trim().max(2000).nullable()
}).strict().superRefine((profile, context) => {
  if (profile.stageWeightGoal.minimumKg > profile.stageWeightGoal.maximumKg) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["stageWeightGoal"], message: "Weight goal minimum cannot exceed maximum" });
  }
  if (profile.activity.usualDurationMinutes.minimum > profile.activity.usualDurationMinutes.maximum) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["activity", "usualDurationMinutes"], message: "Duration minimum cannot exceed maximum" });
  }
});

export const healthMovementCategorySchema = z.enum(["strength", "volleyball", "running", "cycling", "recovery", "rest"]);
export const healthIntensitySchema = z.enum(["rest", "low", "moderate", "high"]);

export const healthDailyReferenceSchema = z.object({
  nutritionDirection: z.string().trim().min(1).max(700),
  proteinRangeGrams: z.object({ minimum: z.number().int().min(1).max(300), maximum: z.number().int().min(1).max(300) }).strict(),
  plateGuidance: z.array(z.string().trim().min(1).max(240)).min(1).max(5),
  seasonalVegetables: z.array(z.string().trim().min(1).max(80)).min(1).max(6),
  movement: z.object({
    category: healthMovementCategorySchema,
    durationMinutes: z.object({ minimum: z.number().int().min(0).max(240), maximum: z.number().int().min(0).max(300) }).strict(),
    intensity: healthIntensitySchema,
    highIntensity: z.boolean(),
    safetyReminder: z.string().trim().min(1).max(400)
  }).strict()
}).strict().superRefine((reference, context) => {
  if (reference.proteinRangeGrams.minimum > reference.proteinRangeGrams.maximum) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["proteinRangeGrams"], message: "Protein range minimum cannot exceed maximum" });
  }
  if (reference.movement.durationMinutes.minimum > reference.movement.durationMinutes.maximum) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["movement", "durationMinutes"], message: "Movement duration minimum cannot exceed maximum" });
  }
});

export const healthPlanContentSchema = z.object({
  overview: z.string().trim().min(1).max(2000),
  supplements: z.array(z.string().trim().min(1).max(320)).min(1).max(8),
  days: z.array(healthDailyReferenceSchema).length(7)
}).strict();

export const healthWeekStartSchema = reviewDateSchema.refine((value) => new Date(`${value}T00:00:00.000Z`).getUTCDay() === 0, "weekStart must be a Sunday");
export const createHealthPlanCandidateSchema = z.object({
  weekStart: healthWeekStartSchema,
  specialContext: z.string().trim().max(1000).nullable().optional()
}).strict();
export const saveHealthProfileSchema = z.object({
  expectedVersion: z.number().int().positive().nullable().optional(),
  profile: healthProfileSchema
}).strict();
export const healthPlanConfirmationSchema = z.object({ expectedVersion: z.number().int().positive() }).strict();

export type HealthProfile = z.infer<typeof healthProfileSchema>;
export type HealthDailyReference = z.infer<typeof healthDailyReferenceSchema>;
export type HealthPlanContent = z.infer<typeof healthPlanContentSchema>;

export function localDatesForHealthWeek(weekStart: string): string[] {
  const start = new Date(`${weekStart}T00:00:00.000Z`);
  return Array.from({ length: 7 }, (_, index) => {
    const current = new Date(start);
    current.setUTCDate(current.getUTCDate() + index);
    return current.toISOString().slice(0, 10);
  });
}
