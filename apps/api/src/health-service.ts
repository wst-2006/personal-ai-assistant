import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { AppDatabase } from "@personal-ai/db/client";
import { healthDailyReferences, healthProfiles, healthSleepAnalyses, healthWeekPlans, tasks } from "@personal-ai/db/schema";
import {
  healthPlanContentSchema,
  sleepImageAnalysisRequestSchema,
  sleepImageAnalysisSchema,
  localDatesForHealthWeek,
  type HealthPlanContent,
  type HealthProfile,
  type SleepImageAnalysis,
  type SleepImageAnalysisRequest
} from "@personal-ai/domain/health";

export const primaryHealthProfileId = "3a1c7d0c-86ed-4e5f-b9fb-4b7df5bf93e1";

export type HealthPlanWithDays = {
  plan: typeof healthWeekPlans.$inferSelect;
  days: Array<typeof healthDailyReferences.$inferSelect>;
};

export type HealthPlanner = {
  plan(input: {
    profile: HealthProfile;
    weekStart: string;
    solarTerm: string;
    scheduledActivities: Array<{ localDate: string; title: string }>;
    specialContext: string | null;
    sleepAnalysis: { localDate: string; analysis: SleepImageAnalysis } | null;
  }): Promise<HealthPlanContent>;
};

export type SleepImageAnalyzer = {
  analyze(input: { localDate: string; fileName: string; mimeType: string; dataUrl: string }): Promise<SleepImageAnalysis>;
};

export class HealthProfileNotFoundError extends Error {}
export class HealthProfileVersionConflictError extends Error {
  constructor(readonly current: typeof healthProfiles.$inferSelect) { super("Health profile version conflict."); }
}
export class HealthPlanNotFoundError extends Error {}
export class HealthPlanVersionConflictError extends Error {
  constructor(readonly current: HealthPlanWithDays) { super("Health plan version conflict."); }
}
export class HealthPlanStateError extends Error {
  constructor(readonly state: string, readonly operation: string) { super(`Cannot ${operation} a health plan in ${state} state.`); }
}
export class HealthPlanBaseChangedError extends Error {
  constructor(readonly current: HealthPlanWithDays | null) { super("The health plan used as the candidate base has changed."); }
}
export class HealthActivePlanRequiredError extends Error {}
export class SleepAnalysisNotFoundError extends Error {}
export class SleepAnalysisOutsideWeekError extends Error {}
export class SleepImageValidationError extends Error {}

export class HealthService {
  constructor(private readonly db: AppDatabase) {}

  async getProfile() {
    const [profile] = await this.db.select().from(healthProfiles).where(eq(healthProfiles.id, primaryHealthProfileId)).limit(1);
    return profile ?? null;
  }

  async saveProfile(profile: HealthProfile, expectedVersion?: number | null) {
    return this.db.transaction(async (transaction) => {
      const [current] = await transaction.select().from(healthProfiles).where(eq(healthProfiles.id, primaryHealthProfileId)).limit(1);
      const now = new Date();
      if (!current) {
        if (expectedVersion !== undefined && expectedVersion !== null) throw new HealthProfileNotFoundError();
        const [created] = await transaction.insert(healthProfiles).values({ id: primaryHealthProfileId, profile, version: 1, createdAt: now, updatedAt: now }).returning();
        return created!;
      }
      if (expectedVersion === undefined || expectedVersion === null || current.version !== expectedVersion) {
        throw new HealthProfileVersionConflictError(current);
      }
      const [updated] = await transaction.update(healthProfiles).set({ profile, version: current.version + 1, updatedAt: now })
        .where(and(eq(healthProfiles.id, primaryHealthProfileId), eq(healthProfiles.version, expectedVersion))).returning();
      if (!updated) throw new HealthProfileVersionConflictError((await this.requireProfile(transaction)));
      return updated;
    });
  }

  async getWeek(weekStart: string): Promise<{ active: HealthPlanWithDays | null; candidate: HealthPlanWithDays | null }> {
    const [active, candidate] = await Promise.all([
      this.findPlan(weekStart, "active"),
      this.findPlan(weekStart, "candidate")
    ]);
    return { active, candidate };
  }

  async createTemplateCandidate(weekStart: string, specialContext: string | null): Promise<HealthPlanWithDays> {
    const profileRecord = await this.requireProfile(this.db);
    const profile = profileRecord.profile as HealthProfile;
    const scheduledActivities = await this.weekActivities(weekStart);
    return this.storeCandidate({
      weekStart,
      profileVersion: profileRecord.version,
      city: profile.city,
      solarTerm: solarTermFor(weekStart),
      specialContext,
      source: "template",
      content: buildTemplateHealthPlan(profile, scheduledActivities)
    });
  }

  async createManualCandidate(input: { weekStart: string; specialContext?: string | null; content: HealthPlanContent }): Promise<HealthPlanWithDays> {
    const [profileRecord, basePlan] = await Promise.all([
      this.requireProfile(this.db),
      this.findPlan(input.weekStart, "active")
    ]);
    const profile = profileRecord.profile as HealthProfile;
    return this.storeCandidate({
      weekStart: input.weekStart,
      profileVersion: profileRecord.version,
      city: profile.city,
      solarTerm: solarTermFor(input.weekStart),
      specialContext: input.specialContext ?? null,
      source: "manual",
      content: healthPlanContentSchema.parse(input.content),
      basedOnPlanId: basePlan?.plan.id,
      basedOnPlanVersion: basePlan?.plan.version,
      revisionReason: basePlan ? "由你手动编辑生成本周修订候选。确认前，原本周参考保持不变。" : "由你手动编辑生成本周参考候选；确认后才会生效。"
    });
  }

  async updateManualCandidate(id: string, input: { expectedVersion: number; content: HealthPlanContent }): Promise<HealthPlanWithDays> {
    const content = healthPlanContentSchema.parse(input.content);
    return this.runSerializable(async (transaction) => {
      const current = await this.requirePlan(transaction, id);
      if (current.plan.version !== input.expectedVersion) throw new HealthPlanVersionConflictError(current);
      if (current.plan.state !== "candidate") throw new HealthPlanStateError(current.plan.state, "edit");
      const now = new Date();
      const [updated] = await transaction.update(healthWeekPlans).set({
        source: "manual",
        overview: content.overview,
        supplements: content.supplements,
        revisionReason: "由你手动编辑当前本周候选。确认前，生效版本保持不变。",
        version: current.plan.version + 1,
        updatedAt: now
      }).where(and(eq(healthWeekPlans.id, id), eq(healthWeekPlans.version, input.expectedVersion), eq(healthWeekPlans.state, "candidate"))).returning();
      if (!updated) throw new HealthPlanVersionConflictError(await this.requirePlan(transaction, id));
      await transaction.delete(healthDailyReferences).where(eq(healthDailyReferences.healthWeekPlanId, id));
      await transaction.insert(healthDailyReferences).values(content.days.map((day, dayIndex) => ({
        id: randomUUID(), healthWeekPlanId: id, localDate: localDatesForHealthWeek(updated.weekStart)[dayIndex]!, dayIndex, content: day, createdAt: now
      })));
      return { plan: updated, days: await this.daysForPlan(transaction, id) };
    });
  }

  async createAiCandidate(weekStart: string, specialContext: string | null, planner: HealthPlanner): Promise<HealthPlanWithDays> {
    const profileRecord = await this.requireProfile(this.db);
    const profile = profileRecord.profile as HealthProfile;
    const scheduledActivities = await this.weekActivities(weekStart);
    const solarTerm = solarTermFor(weekStart);
    const content = healthPlanContentSchema.parse(await planner.plan({ profile, weekStart, solarTerm, scheduledActivities, specialContext, sleepAnalysis: null }));
    return this.storeCandidate({ weekStart, profileVersion: profileRecord.version, city: profile.city, solarTerm, specialContext, source: "ai", content });
  }

  async createSleepRevisionCandidate(input: { weekStart: string; sleepAnalysisId: string; specialContext?: string | null }, planner: HealthPlanner): Promise<HealthPlanWithDays> {
    const [profileRecord, basePlan, sleepRecord] = await Promise.all([
      this.requireProfile(this.db),
      this.findPlan(input.weekStart, "active"),
      this.findSleepAnalysis(input.sleepAnalysisId)
    ]);
    if (!basePlan) throw new HealthActivePlanRequiredError();
    if (!sleepRecord) throw new SleepAnalysisNotFoundError();
    if (!localDatesForHealthWeek(input.weekStart).includes(sleepRecord.localDate)) throw new SleepAnalysisOutsideWeekError();

    const profile = profileRecord.profile as HealthProfile;
    const scheduledActivities = await this.weekActivities(input.weekStart);
    const solarTerm = solarTermFor(input.weekStart);
    const sleepAnalysis = sleepRecord.analysis as SleepImageAnalysis;
    const content = healthPlanContentSchema.parse(await planner.plan({
      profile,
      weekStart: input.weekStart,
      solarTerm,
      scheduledActivities,
      specialContext: input.specialContext ?? null,
      sleepAnalysis: { localDate: sleepRecord.localDate, analysis: sleepAnalysis }
    }));
    return this.storeCandidate({
      weekStart: input.weekStart,
      profileVersion: profileRecord.version,
      city: profile.city,
      solarTerm,
      specialContext: input.specialContext ?? null,
      source: "ai",
      content,
      basedOnPlanId: basePlan.plan.id,
      basedOnPlanVersion: basePlan.plan.version,
      sourceSleepAnalysisId: sleepRecord.id,
      revisionReason: sleepRevisionReason(sleepRecord.localDate, sleepAnalysis)
    });
  }

  async confirm(id: string, expectedVersion: number): Promise<HealthPlanWithDays> {
    return this.runSerializable(async (transaction) => {
      const current = await this.requirePlan(transaction, id);
      if (current.plan.version !== expectedVersion) throw new HealthPlanVersionConflictError(current);
      if (current.plan.state === "active") return current;
      if (current.plan.state !== "candidate") throw new HealthPlanStateError(current.plan.state, "confirm");
      const now = new Date();
      if (current.plan.basedOnPlanId) {
        const [active] = await transaction.select().from(healthWeekPlans)
          .where(and(eq(healthWeekPlans.weekStart, current.plan.weekStart), eq(healthWeekPlans.state, "active")))
          .limit(1);
        if (!active || active.id !== current.plan.basedOnPlanId || active.version !== current.plan.basedOnPlanVersion) {
          throw new HealthPlanBaseChangedError(active ? { plan: active, days: await this.daysForPlan(transaction, active.id) } : null);
        }
      }
      await transaction.update(healthWeekPlans).set({ state: "superseded", supersededAt: now, version: sql`${healthWeekPlans.version} + 1`, updatedAt: now })
        .where(and(eq(healthWeekPlans.weekStart, current.plan.weekStart), eq(healthWeekPlans.state, "active")));
      const [confirmed] = await transaction.update(healthWeekPlans).set({ state: "active", confirmedAt: now, version: current.plan.version + 1, updatedAt: now })
        .where(and(eq(healthWeekPlans.id, id), eq(healthWeekPlans.version, expectedVersion), eq(healthWeekPlans.state, "candidate"))).returning();
      if (!confirmed) throw new HealthPlanVersionConflictError(await this.requirePlan(transaction, id));
      return { plan: confirmed, days: current.days };
    });
  }

  async cancel(id: string, expectedVersion: number): Promise<HealthPlanWithDays> {
    return this.runSerializable(async (transaction) => {
      const current = await this.requirePlan(transaction, id);
      if (current.plan.version !== expectedVersion) throw new HealthPlanVersionConflictError(current);
      if (current.plan.state !== "candidate") throw new HealthPlanStateError(current.plan.state, "cancel");
      const now = new Date();
      const [cancelled] = await transaction.update(healthWeekPlans).set({ state: "cancelled", cancelledAt: now, version: current.plan.version + 1, updatedAt: now })
        .where(and(eq(healthWeekPlans.id, id), eq(healthWeekPlans.version, expectedVersion), eq(healthWeekPlans.state, "candidate"))).returning();
      if (!cancelled) throw new HealthPlanVersionConflictError(await this.requirePlan(transaction, id));
      return { plan: cancelled, days: current.days };
    });
  }

  async analyzeSleepImage(input: SleepImageAnalysisRequest, analyzer: SleepImageAnalyzer) {
    const parsed = sleepImageAnalysisRequestSchema.parse(input);
    const { bytes } = decodeSleepImage(parsed);
    const analysis = sleepImageAnalysisSchema.parse(await analyzer.analyze({
      localDate: parsed.localDate,
      fileName: parsed.fileName,
      mimeType: parsed.mimeType,
      dataUrl: parsed.dataUrl
    }));
    const [record] = await this.db.insert(healthSleepAnalyses).values({
      id: randomUUID(),
      localDate: parsed.localDate,
      source: "user_upload",
      originalFileName: parsed.fileName,
      mimeType: parsed.mimeType,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      analysis,
      createdAt: new Date()
    }).returning();
    if (!record) throw new Error("PostgreSQL did not return the sleep analysis.");
    return record;
  }

  async listSleepAnalyses(localDate: string) {
    return this.db.select().from(healthSleepAnalyses)
      .where(eq(healthSleepAnalyses.localDate, localDate))
      .orderBy(desc(healthSleepAnalyses.createdAt));
  }

  private async storeCandidate(input: {
    weekStart: string;
    profileVersion: number;
    city: string | null;
    solarTerm: string;
    specialContext: string | null;
    source: "template" | "ai" | "manual";
    content: HealthPlanContent;
    basedOnPlanId?: string;
    basedOnPlanVersion?: number;
    sourceSleepAnalysisId?: string;
    revisionReason?: string;
  }): Promise<HealthPlanWithDays> {
    const parsed = healthPlanContentSchema.parse(input.content);
    return this.runSerializable(async (transaction) => {
      const profile = await this.requireProfile(transaction);
      if (profile.version !== input.profileVersion) throw new HealthProfileVersionConflictError(profile);
      const now = new Date();
      const [plan] = await transaction.insert(healthWeekPlans).values({
        id: randomUUID(), weekStart: input.weekStart, state: "candidate", source: input.source, profileVersion: input.profileVersion,
        city: input.city, solarTerm: input.solarTerm, specialContext: input.specialContext,
        basedOnPlanId: input.basedOnPlanId ?? null, basedOnPlanVersion: input.basedOnPlanVersion ?? null,
        sourceSleepAnalysisId: input.sourceSleepAnalysisId ?? null, revisionReason: input.revisionReason ?? null,
        overview: parsed.overview, supplements: parsed.supplements,
        version: 1, createdAt: now, updatedAt: now
      }).returning();
      if (!plan) throw new Error("PostgreSQL did not return the health candidate.");
      const days = parsed.days.map((content, dayIndex) => ({
        id: randomUUID(), healthWeekPlanId: plan.id, localDate: localDatesForHealthWeek(input.weekStart)[dayIndex]!, dayIndex, content, createdAt: now
      }));
      await transaction.insert(healthDailyReferences).values(days);
      return { plan, days: await this.daysForPlan(transaction, plan.id) };
    });
  }

  private async findPlan(weekStart: string, state: "active" | "candidate"): Promise<HealthPlanWithDays | null> {
    const [plan] = await this.db.select().from(healthWeekPlans)
      .where(and(eq(healthWeekPlans.weekStart, weekStart), eq(healthWeekPlans.state, state)))
      .orderBy(desc(healthWeekPlans.createdAt)).limit(1);
    return plan ? { plan, days: await this.daysForPlan(this.db, plan.id) } : null;
  }

  private async weekActivities(weekStart: string): Promise<Array<{ localDate: string; title: string }>> {
    const dates = localDatesForHealthWeek(weekStart);
    return this.db.select({ localDate: tasks.localDate, title: tasks.title }).from(tasks)
      .where(and(inArray(tasks.localDate, dates), inArray(tasks.lifecycleStatus, ["open", "active", "awaiting_outcome"])))
      .orderBy(asc(tasks.localDate), asc(tasks.createdAt))
      .then((rows) => rows.filter((row): row is { localDate: string; title: string } => row.localDate !== null));
  }

  private async requireProfile(db: AppDatabase) {
    const [profile] = await db.select().from(healthProfiles).where(eq(healthProfiles.id, primaryHealthProfileId)).limit(1);
    if (!profile) throw new HealthProfileNotFoundError();
    return profile;
  }

  private async requirePlan(db: AppDatabase, id: string): Promise<HealthPlanWithDays> {
    const [plan] = await db.select().from(healthWeekPlans).where(eq(healthWeekPlans.id, id)).limit(1);
    if (!plan) throw new HealthPlanNotFoundError();
    return { plan, days: await this.daysForPlan(db, id) };
  }

  private async findSleepAnalysis(id: string) {
    const [record] = await this.db.select().from(healthSleepAnalyses).where(eq(healthSleepAnalyses.id, id)).limit(1);
    return record ?? null;
  }

  private daysForPlan(db: AppDatabase, planId: string) {
    return db.select().from(healthDailyReferences).where(eq(healthDailyReferences.healthWeekPlanId, planId)).orderBy(asc(healthDailyReferences.dayIndex));
  }

  private async runSerializable<T>(operation: (transaction: AppDatabase) => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.db.transaction(async (transaction) => operation(transaction as unknown as AppDatabase), { isolationLevel: "serializable" });
      } catch (error) {
        if (!isSerializationFailure(error) || attempt === 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, attempt * 20));
      }
    }
    throw new Error("Health transaction retry budget exhausted.");
  }
}

function decodeSleepImage(input: SleepImageAnalysisRequest): { bytes: Buffer } {
  const separator = input.dataUrl.indexOf(",");
  if (separator < 0) throw new SleepImageValidationError("sleep screenshot data is malformed");
  const bytes = Buffer.from(input.dataUrl.slice(separator + 1), "base64");
  if (bytes.length === 0 || bytes.length > 6 * 1024 * 1024) {
    throw new SleepImageValidationError("sleep screenshot must be between 1 byte and 6 MB");
  }
  const matches = input.mimeType === "image/png"
    ? bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : input.mimeType === "image/jpeg"
      ? bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
      : bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  if (!matches) throw new SleepImageValidationError("sleep screenshot bytes do not match the declared image type");
  return { bytes };
}

function buildTemplateHealthPlan(profile: HealthProfile, activities: Array<{ localDate: string; title: string }>): HealthPlanContent {
  const base = ["strength", "recovery", "volleyball", "rest", "cycling", "strength", "running"] as const;
  const defaults: Record<typeof base[number], HealthPlanContent["days"][number]["movement"]> = {
    strength: { category: "strength", durationMinutes: { minimum: 60, maximum: 90 }, intensity: "moderate", highIntensity: false, safetyReminder: "以动作稳定和舒适范围为先；颈肩或膝部不适时主动降低负荷。" },
    recovery: { category: "recovery", durationMinutes: { minimum: 20, maximum: 45 }, intensity: "low", highIntensity: false, safetyReminder: "以轻松活动和恢复为主，不把恢复日变成补课式训练。" },
    volleyball: { category: "volleyball", durationMinutes: { minimum: 60, maximum: 120 }, intensity: "high", highIntensity: true, safetyReminder: "注意膝部反应和落地舒适度；不适时应停止并寻求专业建议。" },
    rest: { category: "rest", durationMinutes: { minimum: 0, maximum: 0 }, intensity: "rest", highIntensity: false, safetyReminder: "休息日不需要补偿性训练，保持日常活动即可。" },
    cycling: { category: "cycling", durationMinutes: { minimum: 45, maximum: 90 }, intensity: "moderate", highIntensity: false, safetyReminder: "优先白天、熟悉且安全的路线；感觉膝部不适时缩短行程。" },
    running: { category: "running", durationMinutes: { minimum: 30, maximum: 45 }, intensity: "moderate", highIntensity: false, safetyReminder: "以舒适、可对话的强度为参考；膝部不适时改为恢复活动。" }
  };
  const vegetableSets = [["番茄", "油麦菜"], ["芦笋", "白菜"], ["苦瓜", "番茄"], ["莲花白", "深色叶菜"], ["芹菜", "白菜"], ["苦菜", "番茄"], ["时令绿叶菜", "菌菇"]];
  return {
    overview: `本周以稳定增肌支持、恢复和不过度堆叠高强度为主。结合${profile.city ? ` ${profile.city} 的` : "日常"}食堂或外卖场景，不需要称重或打卡；若有不适，请以安全和休息为先。`,
    supplements: ["鱼油、多种维生素与维生素 D 仅作可选参考：先查看实际标签，避免重复成分。", "未掌握产品含量、近期检查和药物情况时，不给出确定剂量；有疑问请咨询专业人士。", "肌酸仍保持“未来可讨论”的状态，不自动加入本周安排。"],
    days: base.map((kind, index) => {
      const scheduled = activities.find((activity) => activity.localDate && includesActivity(activity.title, kind));
      const movement = scheduled
        ? { ...defaults[kind], safetyReminder: `${defaults[kind].safetyReminder} 已参考当天已有的“${scheduled.title}”安排。` }
        : defaults[kind];
      const highDay = movement.highIntensity;
      return {
        nutritionDirection: highDay
          ? "高强度日保持三餐餐盘完整，主食和主要蛋白质来源不要因忙碌而随意省略。"
          : "维持正常餐盘结构：每餐有主要蛋白质来源，午晚餐尽量搭配两类蔬菜。",
        proteinRangeGrams: { minimum: 90, maximum: 120 },
        plateGuidance: ["早餐包含主食和一种蛋白质来源。", "午餐和晚餐优先一份主要蛋白质来源加两类蔬菜。", "不喜欢海鲜时，可从食堂常见肉、蛋、奶和豆制品中灵活选择。"],
        seasonalVegetables: vegetableSets[index]!,
        movement
      };
    })
  };
}

function includesActivity(title: string, kind: string): boolean {
  const lower = title.toLowerCase();
  return (kind === "strength" && /力量|健身|训练/.test(title))
    || (kind === "volleyball" && /排球/.test(title))
    || (kind === "cycling" && /骑行/.test(title))
    || (kind === "running" && /跑步|慢跑/.test(title))
    || (kind === "recovery" && /恢复|拉伸|散步/.test(title))
    || lower.length < 0;
}

function sleepRevisionReason(localDate: string, analysis: SleepImageAnalysis): string {
  const metrics: string[] = [];
  if (analysis.totalSleepMinutes !== null) metrics.push(`总睡眠 ${analysis.totalSleepMinutes} 分钟`);
  if (analysis.deepSleepMinutes !== null) metrics.push(`深睡 ${analysis.deepSleepMinutes} 分钟`);
  if (analysis.awakeCount !== null) metrics.push(`清醒 ${analysis.awakeCount} 次`);
  if (analysis.deviceScore !== null) metrics.push(`设备评分 ${analysis.deviceScore}`);
  const visibleSummary = metrics.length > 0 ? metrics.join("、") : "截图中可见的睡眠信息";
  return `基于你主动上传的 ${localDate} 睡眠截图（${visibleSummary}）生成本次修订候选。它不会修改健康资料；确认前，原本周参考保持不变。`;
}

function solarTermFor(localDate: string): string {
  const monthDay = localDate.slice(5);
  const terms: Array<[string, string]> = [["01-05", "小寒"], ["01-20", "大寒"], ["02-04", "立春"], ["02-19", "雨水"], ["03-06", "惊蛰"], ["03-21", "春分"], ["04-05", "清明"], ["04-20", "谷雨"], ["05-06", "立夏"], ["05-21", "小满"], ["06-06", "芒种"], ["06-21", "夏至"], ["07-07", "小暑"], ["07-23", "大暑"], ["08-08", "立秋"], ["08-23", "处暑"], ["09-08", "白露"], ["09-23", "秋分"], ["10-08", "寒露"], ["10-23", "霜降"], ["11-07", "立冬"], ["11-22", "小雪"], ["12-07", "大雪"], ["12-22", "冬至"]];
  let current = "冬至";
  for (const [boundary, term] of terms) if (monthDay >= boundary) current = term;
  return current;
}

function isSerializationFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "40001";
}
