import type { AppDatabase } from "@personal-ai/db/client";
import { tasks } from "@personal-ai/db/schema";
import type { TaskInput } from "@personal-ai/domain/task";
import { asc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

export type StoredTask = typeof tasks.$inferSelect;

export interface TaskRepository {
  create(input: TaskInput): Promise<StoredTask>;
  list(localDate?: string): Promise<StoredTask[]>;
}

export class PostgresTaskRepository implements TaskRepository {
  constructor(private readonly db: AppDatabase) {}

  async create(input: TaskInput): Promise<StoredTask> {
    const [created] = await this.db
      .insert(tasks)
      .values({
        id: randomUUID(),
        title: input.title,
        entryType: input.entryType,
        lifecycleStatus: input.startAt || input.schedulePrecision ? "scheduled" : "unscheduled",
        localDate: input.date,
        startAt: input.startAt ? new Date(input.startAt) : null,
        endAt: input.endAt ? new Date(input.endAt) : null,
        estimatedMinutes: input.estimatedMinutes,
        difficulty: input.difficulty,
        taskType: input.taskType,
        requiresContinuousFocus: input.requiresContinuousFocus,
        schedulePrecision: input.schedulePrecision,
        notes: input.notes
      })
      .returning();

    if (!created) {
      throw new Error("PostgreSQL did not return the created task.");
    }

    return created;
  }

  async list(localDate?: string): Promise<StoredTask[]> {
    if (localDate) {
      return this.db
        .select()
        .from(tasks)
        .where(eq(tasks.localDate, localDate))
        .orderBy(asc(tasks.startAt), asc(tasks.createdAt));
    }

    return this.db.select().from(tasks).orderBy(asc(tasks.startAt), asc(tasks.createdAt));
  }
}
