import { z } from "zod";

const radarScoreSchema = z.number().int().min(0).max(100);

export const cyberDiaryRadarSchema = z.object({
  mainlineProgress: radarScoreSchema,
  overallExecution: radarScoreSchema,
  focusQuality: radarScoreSchema,
  energyState: radarScoreSchema.nullable(),
  wellbeing: radarScoreSchema.nullable(),
  growthGain: radarScoreSchema.nullable()
}).strict();

export const cyberDiaryContentSchema = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(20_000),
  radar: cyberDiaryRadarSchema.optional()
}).strict();

export const saveCyberDiarySchema = z.object({
  reviewSessionId: z.string().uuid(),
  briefId: z.string().uuid(),
  content: cyberDiaryContentSchema
}).strict();
