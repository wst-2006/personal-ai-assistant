import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeepSeekConfig } from "./config.js";
import {
  DeepSeekPlanChangeAdvisor,
  filterAdviceToKnownTasks,
  type PlanChangeAdviceRequest,
  type PlanChangeTaskContext
} from "./plan-change-advisor.js";

const config: DeepSeekConfig = {
  DEEPSEEK_API_KEY: "test-key",
  DEEPSEEK_BASE_URL: "https://api.deepseek.com",
  DEEPSEEK_MODEL: "deepseek-v4-flash",
  DEEPSEEK_TIMEOUT_MS: 30_000,
  DEEPSEEK_MAX_RETRIES: 0,
  DEEPSEEK_MAX_OUTPUT_TOKENS: 1_200,
  DEEPSEEK_USER_CONTEXT_MAX_CHARS: 6_000
};

const openTask: PlanChangeTaskContext = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "完成阶段报告",
  lifecycleStatus: "open",
  scheduleKind: "none",
  localDate: "2090-03-16",
  daypart: null,
  startAt: null,
  endAt: null,
  timeZone: "Asia/Shanghai",
  notes: null,
  version: 3,
  scheduleRevision: 2
};

const lockedTask: PlanChangeTaskContext = {
  ...openTask,
  id: "22222222-2222-4222-8222-222222222222",
  title: "正在执行的任务",
  lifecycleStatus: "active"
};

const request: PlanChangeAdviceRequest = {
  message: "下午三点以后才有空。",
  referenceDate: "2090-03-16",
  currentTime: "2090-03-16T02:00:00.000Z",
  task: openTask,
  dayTasks: [openTask, lockedTask]
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DeepSeekPlanChangeAdvisor", () => {
  it("returns a validated schedule candidate without giving the model write authority", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        summary: "可以调整到下午，但仍需用户确认。",
        feasibility: "feasible",
        affectedTaskIds: [openTask.id],
        options: [{
          title: "下午处理",
          detail: "候选时间为下午三点到四点。",
          adjustments: [{
            taskId: openTask.id,
            scheduleKind: "exact",
            localDate: null,
            daypart: null,
            startAt: "2090-03-16T15:00:00+08:00",
            endAt: "2090-03-16T16:00:00+08:00",
            timeZone: "Asia/Shanghai",
            reason: "符合用户说明的可用时间。"
          }]
        }],
        warnings: []
      }) } }]
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const advice = await new DeepSeekPlanChangeAdvisor(config).advise(request);

    expect(advice.options[0]?.adjustments[0]).toMatchObject({ taskId: openTask.id, scheduleKind: "exact" });
    const payload = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(payload.messages[0].content).toContain("不能创建、取消或关闭任务");
    expect(JSON.parse(payload.messages[1].content)).toMatchObject({
      currentTime: request.currentTime,
      task: { id: openTask.id, version: 3, scheduleRevision: 2 }
    });
  });

  it("rejects schedule candidates that violate the confirmed field matrix", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        summary: "错误候选",
        feasibility: "feasible",
        affectedTaskIds: [openTask.id],
        options: [{
          title: "错误候选",
          detail: "none 不应带精确时间。",
          adjustments: [{
            taskId: openTask.id,
            scheduleKind: "none",
            localDate: "2090-03-16",
            daypart: null,
            startAt: "2090-03-16T15:00:00+08:00",
            endAt: "2090-03-16T16:00:00+08:00",
            timeZone: "Asia/Shanghai",
            reason: "无效。"
          }]
        }],
        warnings: []
      }) } }]
    }), { status: 200 })));

    await expect(new DeepSeekPlanChangeAdvisor(config).advise(request)).rejects.toThrow();
  });

  it("keeps read-only advice usable when the provider omits an empty adjustments array", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        summary: "信息还不够，先不要改动任务。",
        feasibility: "needs_clarification",
        affectedTaskIds: [openTask.id],
        options: [{ title: "保持原计划", detail: "补充可用时间后再生成排期候选。" }],
        warnings: ["请说明新的可用时间。"]
      }) } }]
    }), { status: 200 })));

    const advice = await new DeepSeekPlanChangeAdvisor(config).advise(request);

    expect(advice.options[0]?.adjustments).toEqual([]);
  });
});

describe("filterAdviceToKnownTasks", () => {
  it("keeps only changed schedule drafts for known open tasks", () => {
    const filtered = filterAdviceToKnownTasks({
      summary: "候选",
      feasibility: "risky",
      affectedTaskIds: [openTask.id, lockedTask.id, "33333333-3333-4333-8333-333333333333"],
      options: [{
        title: "逐项确认",
        detail: "只保留可执行草稿。",
        adjustments: [
          {
            taskId: openTask.id,
            scheduleKind: "exact",
            localDate: null,
            daypart: null,
            startAt: "2090-03-16T15:00:00+08:00",
            endAt: "2090-03-16T16:00:00+08:00",
            timeZone: "Asia/Shanghai",
            reason: "有效候选。"
          },
          {
            taskId: lockedTask.id,
            scheduleKind: "daypart",
            localDate: "2090-03-16",
            daypart: "evening",
            startAt: null,
            endAt: null,
            timeZone: "Asia/Shanghai",
            reason: "锁定任务不能移动。"
          },
          {
            taskId: openTask.id,
            scheduleKind: "none",
            localDate: "2090-03-16",
            daypart: null,
            startAt: null,
            endAt: null,
            timeZone: "Asia/Shanghai",
            reason: "与当前排期相同。"
          }
        ]
      }],
      warnings: []
    }, new Map([[openTask.id, openTask], [lockedTask.id, lockedTask]]));

    expect(filtered.affectedTaskIds).toEqual([openTask.id, lockedTask.id]);
    expect(filtered.options[0]?.adjustments).toHaveLength(1);
    expect(filtered.options[0]?.adjustments[0]?.taskId).toBe(openTask.id);
  });
});
