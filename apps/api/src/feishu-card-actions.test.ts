import { describe, expect, it, vi } from "vitest";
import type { FocusService } from "./focus-service.js";
import {
  FeishuActionAuthError,
  FeishuCardActionService,
  loadFeishuCardActionConfig
} from "./feishu-card-actions.js";
import type { TaskService } from "./task-service.js";

const taskId = "7f9a4ad8-4dc7-4d18-92df-1d8be780a1b1";

function service(
  createdState: "armed" | "running" = "armed",
  current: { id: string; taskId: string; version: number; state: string } | null = null
) {
  const task = {
    id: taskId,
    title: "整理产品原型",
    version: 8,
    scheduleRevision: 3,
    lifecycleStatus: "open",
    localDate: null,
    startAt: new Date("2099-08-15T07:00:00.000Z"),
    endAt: new Date("2099-08-15T08:00:00.000Z")
  };
  const taskService = {
    get: vi.fn().mockResolvedValue({ task }),
    update: vi.fn().mockResolvedValue({ task: { ...task, scheduleKind: "none" }, historicalOverlaps: [] }),
    cancel: vi.fn().mockResolvedValue({ ...task, lifecycleStatus: "cancelled" }),
    cancelAndTrash: vi.fn().mockResolvedValue({ ...task, lifecycleStatus: "cancelled", deletedAt: new Date() })
  };
  const focusService = {
    currentForTask: vi.fn().mockResolvedValue(current),
    create: vi.fn().mockResolvedValue({ id: "focus-1", taskId, version: 2, state: createdState }),
    otherArrangement: vi.fn().mockResolvedValue({ id: "focus-1", taskId, version: 3, state: "stopped_no_response" })
  };
  return {
    taskService,
    focusService,
    actions: new FeishuCardActionService(
      { targetOpenId: "ou_owner" },
      taskService as unknown as TaskService,
      focusService as unknown as FocusService
    )
  };
}

describe("Feishu card actions", () => {
  it("loads only the configured single-user target", () => {
    expect(loadFeishuCardActionConfig({ FEISHU_TARGET_OPEN_ID: "  ou_owner  " })).toEqual({ targetOpenId: "ou_owner" });
    expect(loadFeishuCardActionConfig({})).toBeNull();
  });

  it("rejects any operator except the configured owner", async () => {
    const { actions } = service();
    await expect(actions.handle("ou_other", { action: "start", taskId, scheduleRevision: 3 }))
      .rejects.toBeInstanceOf(FeishuActionAuthError);
  });

  it("arms an explicitly confirmed task and replaces every card action", async () => {
    const { actions, focusService } = service("armed");
    const commandId = "00000000-0000-4000-8000-000000000003";
    const result = await actions.handle("ou_owner", { action: "start", taskId, scheduleRevision: 3, commandId });

    expect(result).toMatchObject({ type: "success", message: expect.stringContaining("任务已经开始"), card: expect.any(Object) });
    expect(JSON.stringify(result.card)).toContain("任务已经开始");
    expect(JSON.stringify(result.card)).toContain("开始：15:00");
    expect(JSON.stringify(result.card)).toContain("结束：16:00");
    expect(JSON.stringify(result.card)).not.toContain("另有安排");
    expect(JSON.stringify(result.card)).not.toContain("取消任务");
    expect(focusService.create).toHaveBeenCalledWith(taskId, 8, "prepare", commandId);
  });

  it("records an explicit start as running without backfilling", async () => {
    const { actions } = service("running", {
      id: "focus-late",
      taskId,
      version: 4,
      state: "awaiting_late_start"
    });
    await expect(actions.handle("ou_owner", { action: "start", taskId, scheduleRevision: 3 }))
      .resolves.toMatchObject({ type: "success", message: expect.stringContaining("从现在计时") });
  });

  it("treats a repeated start for the same running task as idempotent success", async () => {
    const { actions, focusService } = service("armed", {
      id: "focus-running",
      taskId,
      version: 6,
      state: "running"
    });
    const result = await actions.handle("ou_owner", { action: "start", taskId, scheduleRevision: 3 });

    expect(result).toMatchObject({ type: "success", card: expect.any(Object) });
    expect(JSON.stringify(result.card)).toContain("任务已经开始");
    expect(focusService.create).not.toHaveBeenCalled();
  });

  it("invalidates arrangement and cancellation controls immediately after confirmation", async () => {
    const { actions, taskService, focusService } = service("armed", {
      id: "focus-armed",
      taskId,
      version: 5,
      state: "armed"
    });
    const result = await actions.handle("ou_owner", { action: "other_arrangement", taskId, scheduleRevision: 3 });

    expect(result).toMatchObject({ type: "success", message: expect.stringContaining("操作已失效"), card: expect.any(Object) });
    expect(taskService.update).not.toHaveBeenCalled();
    expect(focusService.otherArrangement).not.toHaveBeenCalled();
  });

  it("returns an unstarted task to the unscheduled list and replaces the card", async () => {
    const { actions, taskService, focusService } = service("armed", {
      id: "focus-preparing",
      taskId,
      version: 4,
      state: "preparing"
    });
    const commandId = "00000000-0000-4000-8000-000000000004";
    const result = await actions.handle("ou_owner", { action: "other_arrangement", taskId, scheduleRevision: 3, commandId });

    expect(result).toMatchObject({ type: "success", message: "已退回未排期任务。", card: expect.any(Object) });
    expect(focusService.otherArrangement).toHaveBeenCalledWith("focus-preparing", 4, "飞书选择另有安排", expect.any(String));
    expect(taskService.update).toHaveBeenCalledWith(taskId, expect.objectContaining({ scheduleKind: "none", startAt: null, endAt: null }));
    expect(JSON.stringify(result.card)).not.toContain("开始任务");
  });

  it("requires a second cancellation confirmation and then replaces the card", async () => {
    const { actions, taskService } = service();
    const first = await actions.handle("ou_owner", { action: "cancel_request", taskId, scheduleRevision: 3 });
    expect(first).toMatchObject({ type: "success", card: expect.any(Object) });
    expect(JSON.stringify(first.card)).toContain("确认取消");
    expect(JSON.stringify(first.card)).toContain("开始：15:00");
    expect(JSON.stringify(first.card)).toContain("结束：16:00");
    expect(taskService.cancel).not.toHaveBeenCalled();

    const confirmed = await actions.handle("ou_owner", { action: "cancel_confirm", taskId, scheduleRevision: 3 });
    expect(confirmed).toMatchObject({ type: "success", message: "任务已取消并移入回收站。", card: expect.any(Object) });
    expect(taskService.cancelAndTrash).toHaveBeenCalledWith(taskId, 8, "飞书二次确认取消任务");
    expect(JSON.stringify(confirmed.card)).not.toContain("确认取消");
  });
});
