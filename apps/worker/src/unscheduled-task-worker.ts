import type { AppDatabase } from "@personal-ai/db/client";
import { sql } from "drizzle-orm";

export type UnscheduledTaskPolicy = "carry_forward" | "delete_at_day_end";

export type UnscheduledTaskDayEndResult = {
  localDate: string;
  policy: UnscheduledTaskPolicy;
  carriedCount: number;
  deletedCount: number;
};

export function localDateInTimeZone(now: Date, timeZone = "Asia/Shanghai"): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(now);
}

export class UnscheduledTaskWorker {
  constructor(private readonly db: AppDatabase) {}

  async processNext(now = new Date()): Promise<UnscheduledTaskDayEndResult | "idle"> {
    const today = localDateInTimeZone(now);

    return this.db.transaction(async (transaction) => {
      const dateResult = await transaction.execute(sql`
        SELECT min(task.local_date)::text AS "localDate"
        FROM tasks task
        LEFT JOIN unscheduled_task_day_end_runs run ON run.local_date = task.local_date
        WHERE task.record_kind = 'formal'
          AND task.lifecycle_status = 'open'
          AND task.schedule_kind = 'none'
          AND task.local_date IS NOT NULL
          AND task.local_date < ${today}::date
          AND task.deleted_at IS NULL
          AND run.local_date IS NULL
      `);
      const localDate = (dateResult.rows[0] as { localDate?: string | null } | undefined)?.localDate ?? null;
      if (!localDate) return "idle";

      const policyResult = await transaction.execute(sql`
        SELECT coalesce(
          (SELECT unscheduled_task_policy FROM user_profiles WHERE id = 1),
          'carry_forward'
        ) AS policy
      `);
      const policy = ((policyResult.rows[0] as { policy?: string } | undefined)?.policy ?? "carry_forward") as UnscheduledTaskPolicy;
      if (policy !== "carry_forward" && policy !== "delete_at_day_end") {
        throw new Error(`Unsupported unscheduled task policy: ${policy}`);
      }

      const claimResult = await transaction.execute(sql`
        INSERT INTO unscheduled_task_day_end_runs (
          local_date, policy, carried_count, deleted_count, completed_at, created_at
        ) VALUES (${localDate}::date, ${policy}, 0, 0, ${now}, ${now})
        ON CONFLICT (local_date) DO NOTHING
        RETURNING local_date
      `);
      if (claimResult.rows.length === 0) return "idle";

      const affectedResult = policy === "carry_forward"
        ? await transaction.execute(sql`
            UPDATE tasks
            SET local_date = local_date + 1,
                version = version + 1,
                schedule_revision = schedule_revision + 1,
                updated_at = ${now}
            WHERE record_kind = 'formal'
              AND lifecycle_status = 'open'
              AND schedule_kind = 'none'
              AND local_date = ${localDate}::date
              AND deleted_at IS NULL
            RETURNING id
          `)
        : await transaction.execute(sql`
            UPDATE tasks
            SET deleted_at = ${now},
                version = version + 1,
                schedule_revision = schedule_revision + 1,
                updated_at = ${now}
            WHERE record_kind = 'formal'
              AND lifecycle_status = 'open'
              AND schedule_kind = 'none'
              AND local_date = ${localDate}::date
              AND deleted_at IS NULL
            RETURNING id
          `);

      const affectedCount = affectedResult.rows.length;
      const carriedCount = policy === "carry_forward" ? affectedCount : 0;
      const deletedCount = policy === "delete_at_day_end" ? affectedCount : 0;
      await transaction.execute(sql`
        UPDATE unscheduled_task_day_end_runs
        SET carried_count = ${carriedCount},
            deleted_count = ${deletedCount},
            completed_at = ${now}
        WHERE local_date = ${localDate}::date
      `);

      return { localDate, policy, carriedCount, deletedCount };
    }, { isolationLevel: "serializable" });
  }
}
