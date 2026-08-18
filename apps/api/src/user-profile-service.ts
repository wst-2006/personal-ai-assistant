import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "@personal-ai/db/client";
import { userProfiles } from "@personal-ai/db/schema";
import { saveUserProfileSchema, type UserProfileContent } from "@personal-ai/domain/user-profile";

export const primaryUserProfileId = 1;

export type StoredUserProfile = typeof userProfiles.$inferSelect;
export type UserAiContext = Pick<StoredUserProfile, "personalContext" | "aiGuidance" | "responseStyle">;

export class UserProfileVersionConflictError extends Error {
  constructor(readonly current: StoredUserProfile) { super("User profile version conflict."); }
}

export class UserProfileService {
  constructor(private readonly db: AppDatabase) {}

  async get(): Promise<StoredUserProfile> {
    const [profile] = await this.db.select().from(userProfiles).where(eq(userProfiles.id, primaryUserProfileId)).limit(1);
    if (profile) return profile;
    return this.createDefault();
  }

  async save(input: unknown): Promise<StoredUserProfile> {
    const parsed = saveUserProfileSchema.parse(input);
    return this.db.transaction(async (transaction) => {
      const [current] = await transaction.select().from(userProfiles).where(eq(userProfiles.id, primaryUserProfileId)).limit(1);
      if (!current) {
        if (parsed.expectedVersion !== 0) throw new Error("User profile was not initialized.");
        const now = new Date();
        const [created] = await transaction.insert(userProfiles).values({
          id: primaryUserProfileId,
          ...toRecord(parsed),
          version: 1,
          createdAt: now,
          updatedAt: now
        }).returning();
        return created!;
      }
      if (current.version !== parsed.expectedVersion) throw new UserProfileVersionConflictError(current);
      const [updated] = await transaction.update(userProfiles).set({
        ...toRecord(parsed),
        version: current.version + 1,
        updatedAt: new Date()
      }).where(and(eq(userProfiles.id, primaryUserProfileId), eq(userProfiles.version, parsed.expectedVersion))).returning();
      if (!updated) throw new UserProfileVersionConflictError(await this.getFrom(transaction));
      return updated;
    });
  }

  async getAiContext(maxCharacters: number): Promise<UserAiContext | null> {
    const profile = await this.get();
    if (!profile.shareWithAi || (!profile.personalContext && !profile.aiGuidance)) return null;
    const personalContext = profile.personalContext.slice(0, maxCharacters);
    const remaining = Math.max(0, maxCharacters - personalContext.length);
    return { personalContext, aiGuidance: profile.aiGuidance.slice(0, remaining), responseStyle: profile.responseStyle };
  }

  private async getFrom(database: AppDatabase): Promise<StoredUserProfile> {
    const [profile] = await database.select().from(userProfiles).where(eq(userProfiles.id, primaryUserProfileId)).limit(1);
    if (!profile) throw new Error("User profile disappeared during an update.");
    return profile;
  }

  private async createDefault(): Promise<StoredUserProfile> {
    const now = new Date();
    const [profile] = await this.db.insert(userProfiles).values({
      id: primaryUserProfileId,
      personalContext: "",
      aiGuidance: "",
      shareWithAi: true,
      responseStyle: "balanced",
      unscheduledTaskPolicy: "carry_forward",
      recycleRetentionDays: 3,
      focusFlipSoundEnabled: true,
      focusStartSoundEnabled: true,
      breakStartSoundEnabled: true,
      breakEndSoundEnabled: true,
      focusEndSoundEnabled: true,
      focusTheme: "ink",
      desktopFocusEnabled: true,
      focusPreparationWindowEnabled: true,
      focusTimerWindowEnabled: true,
      focusEvaluationEnabled: true,
      feishuTaskCardsEnabled: true,
      feishuT15Enabled: true,
      healthPageEnabled: true,
      version: 1,
      createdAt: now,
      updatedAt: now
    }).onConflictDoNothing().returning();
    return profile ?? this.getFrom(this.db);
  }
}

function toRecord(input: UserProfileContent) {
  return {
    personalContext: input.personalContext,
    aiGuidance: input.aiGuidance,
    shareWithAi: input.shareWithAi,
    responseStyle: input.responseStyle,
    unscheduledTaskPolicy: input.unscheduledTaskPolicy,
    recycleRetentionDays: input.recycleRetentionDays,
    focusFlipSoundEnabled: input.focusSounds.flip,
    focusStartSoundEnabled: input.focusSounds.focusStart,
    breakStartSoundEnabled: input.focusSounds.breakStart,
    breakEndSoundEnabled: input.focusSounds.breakEnd,
    focusEndSoundEnabled: input.focusSounds.focusEnd,
    focusTheme: input.focusTheme,
    desktopFocusEnabled: input.desktopFocusEnabled,
    focusPreparationWindowEnabled: input.focusPreparationWindowEnabled,
    focusTimerWindowEnabled: input.focusTimerWindowEnabled,
    focusEvaluationEnabled: input.focusEvaluationEnabled,
    feishuTaskCardsEnabled: input.feishuTaskCardsEnabled,
    feishuT15Enabled: input.feishuT15Enabled,
    healthPageEnabled: input.healthPageEnabled
  };
}
