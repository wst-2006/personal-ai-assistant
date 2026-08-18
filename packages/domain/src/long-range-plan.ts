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

export const deleteLongRangePlanSchema = z.object({
  expectedVersion: z.number().int().positive()
}).strict();

export const organizeLongRangePlanInputSchema = z.object({
  scope: longRangePlanScopeSchema,
  title: z.string().trim().max(200),
  periodStart: z.string().date(),
  periodEnd: z.string().date(),
  description: z.string().trim().min(1).max(8000),
  milestones: z.array(longRangeMilestoneInputSchema).max(30).default([])
}).strict().superRefine(validatePeriod);

export const organizedLongRangePlanSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(8000),
  milestones: z.array(longRangeMilestoneInputSchema).max(12)
}).strict();

export type LongRangePlanScope = z.infer<typeof longRangePlanScopeSchema>;
export type LongRangePlanStatus = z.infer<typeof longRangePlanStatusSchema>;
export type LongRangeMilestoneInput = z.infer<typeof longRangeMilestoneInputSchema>;
export type CreateLongRangePlan = z.infer<typeof createLongRangePlanSchema>;
export type UpdateLongRangePlan = z.infer<typeof updateLongRangePlanSchema>;
export type OrganizeLongRangePlanInput = z.infer<typeof organizeLongRangePlanInputSchema>;
export type OrganizedLongRangePlan = z.infer<typeof organizedLongRangePlanSchema>;

export const taskTreeProposalItemSchema = z.object({
  title: z.string().trim().min(1).max(200),
  targetDate: z.string().date().nullable().optional(),
  notes: z.string().trim().max(4000).nullable().optional()
}).strict();

export const taskTreeProposalSchema = z.object({
  summary: z.string().trim().min(1).max(2000),
  tasks: z.array(taskTreeProposalItemSchema).min(1).max(12)
}).strict();

export const createTaskTreeCandidateSchema = z.object({
  expectedPlanVersion: z.number().int().positive(),
  instructions: z.string().trim().max(1000).nullable().optional()
}).strict();

export const updateTaskTreeCandidateSchema = z.object({
  expectedVersion: z.number().int().positive(),
  expectedPlanVersion: z.number().int().positive(),
  proposal: taskTreeProposalSchema
}).strict();

export const taskTreeCandidateActionSchema = z.object({
  expectedVersion: z.number().int().positive(),
  expectedPlanVersion: z.number().int().positive()
}).strict();

export type TaskTreeProposal = z.infer<typeof taskTreeProposalSchema>;
