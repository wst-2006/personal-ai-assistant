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

export const healthMovementCategorySchema = z.enum(["strength", "volleyball", "running", "walking", "cycling", "recovery", "rest"]);
export const healthIntensitySchema = z.enum(["rest", "low", "moderate", "high"]);
const healthGramRangeSchema = z.object({ minimum: z.number().int().min(0).max(1000), maximum: z.number().int().min(0).max(1000) }).strict();
const healthMealExamplesSchema = z.object({
  breakfast: z.array(z.string().trim().min(1).max(160)).min(1).max(6),
  lunch: z.array(z.string().trim().min(1).max(160)).min(1).max(6),
  dinner: z.array(z.string().trim().min(1).max(160)).min(1).max(6),
  snack: z.array(z.string().trim().min(1).max(160)).max(5)
}).strict();
const healthFoodReferenceSchema = z.object({
  proteinOptions: z.array(z.string().trim().min(1).max(120)).min(1).max(10),
  fiberOptions: z.array(z.string().trim().min(1).max(120)).min(1).max(10),
  carbOptions: z.array(z.string().trim().min(1).max(120)).min(1).max(10)
}).strict();

export const healthDailyReferenceSchema = z.object({
  nutritionDirection: z.string().trim().min(1).max(700),
  proteinRangeGrams: z.object({ minimum: z.number().int().min(1).max(300), maximum: z.number().int().min(1).max(300) }).strict(),
  nutritionTargets: z.object({
    carbohydrateGrams: healthGramRangeSchema,
    fatGrams: healthGramRangeSchema,
    fiberGrams: healthGramRangeSchema,
    hydrationLiters: z.object({ minimum: z.number().min(0).max(10), maximum: z.number().min(0).max(10) }).strict(),
    macroRatioPercent: z.object({ protein: z.number().min(0).max(100), carbohydrate: z.number().min(0).max(100), fat: z.number().min(0).max(100) }).strict()
  }).strict().optional(),
  hydrationGuidance: z.array(z.string().trim().min(1).max(180)).min(1).max(6).optional(),
  mealExamples: healthMealExamplesSchema.optional(),
  proteinRotationSources: z.array(z.string().trim().min(1).max(120)).min(1).max(5).optional(),
  foodReference: healthFoodReferenceSchema.optional(),
  fruitOptions: z.array(z.string().trim().min(1).max(120)).min(1).max(10).optional(),
  plateGuidance: z.array(z.string().trim().min(1).max(240)).min(1).max(5),
  seasonalVegetables: z.array(z.string().trim().min(1).max(80)).min(1).max(6),
  seasonalGuidance: z.string().trim().min(1).max(500).nullable().optional(),
  seasonalPoem: z.object({
    title: z.string().trim().min(1).max(120),
    author: z.string().trim().min(1).max(120),
    excerpt: z.string().trim().min(1).max(180),
    relevance: z.string().trim().min(1).max(300)
  }).strict().nullable().optional(),
  movement: z.object({
    category: healthMovementCategorySchema,
    durationMinutes: z.object({ minimum: z.number().int().min(0).max(240), maximum: z.number().int().min(0).max(300) }).strict(),
    intensity: healthIntensitySchema,
    highIntensity: z.boolean(),
    safetyReminder: z.string().trim().min(1).max(400),
    focus: z.array(z.string().trim().min(1).max(180)).min(1).max(8).optional(),
    safetyNotes: z.array(z.string().trim().min(1).max(220)).min(1).max(8).optional()
  }).strict()
}).strict().superRefine((reference, context) => {
  if (reference.proteinRangeGrams.minimum > reference.proteinRangeGrams.maximum) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["proteinRangeGrams"], message: "Protein range minimum cannot exceed maximum" });
  }
  const targets = reference.nutritionTargets;
  if (targets) {
    for (const [key, range] of Object.entries({ carbohydrateGrams: targets.carbohydrateGrams, fatGrams: targets.fatGrams, fiberGrams: targets.fiberGrams })) {
      if (range.minimum > range.maximum) context.addIssue({ code: z.ZodIssueCode.custom, path: ["nutritionTargets", key], message: `${key} minimum cannot exceed maximum` });
    }
    if (targets.hydrationLiters.minimum > targets.hydrationLiters.maximum) context.addIssue({ code: z.ZodIssueCode.custom, path: ["nutritionTargets", "hydrationLiters"], message: "Hydration minimum cannot exceed maximum" });
    const macroTotal = targets.macroRatioPercent.protein + targets.macroRatioPercent.carbohydrate + targets.macroRatioPercent.fat;
    if (macroTotal < 95 || macroTotal > 105) context.addIssue({ code: z.ZodIssueCode.custom, path: ["nutritionTargets", "macroRatioPercent"], message: "Macro ratio percentages must total approximately 100" });
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

export const generatedHealthPlanContentSchema = healthPlanContentSchema.superRefine((plan, context) => {
  plan.days.forEach((day, dayIndex) => {
    for (const key of ["nutritionTargets", "hydrationGuidance", "mealExamples", "proteinRotationSources", "foodReference", "fruitOptions"] as const) {
      if (day[key] === undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ["days", dayIndex, key], message: `${key} is required for newly generated health references` });
    }

    const proteinConversions = day.foodReference?.proteinOptions ?? [];
    for (const [label, pattern] of [
      ["鸡蛋", /鸡蛋/u],
      ["牛肉", /牛肉/u],
      ["鸡胸肉", /鸡胸(?:肉)?/u]
    ] as const) {
      const conversion = proteinConversions.find((item) => pattern.test(item));
      if (!conversion || !/\d/u.test(conversion)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["days", dayIndex, "foodReference", "proteinOptions"],
          message: `protein conversion for ${label} is required for newly generated health references`
        });
      }
    }

    if (!(day.hydrationGuidance ?? []).some((item) => /纸杯/u.test(item) && /\d/u.test(item))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["days", dayIndex, "hydrationGuidance"],
        message: "paper cup hydration conversion is required for newly generated health references"
      });
    }

    if ((day.fruitOptions?.length ?? 0) < 2 || day.fruitOptions?.some((item) => !/(?:\d|半|一|二|两|三).*(?:克|g|个|份|片|杯)/iu.test(item))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["days", dayIndex, "fruitOptions"],
        message: "at least two fruit options with portions are required for newly generated health references"
      });
    }
  });
});

export const healthWeekStartSchema = reviewDateSchema.refine((value) => new Date(`${value}T00:00:00.000Z`).getUTCDay() === 0, "weekStart must be a Sunday");
export const createHealthPlanCandidateSchema = z.object({
  weekStart: healthWeekStartSchema,
  specialContext: z.string().trim().max(1000).nullable().optional()
}).strict();
export const healthCollaborationMessageInputSchema = z.object({
  content: z.string().trim().min(1).max(4_000)
}).strict();
export const createManualHealthPlanCandidateSchema = z.object({
  weekStart: healthWeekStartSchema,
  specialContext: z.string().trim().max(1000).nullable().optional(),
  content: healthPlanContentSchema
}).strict();
export const updateManualHealthPlanCandidateSchema = z.object({
  expectedVersion: z.number().int().positive(),
  content: healthPlanContentSchema
}).strict();
export const saveHealthProfileSchema = z.object({
  expectedVersion: z.number().int().positive().nullable().optional(),
  profile: healthProfileSchema
}).strict();
export const healthPlanConfirmationSchema = z.object({ expectedVersion: z.number().int().positive() }).strict();
export const saveHealthDailyActualSchema = z.object({
  proteinGrams: z.number().int().min(0).max(1000).nullable(),
  fiberGrams: z.number().int().min(0).max(200).nullable(),
  waterMilliliters: z.number().int().min(0).max(10_000).nullable()
}).strict();
export const healthSleepRevisionCandidateSchema = z.object({
  weekStart: healthWeekStartSchema,
  sleepAnalysisId: z.string().uuid(),
  specialContext: z.string().trim().max(1000).nullable().optional()
}).strict();

const sleepImageMimeTypeSchema = z.enum(["image/png", "image/jpeg", "image/webp"]);
// A 6 MiB image expands to just over 8 MiB when encoded as base64.
const sleepImageDataUrlSchema = z.string().max(8_500_000).regex(
  /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/,
  "sleep screenshot must be a base64 PNG, JPEG, or WebP data URL"
);

export const sleepImageAnalysisRequestSchema = z.object({
  localDate: reviewDateSchema,
  fileName: z.string().trim().min(1).max(160),
  mimeType: sleepImageMimeTypeSchema,
  dataUrl: sleepImageDataUrlSchema
}).strict();

export const sleepImageAnalysisSchema = z.object({
  totalSleepMinutes: z.number().int().min(0).max(1440).nullable(),
  deepSleepMinutes: z.number().int().min(0).max(1440).nullable(),
  lightSleepMinutes: z.number().int().min(0).max(1440).nullable(),
  remSleepMinutes: z.number().int().min(0).max(1440).nullable(),
  awakeCount: z.number().int().min(0).max(100).nullable(),
  sleepStart: z.string().trim().max(80).nullable(),
  wakeTime: z.string().trim().max(80).nullable(),
  deviceScore: z.number().min(0).max(100).nullable(),
  deviceNotes: z.string().trim().max(800).nullable(),
  visibleMetrics: z.array(z.string().trim().min(1).max(160)).max(24),
  interpretation: z.array(z.string().trim().min(1).max(320)).max(12),
  limitations: z.array(z.string().trim().min(1).max(320)).min(1).max(12)
}).strict();

export type HealthProfile = z.infer<typeof healthProfileSchema>;
export type HealthDailyReference = z.infer<typeof healthDailyReferenceSchema>;
export type HealthPlanContent = z.infer<typeof healthPlanContentSchema>;
export type ManualHealthPlanCandidate = z.infer<typeof createManualHealthPlanCandidateSchema>;
export type HealthDailyActualInput = z.infer<typeof saveHealthDailyActualSchema>;
export type SleepImageAnalysisRequest = z.infer<typeof sleepImageAnalysisRequestSchema>;
export type SleepImageAnalysis = z.infer<typeof sleepImageAnalysisSchema>;
export type HealthSleepRevisionCandidate = z.infer<typeof healthSleepRevisionCandidateSchema>;

export function localDatesForHealthWeek(weekStart: string): string[] {
  const start = new Date(`${weekStart}T00:00:00.000Z`);
  return Array.from({ length: 7 }, (_, index) => {
    const current = new Date(start);
    current.setUTCDate(current.getUTCDate() + index);
    return current.toISOString().slice(0, 10);
  });
}
