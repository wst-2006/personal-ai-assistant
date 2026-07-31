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

  it("allows the Tauri desktop origin to call the local API", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "http://tauri.localhost" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe("http://tauri.localhost");
  });
});

describe("task endpoints", () => {
  it("creates and lists a day task", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: {
        title: "整理本周计划",
        scheduleKind: "none",
        localDate: "2026-07-27",
        plannedEffortMinutes: 30
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
      payload: { title: "", scheduleKind: "none" }
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects exact tasks outside the shared 30-minute contract", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: {
        title: "Off-grid task",
        scheduleKind: "exact",
        startAt: "2026-07-27T09:15:00+08:00",
        endAt: "2026-07-27T10:15:00+08:00",
        timeZone: "Asia/Shanghai"
      }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("invalid_task");
  });
});

describe("inbox endpoints", () => {
  it("keeps an idea as its source when the user confirms conversion to a task", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/inbox-entries",
      payload: { entryKind: "idea", content: "整理一份时间管理实验" }
    });
    expect(created.statusCode).toBe(201);
    const entry = created.json().entry;

    const listed = await app.inject({ method: "GET", url: "/api/v1/inbox-entries" });
    expect(listed.json().map((item: { id: string }) => item.id)).toContain(entry.id);

    const converted = await app.inject({
      method: "POST",
      url: `/api/v1/inbox-entries/${entry.id}/convert-to-task`,
      payload: {
        confirmed: true,
        expectedVersion: entry.version,
        task: { title: entry.content, scheduleKind: "none", localDate: "2026-07-27" }
      }
    });
    expect(converted.statusCode).toBe(201);
    expect(converted.json().task.sourceInboxEntryId).toBe(entry.id);
    expect(converted.json().entry.convertedAt).toBeTruthy();

    const after = await app.inject({ method: "GET", url: "/api/v1/inbox-entries" });
    expect(after.json().map((item: { id: string }) => item.id)).not.toContain(entry.id);
    const repeated = await app.inject({
      method: "POST",
      url: `/api/v1/inbox-entries/${entry.id}/convert-to-task`,
      payload: {
        confirmed: true,
        expectedVersion: entry.version,
        task: { title: entry.content, scheduleKind: "none" }
      }
    });
    expect(repeated.statusCode).toBe(409);
    expect(repeated.json().error).toBe("inbox_entry_conflict");
  });
});

describe("AI task parsing", () => {
  it("returns a candidate without writing a task", async () => {
    const parser: TaskParser = {
      async parse() {
        return {
          title: "学习线性代数", entryType: "task", date: "2026-07-28",
          startAt: "2026-07-28T09:00:00+08:00", endAt: "2026-07-28T10:00:00+08:00",
          plannedEffortMinutes: 45, difficulty: "medium", taskType: null,
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
