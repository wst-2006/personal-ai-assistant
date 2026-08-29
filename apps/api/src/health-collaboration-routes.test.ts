import { afterAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import {
  HealthConversationReplyUnavailableError,
  type HealthConversationResponder,
  type HealthConversationService
} from "./health-conversation-service.js";
import type { HealthService } from "./health-service.js";

const conversationId = "11111111-1111-4111-8111-111111111111";
const userMessageId = "22222222-2222-4222-8222-222222222222";
const state = {
  conversation: { id: conversationId, weekStart: "2026-08-16", createdAt: new Date(), updatedAt: new Date() },
  replyInFlight: true,
  messages: [{
    id: userMessageId,
    conversationId,
    role: "user",
    source: "app",
    content: "本周需要规律作息。",
    needsClarification: null,
    externalMessageId: null,
    createdAt: new Date()
  }]
};
const saveUserMessage = vi.fn().mockResolvedValue(state);
const retryLast = vi.fn().mockResolvedValue({
  ...state,
  replyInFlight: false,
  messages: [...state.messages, {
    id: "33333333-3333-4333-8333-333333333333",
    conversationId,
    role: "assistant",
    source: "ai",
    content: "已记下，可以继续生成候选。",
    needsClarification: false,
    externalMessageId: null,
    createdAt: new Date()
  }]
});
const collaborationService = {
  getOrOpen: vi.fn().mockResolvedValue(state),
  saveUserMessage,
  retryLast,
  contextForWeek: vi.fn().mockResolvedValue("用户：本周需要规律作息。")
} as unknown as HealthConversationService;
const responder = { reply: vi.fn() } as unknown as HealthConversationResponder;
const app = buildApp({
  healthService: {} as HealthService,
  healthConversationService: collaborationService,
  healthConversationResponder: responder
});

afterAll(async () => app.close());

describe("health collaboration routes", () => {
  it("reports an in-flight reply so the health page can reconnect after navigation", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/health/weeks/2026-08-16/collaboration" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      conversation: { id: conversationId },
      replyInFlight: true,
      messages: [{ role: "user" }]
    });
  });

  it("saves the user message first without waiting for or duplicating the AI reply", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/health/collaborations/${conversationId}/messages`,
      payload: { content: "本周需要规律作息。" }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ messages: [{ id: userMessageId, role: "user" }] });
    expect(saveUserMessage).toHaveBeenCalledWith(conversationId, "本周需要规律作息。");
    expect(retryLast).not.toHaveBeenCalled();
  });

  it("requests the pending reply separately so a failed provider call can be retried", async () => {
    const response = await app.inject({ method: "POST", url: `/api/v1/health/collaborations/${conversationId}/reply-last` });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ messages: [{ role: "user" }, { role: "assistant", needsClarification: false }] });
    expect(retryLast).toHaveBeenCalledWith(conversationId, responder);
  });

  it("reports that the original health text is already saved when DeepSeek is unavailable", async () => {
    retryLast.mockRejectedValueOnce(new HealthConversationReplyUnavailableError(conversationId, userMessageId));
    const response = await app.inject({ method: "POST", url: `/api/v1/health/collaborations/${conversationId}/reply-last` });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      error: "ai_health_collaboration_unavailable",
      conversationId,
      userMessageId,
      message: expect.stringContaining("已经保存")
    });
  });
});
