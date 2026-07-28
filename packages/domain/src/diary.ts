import { z } from "zod";

export const cyberDiaryContentSchema = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(20_000)
}).strict();

export const saveCyberDiarySchema = z.object({
  reviewSessionId: z.string().uuid(),
  briefId: z.string().uuid(),
  content: cyberDiaryContentSchema
}).strict();
