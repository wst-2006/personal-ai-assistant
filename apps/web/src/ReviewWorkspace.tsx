import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, CheckCircle2, Clock3, Flame, MessageCircle, Send, Sparkles } from "lucide-react";

type Review = { id: string; localDate: string; state: string };
type Message = {
  id: string;
  content: string;
  source: string;
  createdAt: string;
};
type Context = {
  tasks: Array<{
    id: string;
    lifecycleStatus: string;
    plannedEffortMinutes: number | null;
  }>;
  outcomes: Array<{ taskId: string; outcome: string }>;
  focusSessions: Array<{
    id: string;
    rawActiveSeconds: number;
    effectiveFocusSeconds: number;
    state: string;
  }>;
  feedback: Array<{ satisfaction: string }>;
};
type BriefContent = { title:string; reflection:string; taskSummary:string; sections:Array<{title:string;body:string}> };
type Brief = { id:string; state:"draft"|"confirmed"; content:BriefContent; sources:Array<{kind:string;label:string}> };
const API = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3000";
const localDate = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
async function request<T>(
  path: string,
  method = "GET",
  body?: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error("review_request_failed");
  return (await response.json()) as T;
}

export function ReviewWorkspace() {
  const [review, setReview] = useState<Review | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [context, setContext] = useState<Context | null>(null);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const data = await request<{
      session: Review;
      messages: Message[];
      context: Context;
    }>(`/api/v1/reviews/${localDate()}`);
    setReview(data.session);
    setMessages(data.messages);
    setContext(data.context);
  }, []);
  useEffect(() => {
    void load().catch(() =>
      setError("无法加载今日复盘，请确认 API 正在运行。"),
    );
  }, [load]);
  const planned = useMemo(
    () =>
      context?.tasks.reduce(
        (sum, task) => sum + (task.plannedEffortMinutes ?? 0),
        0,
      ) ?? 0,
    [context],
  );
  const effective = useMemo(
    () =>
      Math.round(
        (context?.focusSessions.reduce(
          (sum, session) => sum + session.effectiveFocusSeconds,
          0,
        ) ?? 0) / 60,
      ),
    [context],
  );
  async function save() {
    if (!review || !draft.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const result = await request<{ message: Message }>(
        `/api/v1/reviews/${review.id}/messages`,
        "POST",
        { content: draft.trim(), source: "app" },
      );
      setMessages((current) => [...current, result.message]);
      setDraft("");
      await load();
    } catch {
      setError("这段复盘没有保存，请重试。");
    } finally {
      setSaving(false);
    }
  }
  async function generateBrief() {
    if (!review) return;
    setSaving(true); setError(null);
    try { const result=await request<{brief:Brief}>(`/api/v1/reviews/${review.id}/briefs`,"POST"); setBrief(result.brief); }
    catch { setError("至少保存一条复盘后，才能生成今日简报。"); }
    finally { setSaving(false); }
  }
  async function confirmBrief() {
    if (!brief) return;
    setSaving(true); setError(null);
    try { const result=await request<{brief:Brief}>(`/api/v1/briefs/${brief.id}`,"PATCH",{content:brief.content,state:"confirmed"}); setBrief(result.brief); }
    catch { setError("简报没有确认保存，请重试。"); }
    finally { setSaving(false); }
  }
  return (
    <section className="page review-page" aria-labelledby="review-title">
      <div className="review-heading">
        <div>
          <p className="eyebrow">一天将要落幕</p>
          <h1 id="review-title">把今天还给自己。</h1>
          <p>完成与感受可以同时成立，不需要互相证明。</p>
        </div>
        <div className="review-count">
          <strong>{messages.length}</strong>
          <span>条复盘片段</span>
        </div>
      </div>
      <div className="review-layout">
        <section className="review-checkin">
          <p className="section-kicker">今日回看</p>
          <div className="review-stat-row">
            <span>
              <CheckCircle2 />
              已安排
            </span>
            <strong>{context?.tasks.length ?? 0}</strong>
          </div>
          <div className="review-stat-row">
            <span>
              <Clock3 />
              计划时长
            </span>
            <strong>{planned}m</strong>
          </div>
          <div className="review-stat-row">
            <span>
              <Flame />
              有效专注
            </span>
            <strong>{effective}m</strong>
          </div>
          <div className="garden-mini">
            <span className="garden-stem" />
            <span className="garden-leaf leaf-a" />
            <span className="garden-leaf leaf-b" />
            <span className="garden-bud" />
          </div>
        </section>
        <section className="review-composer">
          <p className="section-kicker">留下一句话</p>
          <h2>今天有什么值得被看见？</h2>
          <textarea
            aria-label="复盘正文"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="可以写完成了什么、卡在哪里，或只是此刻的感受。"
            rows={6}
            maxLength={2000}
          />
          <div className="composer-footer">
            <span>{draft.length}/2000</span>
            <button
              className="primary-button"
              disabled={!draft.trim() || saving}
              onClick={() => void save()}
            >
              <Send />
              留在今天
            </button>
          </div>
        </section>
        <section className="review-stream">
          <p className="section-kicker">今日片段</p>
          {messages.length === 0 ? (
            <div className="stream-empty">
              <MessageCircle />
              第一句话会在这里亮起。
            </div>
          ) : (
            messages.map((message, index) => (
              <article key={message.id}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <p>{message.content}</p>
              </article>
            ))
          )}
          <button className="primary-button review-brief-trigger" disabled={messages.length===0||saving} onClick={()=>void generateBrief()}><Sparkles />结束今日复盘并生成简报</button>
        </section>
      </div>
      {brief && <section className="review-brief-editor"><div><p className="section-kicker">每日简报草稿</p><h2>{brief.content.title}</h2></div><label>复盘摘要<textarea aria-label="简报复盘摘要" value={brief.content.reflection} onChange={event=>setBrief({...brief,content:{...brief.content,reflection:event.target.value}})} rows={5}/></label><label>任务摘要<textarea aria-label="简报任务摘要" value={brief.content.taskSummary} onChange={event=>setBrief({...brief,content:{...brief.content,taskSummary:event.target.value}})} rows={3}/></label><p className="brief-source-note">来源：{brief.sources.map(source=>source.label).join("；")}</p><button className="primary-button" disabled={saving||brief.state==="confirmed"} onClick={()=>void confirmBrief()}><Check />{brief.state==="confirmed"?"简报已确认":"确认简报"}</button></section>}
      {error && (
        <div className="focus-error" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}
