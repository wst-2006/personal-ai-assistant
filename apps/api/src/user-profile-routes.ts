import type { FastifyInstance } from "fastify";
import { saveUserProfileSchema } from "@personal-ai/domain/user-profile";
import { UserProfileService, UserProfileVersionConflictError } from "./user-profile-service.js";

export async function userProfileRoutes(app: FastifyInstance, options: { userProfileService: UserProfileService }) {
  app.get("/user-profile", async () => ({ profile: await options.userProfileService.get() }));

  app.put("/user-profile", async (request, reply) => {
    const parsed = saveUserProfileSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_user_profile", details: parsed.error.flatten() });
    try {
      return { profile: await options.userProfileService.save(parsed.data) };
    } catch (error) {
      if (error instanceof UserProfileVersionConflictError) return reply.status(409).send({ error: "user_profile_version_conflict", profile: error.current });
      throw error;
    }
  });
}
