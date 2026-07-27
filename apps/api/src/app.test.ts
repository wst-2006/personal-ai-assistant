import { afterAll, describe, expect, it } from "vitest";
import type { TaskParser } from "./ai/task-parser.js";
import { buildApp } from "./app.js";
import type { StoredTask, TaskRepository } from "./task-repository.js";

class MemoryTaskRepository implements TaskRepository {
  tasks: StoredTask[] = [];

  async create(input: Parameters<TaskRepository["create"]>[0]): Promise<StoredTask> {
    const now = new Date();
    const task: StoredTask = {
      id: "05d71d7e-d6d3-4e27-ab77-da5a41a90cbe",
      title: input.title,
      entryType: input.entryType,
      lifecycleStatus: "unscheduled",
      objectiveOutcome: null,
      localDate: input.date ?? null,
      startAt: null,
      endAt: null,
      estimatedMinutes: input.estimatedMinutes ?? null,
      difficulty: input.difficulty ?? null,
      taskType: input.taskType ?? null,
      requiresContinuousFocus: input.requiresContinuousFocus ?? null,
      schedulePrecision: input.schedulePrecision ?? null,
      notes: input.notes ?? null,
      version: 1,
      createdAt: now,
      updatedAt: now
    };
    this.tasks.push(task);
    return task;
  }

  async list(localDate?: string): Promise<StoredTask[]> {
    return localDate ? this.tasks.filter((task) => task.localDate === localDate) : this.tasks;
  }
}

const repository = new MemoryTaskRepository();
const app = buildApp({ taskRepository: repository });

afterAll(async () => {
  await app.close();
});

describe("health endpoint", () => {
  it("reports the API service as available", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ok",
      service: "personal-ai-api"
    });
  });
});

describe("task endpoints", () => {
  it("creates a form task without invoking AI", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: {
        title: "整理本周计划",
        entryType: "task",
        date: "2026-07-27",
        estimatedMinutes: 30
      }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().task.title).toBe("整理本周计划");
  });

  it("lists tasks for a local date", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/tasks?date=2026-07-27"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().tasks).toHaveLength(1);
  });

  it("rejects an empty task title", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: { title: "", entryType: "task" }
    });

    expect(response.statusCode).toBe(400);
  });
});

describe("AI task parsing", () => {
  it("returns a candidate without writing a task", async () => {
    const parser: TaskParser = {
      async parse() {
        return {
          title: "学习线性代数",
          entryType: "task",
          date: "2026-07-28",
          startAt: "2026-07-28T09:00:00+08:00",
          endAt: "2026-07-28T09:45:00+08:00",
          estimatedMinutes: 45,
          difficulty: "medium",
          taskType: null,
          requiresContinuousFocus: null,
          schedulePrecision: "exact",
          notes: null,
          missingFields: ["taskType", "requiresContinuousFocus", "notes"]
        };
      }
    };
    const aiApp = buildApp({ taskRepository: repository, taskParser: parser });
    const taskCountBefore = repository.tasks.length;

    const response = await aiApp.inject({
      method: "POST",
      url: "/api/v1/ai/tasks/parse",
      payload: {
        text: "明天上午九点用45分钟学习线性代数，难度中等",
        referenceDate: "2026-07-27",
        timeZone: "Asia/Shanghai"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().candidate.title).toBe("学习线性代数");
    expect(repository.tasks).toHaveLength(taskCountBefore);
    await aiApp.close();
  });
});
