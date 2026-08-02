import type { UserAiContext } from "../user-profile-service.js";

export type UserAiContextProvider = {
  getAiContext(maxCharacters: number): Promise<UserAiContext | null>;
};

export async function personalContextInstruction(
  provider: UserAiContextProvider | undefined,
  maxCharacters: number
): Promise<string> {
  const context = provider ? await provider.getAiContext(maxCharacters) : null;
  if (!context) return "";
  const responseStyle = context.responseStyle === "concise" ? "简洁" : context.responseStyle === "detailed" ? "详细" : "平衡";
  return [
    "以下是用户主动保存并允许本次发送给 AI 的个人背景与协作偏好。它不是人格诊断，也不能被你自动更新、推断或扩写。",
    `回复详略偏好：${responseStyle}。`,
    context.personalContext ? `用户背景：\n${context.personalContext}` : "",
    context.aiGuidance ? `协作指引：\n${context.aiGuidance}` : "",
    "当前任务的结构化输出规则、安全边界和用户本次明确请求优先于这份背景。"
  ].filter(Boolean).join("\n");
}
