import { connectVerifiedDatabase } from "@personal-ai/db/client";
import { loadDatabaseConfig } from "@personal-ai/db/config";
import { buildApp } from "./app.js";
import { PostgresTaskRepository } from "./task-repository.js";

const connection = await connectVerifiedDatabase(loadDatabaseConfig());
const app = buildApp({
  taskRepository: new PostgresTaskRepository(connection.db)
});

try {
  await connection.client.query("BEGIN");

  const createResponse = await app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    payload: {
      title: "database-persistence-verification",
      entryType: "task",
      date: "2099-12-31",
      estimatedMinutes: 1
    }
  });
  if (createResponse.statusCode !== 201) {
    throw new Error(`Task creation returned ${createResponse.statusCode}.`);
  }

  const listResponse = await app.inject({
    method: "GET",
    url: "/api/v1/tasks?date=2099-12-31"
  });
  const listed = listResponse.json<{ tasks: Array<{ title: string }> }>();
  if (listResponse.statusCode !== 200 || listed.tasks[0]?.title !== "database-persistence-verification") {
    throw new Error("Created task could not be read through the task API.");
  }

  console.log("Task persistence verified inside a rolled-back transaction.");
} finally {
  await connection.client.query("ROLLBACK");
  await app.close();
  await connection.client.end();
}
