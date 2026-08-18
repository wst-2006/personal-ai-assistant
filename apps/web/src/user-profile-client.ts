import type { FocusTheme } from "@personal-ai/domain/user-profile";

export type ResponseStyle = "concise" | "balanced" | "detailed";
export type UnscheduledTaskPolicy = "carry_forward" | "delete_at_day_end";

export type UserProfile = {
  id: number;
  personalContext: string;
  aiGuidance: string;
  shareWithAi: boolean;
  responseStyle: ResponseStyle;
  unscheduledTaskPolicy: UnscheduledTaskPolicy;
  recycleRetentionDays: number;
  focusFlipSoundEnabled: boolean;
  focusStartSoundEnabled: boolean;
  breakStartSoundEnabled: boolean;
  breakEndSoundEnabled: boolean;
  focusEndSoundEnabled: boolean;
  focusTheme: FocusTheme;
  desktopFocusEnabled: boolean;
  focusPreparationWindowEnabled: boolean;
  focusTimerWindowEnabled: boolean;
  focusEvaluationEnabled: boolean;
  feishuTaskCardsEnabled: boolean;
  feishuT15Enabled: boolean;
  healthPageEnabled: boolean;
  version: number;
};

export type FocusSounds = {
  flip: boolean;
  focusStart: boolean;
  breakStart: boolean;
  breakEnd: boolean;
  focusEnd: boolean;
};

export type UserProfileDraft = Pick<UserProfile,
  | "personalContext"
  | "aiGuidance"
  | "shareWithAi"
  | "responseStyle"
  | "unscheduledTaskPolicy"
  | "recycleRetentionDays"
  | "focusTheme"
  | "desktopFocusEnabled"
  | "focusPreparationWindowEnabled"
  | "focusTimerWindowEnabled"
  | "focusEvaluationEnabled"
  | "feishuTaskCardsEnabled"
  | "feishuT15Enabled"
  | "healthPageEnabled"
> & { focusSounds: FocusSounds };

type ApiFailure = { error?: string; profile?: UserProfile };

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3000";

export const defaultUserProfileDraft: UserProfileDraft = {
  personalContext: "",
  aiGuidance: "",
  shareWithAi: true,
  responseStyle: "balanced",
  unscheduledTaskPolicy: "carry_forward",
  recycleRetentionDays: 3,
  focusSounds: { flip: true, focusStart: true, breakStart: true, breakEnd: true, focusEnd: true },
  focusTheme: "ink",
  desktopFocusEnabled: true,
  focusPreparationWindowEnabled: true,
  focusTimerWindowEnabled: true,
  focusEvaluationEnabled: true,
  feishuTaskCardsEnabled: true,
  feishuT15Enabled: true,
  healthPageEnabled: true,
};

export function draftFromProfile(profile: UserProfile): UserProfileDraft {
  return {
    personalContext: profile.personalContext,
    aiGuidance: profile.aiGuidance,
    shareWithAi: profile.shareWithAi,
    responseStyle: profile.responseStyle,
    unscheduledTaskPolicy: profile.unscheduledTaskPolicy,
    recycleRetentionDays: profile.recycleRetentionDays,
    focusSounds: {
      flip: profile.focusFlipSoundEnabled,
      focusStart: profile.focusStartSoundEnabled,
      breakStart: profile.breakStartSoundEnabled,
      breakEnd: profile.breakEndSoundEnabled,
      focusEnd: profile.focusEndSoundEnabled,
    },
    focusTheme: profile.focusTheme ?? "ink",
    desktopFocusEnabled: profile.desktopFocusEnabled ?? true,
    focusPreparationWindowEnabled: profile.focusPreparationWindowEnabled ?? true,
    focusTimerWindowEnabled: profile.focusTimerWindowEnabled ?? true,
    focusEvaluationEnabled: profile.focusEvaluationEnabled ?? true,
    feishuTaskCardsEnabled: profile.feishuTaskCardsEnabled ?? true,
    feishuT15Enabled: profile.feishuT15Enabled ?? true,
    healthPageEnabled: profile.healthPageEnabled ?? true,
  };
}

export class ProfileApiError extends Error {
  constructor(readonly body: ApiFailure) {
    super(body.error ?? "profile request failed");
  }
}

async function requestProfile<T>(method: "GET" | "PUT", body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${apiBaseUrl}/api/v1/user-profile`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new ProfileApiError(result as ApiFailure);
  return result as T;
}

export async function loadUserProfile(signal?: AbortSignal): Promise<UserProfile> {
  const response = await fetch(`${apiBaseUrl}/api/v1/user-profile`, { signal });
  const result = await response.json().catch(() => ({})) as { profile?: UserProfile; error?: string };
  if (!response.ok || !result.profile) throw new ProfileApiError(result);
  return result.profile;
}

export async function saveUserProfile(profile: UserProfile, draft: UserProfileDraft): Promise<UserProfile> {
  const result = await requestProfile<{ profile: UserProfile }>("PUT", {
    ...draft,
    expectedVersion: profile.version,
  });
  return result.profile;
}
