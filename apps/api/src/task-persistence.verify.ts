import { connectVerifiedDatabase } from "@personal-ai/db/client";
import { loadDatabaseConfig } from "@personal-ai/db/config";
import { buildApp } from "./app.js";
import { PostgresTaskStore } from "./task-repository.js";
import { TaskService } from "./task-service.js";

const connection = await connectVerifiedDatabase(loadDatabaseConfig());
const app = buildApp({
  taskService: new TaskService(new PostgresTaskStore(connection.db))
});

let createdTaskId: string | null = null;

try {
  const createResponse = await app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    payload: {
      title: "database-persistence-verification",
      scheduleKind: "exact",
      startAt: "2099-12-31T09:00:00+08:00",
      endAt: "2099-12-31T10:00:00+08:00",
      timeZone: "Asia/Shanghai"
    }
  });
  if (createResponse.statusCode !== 201) {
    throw new Error(`Task creation returned ${createResponse.statusCode}.`);
  }
  const createdTask = createResponse.json<{
    task: { id: string; version: number; scheduleRevision: number };
  }>().task;
  createdTaskId = createdTask.id;

  const listResponse = await app.inject({
    method: "GET",
    url: "/api/v1/tasks?date=2099-12-31"
  });
  const listed = listResponse.json<{ tasks: Array<{ title: string }> }>();
  if (listResponse.statusCode !== 200 || listed.tasks[0]?.title !== "database-persistence-verification") {
    throw new Error("Created task could not be read through the task API.");
  }

  const reminder = await connection.client.query<{
    kind: "task_start" | "task_start_ready" | "task_start_lapsed" | "task_start_expire";
    schedule_revision: number;
    scheduled_at: Date;
    available_at: Date;
    payload: { title?: string; scheduleRevision?: number };
  }>(`SELECT kind, schedule_revision, scheduled_at, available_at, payload FROM reminder_jobs WHERE task_id = $1 ORDER BY kind`, [createdTaskId]);
  const startReminder = reminder.rows.find((job) => job.kind === "task_start");
  const readyReminder = reminder.rows.find((job) => job.kind === "task_start_ready");
  const lapsedReminder = reminder.rows.find((job) => job.kind === "task_start_lapsed");
  const expiryReminder = reminder.rows.find((job) => job.kind === "task_start_expire");
  const validContract = (job: typeof reminder.rows[number] | undefined) => Boolean(job
    && job.schedule_revision === 1
    && job.payload.title === "database-persistence-verification"
    && job.payload.scheduleRevision === 1);
  if (![startReminder, readyReminder, lapsedReminder, expiryReminder].every(validContract)
    || startReminder!.scheduled_at.getTime() - startReminder!.available_at.getTime() !== 15 * 60 * 1000
    || readyReminder!.scheduled_at.getTime() - readyReminder!.available_at.getTime() !== 60 * 1000
    || lapsedReminder!.available_at.getTime() !== lapsedReminder!.scheduled_at.getTime()
    || expiryReminder!.available_at.getTime() - expiryReminder!.scheduled_at.getTime() !== 60 * 60 * 1000) {
    throw new Error("The four staged task reminders were not persisted with the exact schedule contract.");
  }

  const deleteResponse = await app.inject({
    method: "DELETE",
    url: `/api/v1/tasks/${createdTaskId}`,
    payload: { expectedVersion: createdTask.version, reason: "persistence verification" }
  });
  if (deleteResponse.statusCode !== 204) {
    throw new Error(`Task soft delete returned ${deleteResponse.statusCode}.`);
  }

  const trashResponse = await app.inject({
    method: "GET",
    url: "/api/v1/tasks/trash?date=2099-12-31"
  });
  const deletedTask = trashResponse.json<{
    tasks: Array<{ id: string; version: number; scheduleRevision: number; deletedAt: string | null }>;
  }>().tasks.find((task) => task.id === createdTaskId);
  if (
    trashResponse.statusCode !== 200
    || !deletedTask?.deletedAt
    || deletedTask.version !== createdTask.version + 1
    || deletedTask.scheduleRevision !== createdTask.scheduleRevision + 1
  ) {
    throw new Error("Soft-deleted task was not persisted in the trash with a new schedule revision.");
  }

  const restoreResponse = await app.inject({
    method: "POST",
    url: `/api/v1/tasks/${createdTaskId}/restore`,
    payload: { expectedVersion: deletedTask.version, conflictDecision: "reject" }
  });
  const restoredTask = restoreResponse.json<{
    task: { id: string; version: number; scheduleRevision: number; deletedAt: string | null };
  }>().task;
  if (
    restoreResponse.statusCode !== 200
    || restoredTask.id !== createdTaskId
    || restoredTask.deletedAt !== null
    || restoredTask.version !== deletedTask.version + 1
    || restoredTask.scheduleRevision !== deletedTask.scheduleRevision + 1
  ) {
    throw new Error("Restored task was not persisted with the expected version contract.");
  }

  const restoredReminders = await connection.client.query<{
    schedule_revision: number;
    status: string;
  }>(`SELECT schedule_revision, status FROM reminder_jobs WHERE task_id = $1`, [createdTaskId]);
  if (
    restoredReminders.rows.length !== 4
    || restoredReminders.rows.some((job) => job.schedule_revision !== restoredTask.scheduleRevision || job.status !== "pending")
  ) {
    throw new Error("Restoring the task did not re-arm all four revision-bound reminders.");
  }

  console.log("Task creation, reminders, trash, restore, and exact test-record cleanup were verified in PostgreSQL.");
} finally {
  await app.close();
  if (createdTaskId) {
    const transactionClient = await connection.client.connect();
    try {
      await transactionClient.query("BEGIN");
      await transactionClient.query("DELETE FROM reminder_jobs WHERE task_id = $1", [createdTaskId]);
      await transactionClient.query("DELETE FROM task_lifecycle_events WHERE task_id = $1", [createdTaskId]);
      await transactionClient.query("DELETE FROM tasks WHERE id = $1", [createdTaskId]);
      await transactionClient.query("COMMIT");
    } catch (error) {
      await transactionClient.query("ROLLBACK");
      throw error;
    } finally {
      transactionClient.release();
    }
  }
  await connection.client.end();
}
