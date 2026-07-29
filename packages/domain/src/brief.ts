import { z } from "zod";

export const dailyBriefContentSchema = z.object({
  title: z.string().trim().min(1).max(200),
  reflection: z.string().trim().min(1).max(8000),
  taskSummary: z.string().trim().min(1).max(4000),
  sections: z.array(z.object({ title: z.string().trim().min(1).max(100), body: z.string().trim().min(1).max(4000) })).max(8),
  location: z.object({
    name: z.string().trim().min(1).max(200),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    timeZone: z.string().trim().min(1).max(100)
  }).strict().nullable().optional(),
  weather: z.object({
    temperatureCelsius: z.number(),
    apparentTemperatureCelsius: z.number(),
    weatherCode: z.number().int(),
    observedAt: z.string().datetime({ offset: true }).nullable()
  }).strict().nullable().optional()
}).strict();

export const generateDailyBriefSchema = z.object({
  locationName: z.string().trim().min(1).max(120).optional()
}).strict();

export const updateDailyBriefSchema = z.object({
  content: dailyBriefContentSchema,
  state: z.enum(["draft", "confirmed"]).optional()
}).strict();
