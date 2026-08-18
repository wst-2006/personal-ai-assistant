import { afterEach, describe, expect, it, vi } from "vitest";
import { FeishuHealthMessenger } from "./feishu-health-messenger.js";

afterEach(() => vi.restoreAllMocks());

describe("FeishuHealthMessenger", () => {
  it("sends a clarification with an explicit health reply prefix and reuses the tenant token", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, tenant_access_token: "token", expire: 7_200 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, msg: "success" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, msg: "success" }), { status: 200 }));
    const messenger = new FeishuHealthMessenger({ appId: "app", appSecret: "secret", targetOpenId: "ou_owner" }, fetcher);

    await messenger.notifyClarification({ weekStart: "2026-08-16", content: "请补充这一周是否有医生要求限制饮水。" });
    await messenger.notifyClarification({ weekStart: "2026-08-16", content: "还需要补充力量训练的具体日期吗？" });

    expect(fetcher).toHaveBeenCalledTimes(3);
    const [, request] = fetcher.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(String(request.body)) as { receive_id: string; msg_type: string; content: string };
    expect(body.receive_id).toBe("ou_owner");
    expect(body.msg_type).toBe("text");
    expect(JSON.parse(body.content).text).toContain("健康：你的补充");
    expect(JSON.parse(body.content).text).toContain("不会被当成任务或复盘");
  });
});
