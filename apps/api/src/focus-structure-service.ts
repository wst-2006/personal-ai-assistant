import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, isNull, ne } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { AppDatabase } from "@personal-ai/db/client";
import { focusStructureSegments, focusStructures, tasks } from "@personal-ai/db/schema";
import {
  allocateContinuousFocusStructure,
  focusStructureInputSchema,
  validateSegmentedFocusStructure,
  type FocusStructureInput,
  type FocusSegment
} from "@personal-ai/domain/focus";
import type { FocusStructurePlanner } from "./ai/focus-structure-planner.js";

export type StoredFocusStructure = typeof focusStructures.$inferSelect;
export type StoredFocusStructureSegment = typeof focusStructureSegments.$inferSelect;
export type FocusStructureWithSegments = {
  structure: StoredFocusStructure;
  segments: StoredFocusStructureSegment[];
};

export class FocusStructureNotFoundError extends Error {}
export class FocusStructureTaskConflictError extends Error {
  constructor(readonly currentTask: typeof tasks.$inferSelect) {
    super("The task version or schedule revision no longer matches the focus structure candidate.");
  }
}
export class FocusStructureVersionConflictError extends Error {
  constructor(readonly current: FocusStructureWithSegments) {
    super("The focus structure version no longer matches the candidate.");
  }
}
export class InvalidFocusStructureError extends Error {}
export class FocusStructureStateError extends Error {
  constructor(readonly state: string, readonly operation: string) {
    super(`Cannot ${operation} a focus structure in ${state} state.`);
  }
}

export class FocusStructureService {
  constructor(private readonly db: AppDatabase) {}

  async createCandidate(input: FocusStructureInput): Promise<FocusStructureWithSegments> {
    const parsed = focusStructureInputSchema.parse(input);
    return this.runSerializable(async (transaction) => {
      const task = await this.requireTask(transaction, parsed.taskId);
      this.assertTaskVersion(task, parsed.taskVersion, parsed.taskScheduleRevision);
      if (task.lifecycleStatus !== "open") throw new InvalidFocusStructureError("Only open tasks can receive a focus structure candidate.");
      if (task.scheduleKind !== "exact" || !task.startAt || !task.endAt) {
        throw new InvalidFocusStructureError("Focus structures require an exact task interval.");
      }

      const allocation = parsed.mode === "continuous"
        ? allocateContinuousFocusStructure({
            totalStartAt: task.startAt,
            totalEndAt: task.endAt,
            breakMinutes: parsed.breakMinutes
          })
        : validateSegmentedFocusStructure({
            totalStartAt: task.startAt,
            totalEndAt: task.endAt,
            segments: parsed.segments as FocusSegment[]
          });

      const now = new Date();
      const [structure] = await transaction.insert(focusStructures).values({
        id: randomUUID(),
        taskId: task.id,
        taskScheduleRevision: task.scheduleRevision,
        state: "candidate",
        source: parsed.source,
        version: 1,
        totalStartAt: allocation.totalStartAt,
        totalEndAt: allocation.totalEndAt,
        createdAt: now,
        updatedAt: now
      }).returning();
      if (!structure) throw new Error("PostgreSQL did not return the focus structure candidate.");

      const segments = allocation.segments.map((segment, position) => ({
        id: randomUUID(),
        focusStructureId: structure.id,
        position,
        segmentType: segment.segmentType,
        durationMinutes: segment.durationMinutes,
        createdAt: now
      }));
      await transaction.insert(focusStructureSegments).values(segments);
      return { structure, segments: await this.listSegments(transaction, structure.id) };
    });
  }

  async createAiCandidate(input: {
    taskId: string;
    taskVersion: number;
    taskScheduleRevision: number;
    instructions: string | null;
  }, planner: FocusStructurePlanner): Promise<FocusStructureWithSegments> {
    const task = await this.requireTask(this.db, input.taskId);
    this.assertTaskVersion(task, input.taskVersion, input.taskScheduleRevision);
    if (task.lifecycleStatus !== "open" || task.scheduleKind !== "exact" || !task.startAt || !task.endAt) {
      throw new InvalidFocusStructureError("AI focus planning requires an open task with an exact interval.");
    }
    const totalMinutes = (task.endAt.getTime() - task.startAt.getTime()) / 60_000;
    const segments = await planner.plan({
      title: task.title,
      totalStartAt: task.startAt.toISOString(),
      totalEndAt: task.endAt.toISOString(),
      totalMinutes,
      instructions: input.instructions
    });
    const focusCount = segments.filter((segment) => segment.segmentType === "focus").length;
    if (totalMinutes === 30) {
      if (segments.length !== 1 || segments[0]?.segmentType !== "focus" || segments[0].durationMinutes !== 30) {
        throw new InvalidFocusStructureError("AI returned an invalid 30-minute focus structure.");
      }
    } else {
      try {
        validateSegmentedFocusStructure({ totalStartAt: task.startAt, totalEndAt: task.endAt, segments });
      } catch (error) {
        throw new InvalidFocusStructureError(`AI returned an invalid focus structure: ${error instanceof Error ? error.message : "unknown validation error"}`);
      }
    }
    const breakMinutes = segments.find((segment) => segment.segmentType === "break")?.durationMinutes ?? 0;
    return this.createCandidate({
      taskId: task.id,
      taskVersion: task.version,
      taskScheduleRevision: task.scheduleRevision,
      source: "ai",
      mode: focusCount === 1 ? "continuous" : "segmented",
      totalStartAt: task.startAt.toISOString(),
      totalEndAt: task.endAt.toISOString(),
      breakMinutes,
      ...(focusCount === 1 ? {} : { segments })
    });
  }

  async list(taskId: string): Promise<FocusStructureWithSegments[]> {
    const structures = await this.db.select().from(focusStructures)
      .where(eq(focusStructures.taskId, taskId))
      .orderBy(desc(focusStructures.createdAt));
    const results: FocusStructureWithSegments[] = [];
    for (const structure of structures) {
      results.push({ structure, segments: await this.listSegments(this.db, structure.id) });
    }
    return results;
  }

  async confirm(
    id: string,
    expectedVersion: number,
    expectedTaskVersion: number,
    expectedTaskScheduleRevision: number
  ): Promise<FocusStructureWithSegments> {
    return this.runSerializable(async (transaction) => {
      const current = await this.requireStructure(transaction, id);
      if (current.structure.version !== expectedVersion) throw new FocusStructureVersionConflictError(current);
      if (current.structure.state === "active") return current;
      if (current.structure.state !== "candidate") throw new FocusStructureStateError(current.structure.state, "confirm");

      const task = await this.requireTask(transaction, current.structure.taskId);
      this.assertTaskVersion(task, expectedTaskVersion, expectedTaskScheduleRevision);
      if (current.structure.taskScheduleRevision !== task.scheduleRevision) {
        throw new FocusStructureTaskConflictError(task);
      }

      const now = new Date();
      await transaction.update(focusStructures).set({
        state: "superseded", supersededAt: now, version: sql`${focusStructures.version} + 1`, updatedAt: now
      }).where(and(eq(focusStructures.taskId, task.id), eq(focusStructures.state, "active"), ne(focusStructures.id, id)));
      const [confirmed] = await transaction.update(focusStructures).set({
        state: "active", confirmedAt: now, version: current.structure.version + 1, updatedAt: now
      }).where(and(eq(focusStructures.id, id), eq(focusStructures.version, expectedVersion), eq(focusStructures.state, "candidate"))).returning();
      if (!confirmed) throw new FocusStructureVersionConflictError(await this.requireStructure(transaction, id));
      return { structure: confirmed, segments: await this.listSegments(transaction, id) };
    });
  }

  async cancel(id: string, expectedVersion: number): Promise<FocusStructureWithSegments> {
    return this.runSerializable(async (transaction) => {
      const current = await this.requireStructure(transaction, id);
      if (current.structure.version !== expectedVersion) throw new FocusStructureVersionConflictError(current);
      if (current.structure.state !== "candidate") throw new FocusStructureStateError(current.structure.state, "cancel");
      const now = new Date();
      const [cancelled] = await transaction.update(focusStructures).set({
        state: "cancelled", version: current.structure.version + 1, updatedAt: now
      }).where(and(
        eq(focusStructures.id, id),
        eq(focusStructures.version, expectedVersion),
        eq(focusStructures.state, "candidate")
      )).returning();
      if (!cancelled) throw new FocusStructureVersionConflictError(await this.requireStructure(transaction, id));
      return { structure: cancelled, segments: await this.listSegments(transaction, id) };
    });
  }

  private async requireTask(db: AppDatabase, id: string): Promise<typeof tasks.$inferSelect> {
    const [task] = await db.select().from(tasks).where(and(eq(tasks.id, id), isNull(tasks.deletedAt))).limit(1);
    if (!task) throw new FocusStructureNotFoundError();
    return task;
  }

  private assertTaskVersion(task: typeof tasks.$inferSelect, expectedVersion: number, expectedRevision: number): void {
    if (task.version !== expectedVersion || task.scheduleRevision !== expectedRevision) {
      throw new FocusStructureTaskConflictError(task);
    }
  }

  private async requireStructure(db: AppDatabase, id: string): Promise<FocusStructureWithSegments> {
    const [structure] = await db.select().from(focusStructures).where(eq(focusStructures.id, id)).limit(1);
    if (!structure) throw new FocusStructureNotFoundError();
    return { structure, segments: await this.listSegments(db, id) };
  }

  private listSegments(db: AppDatabase, id: string): Promise<StoredFocusStructureSegment[]> {
    return db.select().from(focusStructureSegments)
      .where(eq(focusStructureSegments.focusStructureId, id))
      .orderBy(asc(focusStructureSegments.position));
  }

  private async runSerializable<T>(operation: (transaction: AppDatabase) => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.db.transaction(
          async (transaction) => operation(transaction as unknown as AppDatabase),
          { isolationLevel: "serializable" }
        );
      } catch (error) {
        if (!isSerializationFailure(error) || attempt === 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, attempt * 20));
      }
    }
    throw new Error("Focus structure transaction retry budget exhausted.");
  }
}

function isSerializationFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "40001";
}
