import type { TaskParser } from "./ai/task-parser.js";
import type { PlanChangeAdviceRequest, PlanChangeAdvisor } from "./ai/plan-change-advisor.js";
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
        localDate: "2026-07-27"
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

  it("rejects retired task metadata instead of silently persisting it", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: { title: "旧字段不应进入任务", scheduleKind: "none", plannedEffortMinutes: 30 }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("invalid_task");
  });

  it("rejects the current and already elapsed half-hour window for today's exact tasks", async () => {
    const date = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
    }).format(new Date());
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: {
        title: "当前时间段不应创建",
        scheduleKind: "exact",
        startAt: `${date}T00:00:00+08:00`,
        endAt: `${date}T00:30:00+08:00`,
        timeZone: "Asia/Shanghai"
      }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("task_schedule_window_unavailable");
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
          schedulePrecision: "exact", notes: null,
          missingFields: ["notes"]
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

describe("AI plan-change consultation", () => {
  it("uses explicit task/day context and never writes an advisory as a task change", async () => {
    let received: PlanChangeAdviceRequest | null = null;
    const advisor: PlanChangeAdvisor = {
      async advise(request) {
        received = request;
        return {
          summary: "今天仍有空档，但需要由用户决定是否移动这项任务。",
          feasibility: "risky",
          affectedTaskIds: [request.task.id, "00000000-0000-4000-8000-000000000000"],
          options: [
            { title: "保持原计划", detail: "先处理临时安排，之后回到原来的时间块。" },
            { title: "手动调整", detail: "回到时间轴选择一个可接受的时间，再明确确认冲突。" }
          ],
          warnings: ["这只是建议，尚未修改任何任务。"]
        };
      }
    };
    const consultationStore = new MemoryTaskStore();
    const consultationApp = buildApp({
      taskService: new TaskService(consultationStore),
      planChangeAdvisor: advisor
    });
    try {
      const created = await consultationApp.inject({
        method: "POST",
        url: "/api/v1/tasks",
        payload: { title: "完成阶段报告", scheduleKind: "none", localDate: "2090-03-16", timeZone: "Asia/Shanghai" }
      });
      expect(created.statusCode).toBe(201);
      const task = created.json().task as { id: string; version: number; scheduleRevision: number };
      const before = structuredClone(consultationStore.tasks);

      const response = await consultationApp.inject({
        method: "POST",
        url: "/api/v1/ai/plan-change-advisories",
        payload: { taskId: task.id, message: "临时要处理另一件事，下午才有空。" }
      });

      expect(response.statusCode).toBe(200);
      const receivedRequest = received as PlanChangeAdviceRequest | null;
      expect(receivedRequest).toMatchObject({
        message: "临时要处理另一件事，下午才有空。",
        referenceDate: "2090-03-16",
        task: { id: task.id, title: "完成阶段报告", version: task.version, scheduleRevision: task.scheduleRevision }
      });
      expect(receivedRequest?.dayTasks.some((candidate) => candidate.id === task.id)).toBe(true);
      expect(response.json().advisory).toMatchObject({
        taskId: task.id,
        taskVersion: task.version,
        taskScheduleRevision: task.scheduleRevision,
        affectedTasks: [{ id: task.id, title: "完成阶段报告" }]
      });
      expect(response.json().advisory.affectedTasks).toHaveLength(1);
      expect(consultationStore.tasks).toEqual(before);
      expect(consultationStore.lifecycleEvents).toHaveLength(1);
    } finally {
      await consultationApp.close();
    }
  });

  it("rejects a consultation without the user's own explanation", async () => {
    const consultationApp = buildApp({
      taskService: new TaskService(new MemoryTaskStore()),
      planChangeAdvisor: { async advise() { throw new Error("must not run"); } }
    });
    try {
      const response = await consultationApp.inject({
        method: "POST",
        url: "/api/v1/ai/plan-change-advisories",
        payload: { taskId: "00000000-0000-4000-8000-000000000000", message: "" }
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("invalid_plan_change_consultation");
    } finally {
      await consultationApp.close();
    }
  });
});
