import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { TaskTreeGenerationUnavailableError } from "./long-range-task-tree-service.js";
import type { LongRangeTaskTreeService } from "./long-range-task-tree-service.js";
import type { LongRangeTaskTreePlanner } from "./ai/long-range-task-tree-planner.js";

const plan = {
  id: "8e51cb70-5254-4fb1-87e8-c5f27bbe349b",
  status: "active",
  version: 3
};

const unavailableService = {
  async createAiCandidate() { throw new TaskTreeGenerationUnavailableError(); },
  async getLatest() { return null; }
} as unknown as LongRangeTaskTreeService;

const planner = { async plan() { throw new Error("must not be called by this route stub"); } } as LongRangeTaskTreePlanner;
const app = buildApp({ longRangeTaskTreeService: unavailableService, longRangeTaskTreePlanner: planner });

afterAll(async () => { await app.close(); });

describe("long-range task-tree generation route", () => {
  it("returns a recoverable 503 when the AI provider is unavailable", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/long-range-plans/${plan.id}/task-tree-candidates/ai`,
      payload: { expectedPlanVersion: plan.version, instructions: null }
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "task_tree_generation_unavailable" });
  });
});
