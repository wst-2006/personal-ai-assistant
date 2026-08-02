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
      timeZone: "Asia/Shanghai",
      plannedEffortMinutes: 60
    }
  });
  if (createResponse.statusCode !== 201) {
    throw new Error(`Task creation returned ${createResponse.statusCode}.`);
  }
  createdTaskId = createResponse.json<{ task: { id: string } }>().task.id;

  const listResponse = await app.inject({
    method: "GET",
    url: "/api/v1/tasks?date=2099-12-31"
  });
  const listed = listResponse.json<{ tasks: Array<{ title: string }> }>();
  if (listResponse.statusCode !== 200 || listed.tasks[0]?.title !== "database-persistence-verification") {
    throw new Error("Created task could not be read through the task API.");
  }

  const reminder = await connection.client.query<{
    schedule_revision: number;
    scheduled_at: Date;
    available_at: Date;
    payload: { title?: string; scheduleRevision?: number };
  }>(`SELECT schedule_revision, scheduled_at, available_at, payload FROM reminder_jobs WHERE task_id = $1`, [createdTaskId]);
  const job = reminder.rows[0];
  if (!job || job.schedule_revision !== 1 || job.scheduled_at.getTime() - job.available_at.getTime() !== 15 * 60 * 1000
    || job.payload.title !== "database-persistence-verification" || job.payload.scheduleRevision !== 1) {
    throw new Error("Task reminder was not persisted with the exact schedule contract.");
  }

  console.log("Task and 15-minute reminder persistence verified with exact test-record cleanup.");
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
