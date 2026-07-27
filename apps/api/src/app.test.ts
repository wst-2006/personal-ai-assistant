import type { TaskParser } from "./ai/task-parser.js";
import { buildApp } from "./app.js";
import { TaskService } from "./task-service.js";
import { MemoryTaskStore } from "./testing/memory-task-store.js";
import { afterAll, describe, expect, it } from "vitest";

const store = new MemoryTaskStore();
const app = buildApp({ taskService: new TaskService(store) });

afterAll(async () => {
  await app.close();
});

describe("health endpoint", () => {
  it("reports the API service as available", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", service: "personal-ai-api" });
  });
});

describe("task endpoints", () => {
  it("creates and lists a day task", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: {
        title: "整理本周计划",
        entryType: "task",
        scheduleKind: "none",
        localDate: "2026-07-27",
        estimatedMinutes: 30
      }
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().task.lifecycleStatus).toBe("open");

    const list = await app.inject({ method: "GET", url: "/api/v1/tasks?date=2026-07-27" });
    expect(list.statusCode).toBe(200);
    expect(list.json().tasks).toHaveLength(1);
  });

  it("rejects an empty task title", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: { title: "", entryType: "task", scheduleKind: "none" }
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("AI task parsing", () => {
  it("returns a candidate without writing a task", async () => {
    const parser: TaskParser = {
      async parse() {
        return {
          title: "学习线性代数", entryType: "task", date: "2026-07-28",
          startAt: "2026-07-28T09:00:00+08:00", endAt: "2026-07-28T09:45:00+08:00",
          estimatedMinutes: 45, difficulty: "medium", taskType: null,
          requiresContinuousFocus: null, schedulePrecision: "exact", notes: null,
          missingFields: ["taskType", "requiresContinuousFocus", "notes"]
        };
      }
    };
    const aiStore = new MemoryTaskStore();
    const aiApp = buildApp({ taskService: new TaskService(aiStore), taskParser: parser });
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
    expect(aiStore.tasks).toHaveLength(0);
    await aiApp.close();
  });
});
