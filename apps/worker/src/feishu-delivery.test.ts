import { describe, expect, it, vi } from "vitest";
import { FeishuDeliveryProvider, loadFeishuConfig } from "./feishu-delivery.js";
import type { ReminderJob } from "./worker-core.js";

const job: ReminderJob = {
  id: "job-1",
  taskId: "task-1",
  channel: "feishu",
  kind: "task_start",
  attempts: 1,
  scheduleRevision: 4,
  scheduledAt: new Date("2026-07-29T02:00:00.000Z"),
  payload: {
    taskId: "task-1",
    title: "阅读论文",
    startAt: "2026-07-29T02:00:00.000Z",
    endAt: "2026-07-29T03:00:00.000Z",
    timeZone: "Asia/Shanghai",
    scheduleRevision: 4
  }
};
const upcomingContext = { now: new Date("2026-07-29T01:45:00.000Z"), timing: "upcoming" as const };

describe("Feishu reminder delivery", () => {
  it("stays disabled until every server-only delivery value exists", () => {
    expect(loadFeishuConfig({})).toBeNull();
    expect(loadFeishuConfig({ FEISHU_APP_ID: "id", FEISHU_APP_SECRET: "secret" })).toBeNull();
    expect(loadFeishuConfig({ FEISHU_APP_ID: "id", FEISHU_APP_SECRET: "secret", FEISHU_TARGET_OPEN_ID: "ou_x" }))
      .toMatchObject({ appId: "id", targetOpenId: "ou_x" });
  });

  it("gets a tenant token once and sends interactive reminder cards", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, tenant_access_token: "token", expire: 7200 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, msg: "success" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, msg: "success" }), { status: 200 }));
    const provider = new FeishuDeliveryProvider({ appId: "id", appSecret: "secret", targetOpenId: "ou_x", taskUrlBase: "https://assistant.example" }, fetcher);

    await provider.deliver(job, upcomingContext);
    await provider.deliver(job, upcomingContext);

    expect(fetcher).toHaveBeenCalledTimes(3);
    const messageRequest = fetcher.mock.calls[1]!;
    expect(String(messageRequest[0])).toContain("/im/v1/messages");
    const body = JSON.parse(String(messageRequest[1]?.body)) as { receive_id: string; content: string };
    expect(body.receive_id).toBe("ou_x");
    expect(body.content).toContain("另有安排");
    expect(body.content).toContain('"action":"open_task"');
    expect(body.content).toContain("https://assistant.example/?task=task-1");
    expect(body.content).toContain("即将开始");
  });

  it("always includes a local desktop open action without a public URL", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, tenant_access_token: "token", expire: 7200 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, msg: "success" }), { status: 200 }));
    const provider = new FeishuDeliveryProvider({ appId: "id", appSecret: "secret", targetOpenId: "ou_x" }, fetcher);

    await provider.deliver(job, upcomingContext);

    const body = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)) as { content: string };
    expect(body.content).toContain("打开任务");
    expect(body.content).toContain('"action":"open_task"');
    expect(body.content).not.toContain("打开网页版");
  });

  it("uses an in-progress card instead of claiming a delayed task is upcoming", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, tenant_access_token: "token", expire: 7200 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, msg: "success" }), { status: 200 }));
    const provider = new FeishuDeliveryProvider({ appId: "id", appSecret: "secret", targetOpenId: "ou_x" }, fetcher);

    await provider.deliver(job, { now: new Date("2026-07-29T02:44:00.000Z"), timing: "in_progress" });

    const body = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)) as { content: string };
    expect(body.content).toContain("任务已开始");
    expect(body.content).toContain("还剩约 16 分钟");
    expect(body.content).not.toContain("即将开始");
  });

  it("throws when Feishu does not confirm delivery", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, tenant_access_token: "token", expire: 7200 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 230001, msg: "permission denied" }), { status: 200 }));
    const provider = new FeishuDeliveryProvider({ appId: "id", appSecret: "secret", targetOpenId: "ou_x" }, fetcher);
    await expect(provider.deliver(job, upcomingContext)).rejects.toThrow("feishu_message_failed:230001");
  });
});
