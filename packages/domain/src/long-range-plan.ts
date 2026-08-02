import { z } from "zod";

export const longRangePlanScopeSchema = z.enum(["month", "semester", "annual"]);
export const longRangePlanStatusSchema = z.enum(["active", "archived"]);

export const longRangeMilestoneInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  targetDate: z.string().date().nullable().optional(),
  notes: z.string().trim().max(4000).nullable().optional()
}).strict();

const planFields = {
  scope: longRangePlanScopeSchema,
  title: z.string().trim().min(1).max(200),
  periodStart: z.string().date(),
  periodEnd: z.string().date(),
  description: z.string().trim().max(8000).nullable().optional(),
  milestones: z.array(longRangeMilestoneInputSchema).max(30).default([])
};

function validatePeriod(input: { periodStart: string; periodEnd: string }, context: z.RefinementCtx) {
  if (input.periodEnd < input.periodStart) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["periodEnd"], message: "periodEnd must not be before periodStart" });
  }
}

export const createLongRangePlanSchema = z.object(planFields).strict().superRefine(validatePeriod);

export const updateLongRangePlanSchema = z.object({
  expectedVersion: z.number().int().positive(),
  ...planFields
}).strict().superRefine(validatePeriod);

export const setLongRangePlanStatusSchema = z.object({
  expectedVersion: z.number().int().positive(),
  status: longRangePlanStatusSchema
}).strict();

export type LongRangePlanScope = z.infer<typeof longRangePlanScopeSchema>;
export type LongRangePlanStatus = z.infer<typeof longRangePlanStatusSchema>;
export type LongRangeMilestoneInput = z.infer<typeof longRangeMilestoneInputSchema>;
export type CreateLongRangePlan = z.infer<typeof createLongRangePlanSchema>;
export type UpdateLongRangePlan = z.infer<typeof updateLongRangePlanSchema>;
