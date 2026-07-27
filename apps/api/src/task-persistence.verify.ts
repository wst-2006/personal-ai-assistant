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
      entryType: "task",
      scheduleKind: "none",
      localDate: "2099-12-31",
      estimatedMinutes: 1
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

  console.log("Task persistence verified with exact test-record cleanup.");
} finally {
  await app.close();
  if (createdTaskId) {
    await connection.client.query("BEGIN");
    try {
      await connection.client.query("DELETE FROM task_lifecycle_events WHERE task_id = $1", [createdTaskId]);
      await connection.client.query("DELETE FROM tasks WHERE id = $1", [createdTaskId]);
      await connection.client.query("COMMIT");
    } catch (error) {
      await connection.client.query("ROLLBACK");
      throw error;
    }
  }
  await connection.client.end();
}
