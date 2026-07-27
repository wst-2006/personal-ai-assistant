import { taskInputSchema } from "@personal-ai/domain/task";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { TaskRepository } from "./task-repository.js";

const listQuerySchema = z.object({
  date: z.string().date().optional()
});

type TaskRoutesOptions = {
  taskRepository: TaskRepository;
};

export const taskRoutes: FastifyPluginAsync<TaskRoutesOptions> = async (app, options) => {
  app.get("/tasks", async (request, reply) => {
    const query = listQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({
        error: "invalid_query",
        issues: query.error.issues
      });
    }

    return { tasks: await options.taskRepository.list(query.data.date) };
  });

  app.post("/tasks", async (request, reply) => {
    const input = taskInputSchema.safeParse(request.body);
    if (!input.success) {
      return reply.status(400).send({
        error: "invalid_task",
        issues: input.error.issues
      });
    }

    const task = await options.taskRepository.create(input.data);
    return reply.status(201).send({ task });
  });
};
