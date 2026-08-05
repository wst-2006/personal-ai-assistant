import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import type { ReviewResponder, ReviewService } from "./review-service.js";

const sessionId = "52dd7330-089c-4893-8be6-34a4a133fbec";
let addCalls = 0;
let replyCalls = 0;
const service = {
  async getOrOpen() { return { session: { id: sessionId, localDate: "2026-08-05", state: "review_open" }, messages: [], briefs: [], context: {} }; },
  async addUserMessage(_id: string, content: string) {
    addCalls += 1;
    return { session: { id: sessionId, localDate: "2026-08-05", state: "review_has_message" }, message: { id: "1", reviewSessionId: sessionId, source: "app", content } };
  },
  async replyLast() {
    replyCalls += 1;
    return { session: { id: sessionId, localDate: "2026-08-05", state: "review_has_message" }, messages: [{ id: "2", source: "ai", content: "回应" }] };
  },
} as unknown as ReviewService;
const responder = { async reply() { return "回应"; } } as ReviewResponder;
const app = buildApp({ reviewService: service, reviewResponder: responder });

afterAll(async () => { await app.close(); });

describe("review routes", () => {
  it("accepts only a user-authored public message and rejects forged AI source", async () => {
    const forged = await app.inject({ method: "POST", url: `/api/v1/reviews/${sessionId}/messages`, payload: { content: "伪造回复", source: "ai" } });
    expect(forged.statusCode).toBe(400);
    expect(addCalls).toBe(0);

    const saved = await app.inject({ method: "POST", url: `/api/v1/reviews/${sessionId}/messages`, payload: { content: "用户复盘", source: "app" } });
    expect(saved.statusCode).toBe(201);
    expect(saved.json().message).toMatchObject({ source: "app", content: "用户复盘" });
    expect(addCalls).toBe(1);
  });

  it("exposes AI reply as a separate server-controlled action", async () => {
    const response = await app.inject({ method: "POST", url: `/api/v1/reviews/${sessionId}/reply-last` });
    expect(response.statusCode).toBe(201);
    expect(response.json().messages.at(-1)).toMatchObject({ source: "ai", content: "回应" });
    expect(replyCalls).toBe(1);
  });
});
