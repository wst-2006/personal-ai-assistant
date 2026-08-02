import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { AppDatabase } from "@personal-ai/db/client";
import { longRangePlanMilestones, longRangePlans } from "@personal-ai/db/schema";
import type { CreateLongRangePlan, LongRangePlanScope, LongRangePlanStatus, UpdateLongRangePlan } from "@personal-ai/domain/long-range-plan";

export type StoredLongRangePlan = typeof longRangePlans.$inferSelect;
export type StoredLongRangeMilestone = typeof longRangePlanMilestones.$inferSelect;
export type LongRangePlanWithMilestones = StoredLongRangePlan & { milestones: StoredLongRangeMilestone[] };

export class LongRangePlanNotFoundError extends Error {}
export class LongRangePlanVersionConflictError extends Error {
  constructor(readonly current: StoredLongRangePlan) { super("Long-range plan version does not match."); }
}
export class LongRangePlanStateError extends Error {
  constructor(readonly state: string, readonly operation: string) { super(`Cannot ${operation} a ${state} long-range plan.`); }
}

export class LongRangePlanService {
  constructor(private readonly db: AppDatabase) {}

  async list(scope?: LongRangePlanScope, includeArchived = false): Promise<LongRangePlanWithMilestones[]> {
    const conditions = scope
      ? includeArchived ? eq(longRangePlans.scope, scope) : and(eq(longRangePlans.scope, scope), eq(longRangePlans.status, "active"))
      : includeArchived ? undefined : eq(longRangePlans.status, "active");
    const plans = await this.db.select().from(longRangePlans).where(conditions).orderBy(desc(longRangePlans.periodStart), asc(longRangePlans.createdAt));
    return this.withMilestones(this.db, plans);
  }

  async get(id: string): Promise<LongRangePlanWithMilestones> {
    const [plan] = await this.db.select().from(longRangePlans).where(eq(longRangePlans.id, id)).limit(1);
    if (!plan) throw new LongRangePlanNotFoundError();
    return (await this.withMilestones(this.db, [plan]))[0]!;
  }

  async create(input: CreateLongRangePlan): Promise<LongRangePlanWithMilestones> {
    return this.db.transaction(async (transaction) => {
      const now = new Date();
      const [plan] = await transaction.insert(longRangePlans).values({
        id: randomUUID(),
        scope: input.scope,
        title: input.title,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        description: input.description ?? null,
        status: "active",
        version: 1,
        createdAt: now,
        updatedAt: now
      }).returning();
      if (!plan) throw new Error("PostgreSQL did not return the created long-range plan.");
      const milestones = await this.insertMilestones(transaction as AppDatabase, plan.id, input.milestones, now);
      return { ...plan, milestones };
    });
  }

  async update(id: string, input: UpdateLongRangePlan): Promise<LongRangePlanWithMilestones> {
    return this.db.transaction(async (transaction) => {
      const current = await this.requireCurrent(transaction as AppDatabase, id, input.expectedVersion);
      if (current.status !== "active") throw new LongRangePlanStateError(current.status, "edit");
      const now = new Date();
      const [plan] = await transaction.update(longRangePlans).set({
        scope: input.scope,
        title: input.title,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        description: input.description ?? null,
        version: current.version + 1,
        updatedAt: now
      }).where(and(eq(longRangePlans.id, id), eq(longRangePlans.version, input.expectedVersion))).returning();
      if (!plan) throw new LongRangePlanVersionConflictError(await this.requirePlan(transaction as AppDatabase, id));
      await transaction.delete(longRangePlanMilestones).where(eq(longRangePlanMilestones.longRangePlanId, id));
      const milestones = await this.insertMilestones(transaction as AppDatabase, id, input.milestones, now);
      return { ...plan, milestones };
    });
  }

  async setStatus(id: string, expectedVersion: number, status: LongRangePlanStatus): Promise<LongRangePlanWithMilestones> {
    return this.db.transaction(async (transaction) => {
      const current = await this.requireCurrent(transaction as AppDatabase, id, expectedVersion);
      if (current.status === status) return (await this.withMilestones(transaction as AppDatabase, [current]))[0]!;
      const now = new Date();
      const [plan] = await transaction.update(longRangePlans).set({
        status,
        archivedAt: status === "archived" ? now : null,
        version: current.version + 1,
        updatedAt: now
      }).where(and(eq(longRangePlans.id, id), eq(longRangePlans.version, expectedVersion))).returning();
      if (!plan) throw new LongRangePlanVersionConflictError(await this.requirePlan(transaction as AppDatabase, id));
      return (await this.withMilestones(transaction as AppDatabase, [plan]))[0]!;
    });
  }

  private async withMilestones(database: AppDatabase, plans: StoredLongRangePlan[]): Promise<LongRangePlanWithMilestones[]> {
    if (plans.length === 0) return [];
    const ids = plans.map((plan) => plan.id);
    const milestones = await database.select().from(longRangePlanMilestones)
      .where(inArray(longRangePlanMilestones.longRangePlanId, ids))
      .orderBy(asc(longRangePlanMilestones.position));
    const byPlan = new Map<string, StoredLongRangeMilestone[]>();
    for (const milestone of milestones) {
      const current = byPlan.get(milestone.longRangePlanId) ?? [];
      current.push(milestone);
      byPlan.set(milestone.longRangePlanId, current);
    }
    return plans.map((plan) => ({ ...plan, milestones: byPlan.get(plan.id) ?? [] }));
  }

  private async insertMilestones(
    database: AppDatabase,
    planId: string,
    milestones: CreateLongRangePlan["milestones"],
    now: Date
  ): Promise<StoredLongRangeMilestone[]> {
    if (milestones.length === 0) return [];
    return database.insert(longRangePlanMilestones).values(milestones.map((milestone, position) => ({
      id: randomUUID(), longRangePlanId: planId, title: milestone.title,
      targetDate: milestone.targetDate ?? null, notes: milestone.notes ?? null,
      position, createdAt: now, updatedAt: now
    }))).returning();
  }

  private async requireCurrent(database: AppDatabase, id: string, expectedVersion: number): Promise<StoredLongRangePlan> {
    const current = await this.requirePlan(database, id);
    if (current.version !== expectedVersion) throw new LongRangePlanVersionConflictError(current);
    return current;
  }

  private async requirePlan(database: AppDatabase, id: string): Promise<StoredLongRangePlan> {
    const [plan] = await database.select().from(longRangePlans).where(eq(longRangePlans.id, id)).limit(1);
    if (!plan) throw new LongRangePlanNotFoundError();
    return plan;
  }
}
