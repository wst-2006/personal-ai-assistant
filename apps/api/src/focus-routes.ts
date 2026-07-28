import type { FastifyInstance } from "fastify";
import {
  createFocusSessionSchema,
  evaluateFocusSessionSchema,
  focusSessionVersionSchema,
  respondToFocusReminderSchema,
  stopFocusSessionSchema
} from "@personal-ai/domain/focus";
import { z } from "zod";
import {
  FocusBusyError,
  FocusNotFoundError,
  FocusService,
  FocusTransitionError,
  FocusVersionConflictError,
  type StoredFocusSession,
  elapsedSeconds
} from "./focus-service.js";

const paramsSchema = z.object({ id: z.string().uuid() });

export async function focusRoutes(app: FastifyInstance, options: { focusService: FocusService }) {
  const { focusService } = options;
  app.get("/focus-sessions/current", async () => {
    const session = await focusService.current();
    return { session: session ? serialize(session) : null };
  });

  app.post("/focus-sessions", async (request, reply) => {
    const input = createFocusSessionSchema.safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: "invalid_focus_session", details: input.error.flatten() });
    try { return reply.status(201).send({ session: serialize(await focusService.create(input.data.taskId, input.data.expectedTaskVersion, input.data.mode)) }); }
    catch (error) { return focusError(reply, error); }
  });

  app.post("/focus-sessions/:id/begin", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params); const input = focusSessionVersionSchema.safeParse(request.body);
    if (!params.success || !input.success) return reply.status(400).send({ error: "invalid_focus_session" });
    try { return { session: serialize(await focusService.begin(params.data.id, input.data.expectedVersion)) }; }
    catch (error) { return focusError(reply, error); }
  });

  app.post("/focus-sessions/:id/respond", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params); const input = respondToFocusReminderSchema.safeParse(request.body);
    if (!params.success || !input.success) return reply.status(400).send({ error: "invalid_focus_session" });
    try { return { session: serialize(await focusService.respondToReminder(params.data.id, input.data.expectedVersion, input.data.decision)) }; }
    catch (error) { return focusError(reply, error); }
  });

  app.post("/focus-sessions/:id/pause", async (request, reply) => timerAction(request, reply, "pause", focusService));
  app.post("/focus-sessions/:id/resume", async (request, reply) => timerAction(request, reply, "resume", focusService));

  app.post("/focus-sessions/:id/end", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params); const input = stopFocusSessionSchema.safeParse(request.body);
    if (!params.success || !input.success) return reply.status(400).send({ error: "invalid_focus_session" });
    try { return { session: serialize(await focusService.end(params.data.id, input.data.expectedVersion, input.data.reason)) }; }
    catch (error) { return focusError(reply, error); }
  });

  app.post("/focus-sessions/:id/other-arrangement", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params); const input = stopFocusSessionSchema.safeParse(request.body);
    if (!params.success || !input.success) return reply.status(400).send({ error: "invalid_focus_session" });
    try { return { session: serialize(await focusService.otherArrangement(params.data.id, input.data.expectedVersion, input.data.reason)) }; }
    catch (error) { return focusError(reply, error); }
  });

  app.post("/focus-sessions/:id/evaluate", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params); const input = evaluateFocusSessionSchema.safeParse(request.body);
    if (!params.success || !input.success) return reply.status(400).send({ error: "invalid_focus_evaluation", details: input.success ? undefined : input.error.flatten() });
    try {
      return { session: serialize(await focusService.evaluate(params.data.id, input.data.expectedVersion, input.data.outcome, input.data.progressPercent, input.data.satisfaction, input.data.note)) };
    } catch (error) { return focusError(reply, error); }
  });
}

async function timerAction(request: { params: unknown; body: unknown }, reply: { status: (statusCode: number) => { send: (body: unknown) => unknown } }, action: "pause" | "resume", focusService: FocusService) {
  const params = paramsSchema.safeParse(request.params); const input = focusSessionVersionSchema.safeParse(request.body);
  if (!params.success || !input.success) return reply.status(400).send({ error: "invalid_focus_session" });
  try {
    const session = action === "pause"
      ? await focusService.pause(params.data.id, input.data.expectedVersion)
      : await focusService.resume(params.data.id, input.data.expectedVersion);
    return { session: serialize(session) };
  } catch (error) { return focusError(reply, error); }
}

function serialize(session: StoredFocusSession) {
  return { ...session, rawActiveSeconds: elapsedSeconds(session) };
}

function focusError(reply: { status: (statusCode: number) => { send: (body: unknown) => unknown } }, error: unknown) {
  if (error instanceof FocusNotFoundError) return reply.status(404).send({ error: "focus_session_not_found" });
  if (error instanceof FocusBusyError) return reply.status(409).send({ error: "focus_session_already_active" });
  if (error instanceof FocusVersionConflictError) return reply.status(409).send({ error: "focus_session_version_conflict", session: serialize(error.current) });
  if (error instanceof FocusTransitionError) return reply.status(409).send({ error: "invalid_focus_transition", state: error.state, operation: error.operation });
  if (error instanceof Error && error.message === "task_version_conflict") return reply.status(409).send({ error: "task_version_conflict" });
  throw error;
}
