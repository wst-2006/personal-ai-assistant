import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, CheckCircle2, Clock3, Download, Flame, MapPin, MessageCircle, RefreshCw, Send, Sparkles } from "lucide-react";

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
    startAt: string | null;
    endAt: string | null;
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
type BriefContent = {
  title:string;
  reflection:string;
  taskSummary:string;
  sections:Array<{title:string;body:string}>;
  location?: { name:string; latitude:number; longitude:number; timeZone:string } | null;
  weather?: { temperatureCelsius:number; apparentTemperatureCelsius:number; weatherCode:number; observedAt:string|null } | null;
};
type Brief = { id:string; state:"draft"|"confirmed"; content:BriefContent; sources:Array<{kind:string;label:string;url?:string;provider?:string}> };
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

function briefText(brief: Brief) {
  const sections = brief.content.sections
    .map((section) => `## ${section.title}\n${section.body}`)
    .join("\n\n");
  const location = brief.content.location ? `地点：${brief.content.location.name}\n` : "";
  const weather = brief.content.weather
    ? `天气：${brief.content.weather.temperatureCelsius}°C，体感 ${brief.content.weather.apparentTemperatureCelsius}°C，代码 ${brief.content.weather.weatherCode}\n`
    : "";
  const sources = brief.sources.length
    ? `\n来源：\n${brief.sources.map((source) => `- ${source.label}${source.url ? `：${source.url}` : ""}`).join("\n")}`
    : "";
  return `${brief.content.title}\n\n${location}${weather}\n## 复盘摘要\n${brief.content.reflection}\n\n## 任务摘要\n${brief.content.taskSummary}\n\n${sections}${sources}\n`;
}

export function ReviewWorkspace() {
  const [review, setReview] = useState<Review | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [context, setContext] = useState<Context | null>(null);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [briefEditing, setBriefEditing] = useState(false);
  const [locationName, setLocationName] = useState("");
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const data = await request<{
      session: Review;
      messages: Message[];
      context: Context;
      briefs: Brief[];
    }>(`/api/v1/reviews/${localDate()}`);
    setReview(data.session);
    setMessages(data.messages);
    setContext(data.context);
    const latestBrief = data.briefs.at(-1) ?? null;
    setBrief(latestBrief);
    setBriefEditing(false);
    if (latestBrief?.content.location?.name) setLocationName((current) => current || latestBrief.content.location!.name);
  }, []);
  useEffect(() => {
    void load().catch(() =>
      setError("无法加载今日复盘，请确认 API 正在运行。"),
    );
  }, [load]);
  const planned = useMemo(
    () =>
      context?.tasks.reduce((sum, task) => {
        if (!task.startAt || !task.endAt) return sum;
        return sum + Math.max(0, Math.round((new Date(task.endAt).getTime() - new Date(task.startAt).getTime()) / 60000));
      }, 0) ?? 0,
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
    try {
      const result=await request<{brief:Brief}>(`/api/v1/reviews/${review.id}/briefs`,"POST",{
        ...(locationName.trim() ? { locationName: locationName.trim() } : {})
      });
      setBrief(result.brief);
      setBriefEditing(false);
      if (result.brief.content.location?.name) setLocationName(result.brief.content.location.name);
    }
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
  function exportBrief() {
    if (!brief) return;
    const file = new Blob([briefText(brief)], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${review?.localDate ?? localDate()}-daily-brief.txt`;
    link.click();
    URL.revokeObjectURL(url);
  }
  async function saveBriefEdits() {
    if (!brief) return;
    setSaving(true); setError(null);
    try {
      const result = await request<{brief: Brief}>(`/api/v1/briefs/${brief.id}`, "PATCH", { content: brief.content, state: brief.state });
      setBrief(result.brief);
      setBriefEditing(false);
    } catch {
      setError("简报修改没有保存，请重试。");
    } finally { setSaving(false); }
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
          <div className="review-brief-actions">
            <label className="review-location-field">
              <span><MapPin />今日地点（可选）</span>
              <input aria-label="今日地点" value={locationName} onChange={(event)=>setLocationName(event.target.value)} placeholder="例如：上海、杭州、西安" maxLength={120}/>
            </label>
            <button className="primary-button review-brief-trigger" disabled={messages.length===0||saving} onClick={()=>void generateBrief()}><Sparkles />结束今日复盘并生成简报</button>
          </div>
        </section>
      </div>
      {brief && <section className="review-brief-editor"><div><p className="section-kicker">每日简报{brief.state === "confirmed" ? " · 已确认" : "草稿"}</p><h2>{brief.content.title}</h2><div className="brief-toolbar"><button className="quiet-button" type="button" disabled={saving} onClick={()=>void generateBrief()}><RefreshCw />重新生成</button><button className="quiet-icon" type="button" aria-label="导出简报" onClick={exportBrief}><Download /></button></div></div><label>复盘摘要<textarea aria-label="简报复盘摘要" disabled={brief.state==="confirmed"&&!briefEditing} value={brief.content.reflection} onChange={event=>setBrief({...brief,content:{...brief.content,reflection:event.target.value}})} rows={5}/></label><label>任务摘要<textarea aria-label="简报任务摘要" disabled={brief.state==="confirmed"&&!briefEditing} value={brief.content.taskSummary} onChange={event=>setBrief({...brief,content:{...brief.content,taskSummary:event.target.value}})} rows={3}/></label><div className="brief-sections">{brief.content.sections.map((section,index)=><label key={`${section.title}-${index}`}>{section.title}<textarea aria-label={`${section.title}简报内容`} disabled={brief.state==="confirmed"&&!briefEditing} value={section.body} onChange={event=>setBrief({...brief,content:{...brief.content,sections:brief.content.sections.map((item,itemIndex)=>itemIndex===index?{...item,body:event.target.value}:item)}})} rows={3}/></label>)}</div><p className="brief-source-note">来源：{brief.sources.map(source=>source.label).join("；")}</p>{brief.state==="confirmed"&&!briefEditing?<button className="quiet-button" type="button" onClick={()=>setBriefEditing(true)}>编辑简报</button>:<button className="primary-button" disabled={saving} onClick={()=>void (brief.state==="draft"?confirmBrief():saveBriefEdits())}><Check />{brief.state==="draft"?"确认简报":"保存修改"}</button>}</section>}
      {error && (
        <div className="focus-error" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}
