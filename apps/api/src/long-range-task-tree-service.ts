import { and, desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { AppDatabase } from "@personal-ai/db/client";
import { longRangePlanMilestones, longRangePlanTaskTreeCandidates, longRangePlans, taskLifecycleEvents, tasks } from "@personal-ai/db/schema";
import { createTaskTreeCandidateSchema, taskTreeCandidateActionSchema, taskTreeProposalSchema, updateTaskTreeCandidateSchema, type TaskTreeProposal } from "@personal-ai/domain/long-range-plan";
import type { LongRangeTaskTreePlanner } from "./ai/long-range-task-tree-planner.js";

export type StoredTaskTreeCandidate = typeof longRangePlanTaskTreeCandidates.$inferSelect & { proposal: TaskTreeProposal; createdTaskIds: string[] };
export class TaskTreePlanNotFoundError extends Error {}
export class TaskTreeVersionConflictError extends Error { constructor(readonly plan: typeof longRangePlans.$inferSelect) { super("Long-range plan version does not match."); } }
export class TaskTreeCandidateNotFoundError extends Error {}
export class TaskTreeCandidateConflictError extends Error {}

export class LongRangeTaskTreeService {
  constructor(private readonly db: AppDatabase) {}

  async getLatest(planId: string): Promise<StoredTaskTreeCandidate | null> {
    await this.requirePlan(this.db, planId);
    const [candidate] = await this.db.select().from(longRangePlanTaskTreeCandidates)
      .where(eq(longRangePlanTaskTreeCandidates.longRangePlanId, planId))
      .orderBy(desc(longRangePlanTaskTreeCandidates.createdAt)).limit(1);
    return candidate ? serialize(candidate) : null;
  }

  async createAiCandidate(planId: string, input: unknown, planner: LongRangeTaskTreePlanner): Promise<StoredTaskTreeCandidate> {
    const parsed = createTaskTreeCandidateSchema.parse(input);
    const plan = await this.requirePlan(this.db, planId);
    if (plan.status !== "active") throw new TaskTreeCandidateConflictError("Only active plans can be decomposed.");
    if (plan.version !== parsed.expectedPlanVersion) throw new TaskTreeVersionConflictError(plan);
    const milestones = await this.db.select({ title: longRangePlanMilestones.title, targetDate: longRangePlanMilestones.targetDate, notes: longRangePlanMilestones.notes }).from(longRangePlanMilestones).where(eq(longRangePlanMilestones.longRangePlanId, plan.id));
    const proposal = await planner.plan({ title: plan.title, periodStart: plan.periodStart, periodEnd: plan.periodEnd, description: plan.description, milestones, instructions: parsed.instructions ?? null });
    const valid = taskTreeProposalSchema.safeParse(proposal);
    if (!valid.success) throw new TaskTreeCandidateConflictError("AI returned an invalid task-tree proposal.");
    return this.db.transaction(async (transaction) => {
      const current = await this.requirePlan(transaction as AppDatabase, planId);
      if (current.version !== parsed.expectedPlanVersion) throw new TaskTreeVersionConflictError(current);
      const now = new Date();
      const [candidate] = await transaction.insert(longRangePlanTaskTreeCandidates).values({
        id: randomUUID(), longRangePlanId: planId, longRangePlanVersion: current.version,
        state: "candidate", instructions: parsed.instructions ?? null, proposal: valid.data,
        createdTaskIds: [], version: 1, createdAt: now, updatedAt: now
      }).returning();
      if (!candidate) throw new Error("PostgreSQL did not return the task-tree candidate.");
      return serialize(candidate);
    });
  }

  async updateCandidate(id: string, input: unknown): Promise<StoredTaskTreeCandidate> {
    const parsed = updateTaskTreeCandidateSchema.parse(input);
    return this.db.transaction(async (transaction) => {
      const current = await this.requireCandidate(transaction as AppDatabase, id);
      const plan = await this.requirePlan(transaction as AppDatabase, current.longRangePlanId);
      if (current.state !== "candidate") throw new TaskTreeCandidateConflictError("Only a pending candidate can be edited.");
      if (current.version !== parsed.expectedVersion || plan.version !== parsed.expectedPlanVersion || current.longRangePlanVersion !== plan.version) throw new TaskTreeVersionConflictError(plan);
      const [updated] = await transaction.update(longRangePlanTaskTreeCandidates).set({ proposal: parsed.proposal, version: current.version + 1, updatedAt: new Date() }).where(and(eq(longRangePlanTaskTreeCandidates.id, id), eq(longRangePlanTaskTreeCandidates.version, parsed.expectedVersion))).returning();
      if (!updated) throw new TaskTreeCandidateConflictError("Task-tree candidate changed before edit.");
      return serialize(updated);
    });
  }

  async cancelCandidate(id: string, input: unknown): Promise<StoredTaskTreeCandidate> {
    const parsed = taskTreeCandidateActionSchema.parse(input);
    return this.db.transaction(async (transaction) => {
      const current = await this.requireCandidate(transaction as AppDatabase, id);
      const plan = await this.requirePlan(transaction as AppDatabase, current.longRangePlanId);
      if (current.state !== "candidate") return serialize(current);
      if (current.version !== parsed.expectedVersion || plan.version !== parsed.expectedPlanVersion) throw new TaskTreeVersionConflictError(plan);
      const [updated] = await transaction.update(longRangePlanTaskTreeCandidates).set({ state: "cancelled", cancelledAt: new Date(), version: current.version + 1, updatedAt: new Date() }).where(and(eq(longRangePlanTaskTreeCandidates.id, id), eq(longRangePlanTaskTreeCandidates.version, parsed.expectedVersion))).returning();
      if (!updated) throw new TaskTreeCandidateConflictError("Task-tree candidate changed before cancellation.");
      return serialize(updated);
    });
  }

  async confirmCandidate(id: string, input: unknown): Promise<{ candidate: StoredTaskTreeCandidate; taskIds: string[] }> {
    const parsed = taskTreeCandidateActionSchema.parse(input);
    return this.db.transaction(async (transaction) => {
      const current = await this.requireCandidate(transaction as AppDatabase, id);
      if (current.state === "confirmed") return { candidate: serialize(current), taskIds: (current.createdTaskIds as string[] | null) ?? [] };
      const plan = await this.requirePlan(transaction as AppDatabase, current.longRangePlanId);
      if (current.state !== "candidate") throw new TaskTreeCandidateConflictError("This task-tree candidate is no longer available.");
      if (current.version !== parsed.expectedVersion || plan.version !== parsed.expectedPlanVersion || current.longRangePlanVersion !== plan.version) throw new TaskTreeVersionConflictError(plan);
      const proposal = taskTreeProposalSchema.parse(current.proposal);
      const now = new Date();
      const taskIds: string[] = [];
      for (const item of proposal.tasks) {
        const id = randomUUID(); taskIds.push(id);
        await transaction.insert(tasks).values({ id, title: item.title, sourceInboxEntryId: null, sourceLongRangePlanId: plan.id, lifecycleStatus: "open", scheduleKind: "none", currentOutcome: null, localDate: item.targetDate ?? null, daypart: null, startAt: null, endAt: null, timeZone: "Asia/Shanghai", notes: item.notes ?? null, version: 1, scheduleRevision: 1, createdAt: now, updatedAt: now });
        await transaction.insert(taskLifecycleEvents).values({ id: randomUUID(), taskId: id, fromStatus: null, toStatus: "open", source: "app", reason: "confirmed long-range task-tree candidate" });
      }
      const [updated] = await transaction.update(longRangePlanTaskTreeCandidates).set({ state: "confirmed", createdTaskIds: taskIds, confirmedAt: now, version: current.version + 1, updatedAt: now }).where(and(eq(longRangePlanTaskTreeCandidates.id, id), eq(longRangePlanTaskTreeCandidates.version, parsed.expectedVersion))).returning();
      if (!updated) throw new TaskTreeCandidateConflictError("Task-tree candidate changed before confirmation.");
      return { candidate: serialize(updated), taskIds };
    });
  }

  private async requirePlan(database: AppDatabase, id: string) { const [plan] = await database.select().from(longRangePlans).where(eq(longRangePlans.id, id)).limit(1); if (!plan) throw new TaskTreePlanNotFoundError(); return plan; }
  private async requireCandidate(database: AppDatabase, id: string) { const [candidate] = await database.select().from(longRangePlanTaskTreeCandidates).where(eq(longRangePlanTaskTreeCandidates.id, id)).limit(1); if (!candidate) throw new TaskTreeCandidateNotFoundError(); return candidate; }
}

function serialize(value: typeof longRangePlanTaskTreeCandidates.$inferSelect): StoredTaskTreeCandidate {
  return { ...value, proposal: taskTreeProposalSchema.parse(value.proposal), createdTaskIds: Array.isArray(value.createdTaskIds) ? value.createdTaskIds.filter((item): item is string => typeof item === "string") : [] };
}
