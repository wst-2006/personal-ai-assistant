import { describe, expect, it, vi } from "vitest";
import { FeishuDeliveryProvider, loadFeishuConfig } from "./feishu-delivery.js";
import type { ReminderJob } from "./worker-core.js";

const baseJob: ReminderJob = {
  id: "job-1",
  taskId: "task-1",
  channel: "feishu",
  kind: "task_start",
  attempts: 1,
  scheduleRevision: 4,
  scheduledAt: new Date("2026-08-16T02:00:00.000Z"),
  payload: {
    taskId: "task-1",
    title: "阅读论文",
    startAt: "2026-08-16T02:00:00.000Z",
    endAt: "2026-08-16T03:00:00.000Z",
    timeZone: "Asia/Shanghai",
    scheduleRevision: 4
  }
};

function fetcherWithMessage(messageId = "om_initial") {
  return vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, tenant_access_token: "token", expire: 7200 }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, msg: "success", data: { message_id: messageId } }), { status: 200 }));
}

describe("Feishu reminder delivery", () => {
  it("stays disabled until every server-only delivery value exists", () => {
    expect(loadFeishuConfig({})).toBeNull();
    expect(loadFeishuConfig({ FEISHU_APP_ID: "id", FEISHU_APP_SECRET: "secret" })).toBeNull();
    expect(loadFeishuConfig({ FEISHU_APP_ID: "id", FEISHU_APP_SECRET: "secret", FEISHU_TARGET_OPEN_ID: "ou_x" }))
      .toMatchObject({ appId: "id", targetOpenId: "ou_x" });
  });

  it("sends the T-15 card without a start or desktop-open action and persists its message id", async () => {
    const fetcher = fetcherWithMessage();
    const provider = new FeishuDeliveryProvider({ appId: "id", appSecret: "secret", targetOpenId: "ou_x" }, fetcher);

    const result = await provider.deliver(baseJob, {
      now: new Date("2026-08-16T01:45:00.000Z"),
      timing: "upcoming"
    });

    expect(result).toEqual({ remoteMessageId: "om_initial" });
    const request = fetcher.mock.calls[1]!;
    expect(request[1]?.method).toBe("POST");
    const body = JSON.parse(String(request[1]?.body)) as { receive_id: string; content: string };
    expect(body.receive_id).toBe("ou_x");
    expect(body.content).toContain("另有安排");
    expect(body.content).toContain("取消任务");
    expect(body.content).not.toContain("开始任务");
    expect(body.content).not.toContain("打开任务");
  });

  it("updates the same card at T-1 and adds the explicit start control", async () => {
    const fetcher = fetcherWithMessage("om_initial");
    const provider = new FeishuDeliveryProvider({ appId: "id", appSecret: "secret", targetOpenId: "ou_x" }, fetcher);
    const readyJob = { ...baseJob, id: "job-ready", kind: "task_start_ready" };

    await provider.deliver(readyJob, {
      now: new Date("2026-08-16T01:59:00.000Z"),
      timing: "upcoming",
      remoteMessageId: "om_initial"
    });

    const request = fetcher.mock.calls[1]!;
    expect(String(request[0])).toContain("/im/v1/messages/om_initial");
    expect(request[1]?.method).toBe("PATCH");
    const body = JSON.parse(String(request[1]?.body)) as { content: string };
    expect(body.content).toContain("还有 1 分钟开始");
    expect(body.content).toContain('"action":"start"');
    expect(body.content).toContain("另有安排");
  });

  it("disables the unpressed start control at T0 while keeping late text start available", async () => {
    const fetcher = fetcherWithMessage("om_initial");
    const provider = new FeishuDeliveryProvider({ appId: "id", appSecret: "secret", targetOpenId: "ou_x" }, fetcher);
    const lapsedJob = { ...baseJob, id: "job-lapsed", kind: "task_start_lapsed" };

    await provider.deliver(lapsedJob, {
      now: new Date("2026-08-16T02:00:00.000Z"),
      timing: "in_progress",
      remoteMessageId: "om_initial"
    });

    const body = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)) as { content: string };
    expect(body.content).toContain("等待迟到开始");
    expect(body.content).toContain('"disabled":true');
    expect(body.content).toContain("我开始了这个任务");
    expect(body.content).not.toContain('"action":"start"');
  });

  it("replaces the original card after the desktop confirms start", async () => {
    const fetcher = fetcherWithMessage("om_initial");
    const provider = new FeishuDeliveryProvider({ appId: "id", appSecret: "secret", targetOpenId: "ou_x" }, fetcher);
    const startedJob = {
      ...baseJob,
      id: "job-started-status",
      kind: "task_start_lapsed",
      payload: { ...(baseJob.payload as Record<string, unknown>), cardState: "started" }
    };

    await provider.deliver(startedJob, {
      now: new Date("2026-08-16T01:59:20.000Z"),
      timing: "upcoming",
      remoteMessageId: "om_initial"
    });

    const request = fetcher.mock.calls[1]!;
    expect(String(request[0])).toContain("/im/v1/messages/om_initial");
    expect(request[1]?.method).toBe("PATCH");
    const body = JSON.parse(String(request[1]?.body)) as { content: string };
    expect(body.content).toContain("任务已经开始");
    expect(body.content).toContain("桌面软件或飞书完成一次开始确认");
    expect(body.content).not.toContain('"tag":"action"');
  });

  it("shows an immutable missed state at the fixed end", async () => {
    const fetcher = fetcherWithMessage("om_initial");
    const provider = new FeishuDeliveryProvider({ appId: "id", appSecret: "secret", targetOpenId: "ou_x" }, fetcher);
    const expireJob = { ...baseJob, id: "job-expire", kind: "task_start_expire" };

    await provider.deliver(expireJob, {
      now: new Date("2026-08-16T03:00:00.000Z"),
      timing: "in_progress",
      remoteMessageId: "om_initial"
    });

    const body = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)) as { content: string };
    expect(body.content).toContain("任务未开始");
    expect(body.content).toContain("已记录为未完成");
    expect(body.content).not.toContain('"tag":"action"');
  });

  it("creates a fresh T-1 card when the optional T-15 card was not sent", async () => {
    const fetcher = fetcherWithMessage();
    const provider = new FeishuDeliveryProvider({ appId: "id", appSecret: "secret", targetOpenId: "ou_x" }, fetcher);
    await expect(provider.deliver({ ...baseJob, kind: "task_start_ready" }, {
      now: new Date("2026-08-16T01:59:00.000Z"),
      timing: "upcoming"
    })).resolves.toEqual({ remoteMessageId: "om_initial" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const request = fetcher.mock.calls[1]!;
    expect(String(request[0])).toContain("receive_id_type=open_id");
    expect(request[1]?.method).toBe("POST");
    const body = JSON.parse(String(request[1]?.body)) as { receive_id: string; content: string };
    expect(body.receive_id).toBe("ou_x");
    expect(body.content).toContain("还有 1 分钟开始");
    expect(body.content).toContain('"action":"start"');
  });

  it("throws when Feishu does not confirm delivery", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, tenant_access_token: "token", expire: 7200 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 230001, msg: "permission denied" }), { status: 200 }));
    const provider = new FeishuDeliveryProvider({ appId: "id", appSecret: "secret", targetOpenId: "ou_x" }, fetcher);
    await expect(provider.deliver(baseJob, {
      now: new Date("2026-08-16T01:45:00.000Z"),
      timing: "upcoming"
    })).rejects.toThrow("feishu_message_failed:230001");
  });
});
