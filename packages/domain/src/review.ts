import { z } from "zod";

export const REVIEW_RADAR_STAGES = [20, 40, 60, 80, 100] as const;
const reviewRadarScoreSchema = z.number().int().refine(
  (value) => (REVIEW_RADAR_STAGES as readonly number[]).includes(value),
  { message: "radar score must match a hexagon stage" }
);

export const reviewDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const reviewMessageSchema = z.object({
  content: z.string().trim().min(1).max(2000),
  source: z.literal("app").default("app")
}).strict();

export const reviewRadarSchema = z.object({
  mainlineProgress: reviewRadarScoreSchema,
  overallExecution: reviewRadarScoreSchema,
  focusQuality: reviewRadarScoreSchema,
  energyState: reviewRadarScoreSchema,
  wellbeing: reviewRadarScoreSchema,
  growthGain: reviewRadarScoreSchema
}).strict();

export const reviewRadarSnapshotSchema = z.object({
  version: z.literal(1),
  radar: reviewRadarSchema
}).strict();

export type ReviewRadar = z.infer<typeof reviewRadarSchema>;
