import { z } from "zod";

export const dailyBriefContentSchema = z.object({
  title: z.string().trim().min(1).max(200),
  reflection: z.string().trim().min(1).max(8000),
  taskSummary: z.string().trim().min(1).max(4000),
  sections: z.array(z.object({ title: z.string().trim().min(1).max(100), body: z.string().trim().min(1).max(4000) })).max(8)
}).strict();

export const updateDailyBriefSchema = z.object({
  content: dailyBriefContentSchema,
  state: z.enum(["draft", "confirmed"]).optional()
}).strict();
