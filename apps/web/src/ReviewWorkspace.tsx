import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Check, Download, MapPin, MessageCircle, RefreshCw } from "lucide-react";
import { RadarChart, type RadarValues } from "./ReviewRadar";

type Review = { id: string; localDate: string; state: string };
type Message = {
  id: string;
  content: string;
  source: string;
  createdAt: string;
};
type RadarSnapshot = { id: string; reviewSessionId: string; radar: RadarValues; createdAt: string };
type Context = {
  tasks: Array<{
    id: string;
    recordKind?: string;
    lifecycleStatus: string;
    currentOutcome: string | null;
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
  conversations: Array<{ id: string; localDate: string }>;
  conversationMessages: Array<{
    id: string;
    conversationId: string;
    role: "user" | "assistant";
    content: string;
    createdAt: string;
  }>;
};
type BriefContent = {
  title:string;
  reflection:string;
  taskSummary:string;
  sections:Array<{title:string;body:string}>;
  location?: { name:string; latitude:number; longitude:number; timeZone:string } | null;
  weather?: { temperatureCelsius:number; apparentTemperatureCelsius:number; weatherCode:number; observedAt:string|null } | null;
};
type Brief = { id:string; state:"draft"|"confirmed"; content:BriefContent; sources:Array<{kind:string;label:string;url?:string;provider?:string;retrievedAt?:string}> };
type GrowthDay = { localDate: string; focusMinutes: number; closedTasks: number; points: number };
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
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw Object.assign(new Error(error.error ?? "review_request_failed"), { body: error });
  }
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

const chineseDigits = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
function chineseNumber(value: number) {
  if (value < 10) return chineseDigits[value] ?? String(value);
  if (value < 20) return `十${value === 10 ? "" : chineseDigits[value % 10]}`;
  if (value < 100) return `${chineseDigits[Math.floor(value / 10)]}十${value % 10 === 0 ? "" : chineseDigits[value % 10]}`;
  return String(value);
}

function reviewDateLabel(value: string) {
  const date = new Date(`${value}T12:00:00+08:00`);
  const weekday = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", weekday: "short" }).format(date);
  return `${chineseNumber(Number(value.slice(5, 7)))}月${chineseNumber(Number(value.slice(8, 10)))} · ${weekday}`;
}

export function ReviewWorkspace({ isWorkspaceCurrent = true }: { isWorkspaceCurrent?: boolean }) {
  const [review, setReview] = useState<Review | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [radarSnapshot, setRadarSnapshot] = useState<RadarSnapshot | null>(null);
  const [context, setContext] = useState<Context | null>(null);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [briefEditing, setBriefEditing] = useState(false);
  const [locationName, setLocationName] = useState("");
  const [recentGrowthDays, setRecentGrowthDays] = useState<GrowthDay[]>([]);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reviewInputRef = useRef<HTMLTextAreaElement>(null);
  const [emptyPromptActive, setEmptyPromptActive] = useState(false);
  const load = useCallback(async () => {
    const growthRequest = fetch(`${API}/api/v1/growth/summary?endDate=${localDate()}&days=30`)
      .then(async (response) => response.ok ? (await response.json() as { summary: { days: GrowthDay[] } }).summary.days : [])
      .catch(() => [] as GrowthDay[]);
    const data = await request<{
      session: Review;
      messages: Message[];
      radarSnapshot: RadarSnapshot | null;
      context: Context;
      briefs: Brief[];
    }>(`/api/v1/reviews/${localDate()}`);
    setReview(data.session);
    setMessages(data.messages);
    setRadarSnapshot(data.radarSnapshot);
    setContext(data.context);
    setRecentGrowthDays(await growthRequest);
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
  const plannedTaskCount = useMemo(
    () => context?.tasks.filter((task) => task.recordKind !== "backfill" && task.lifecycleStatus !== "cancelled").length ?? 0,
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
  const completed = useMemo(
    () => context?.tasks.filter((task) => task.currentOutcome === "complete").length ?? 0,
    [context],
  );
  const userMessageCount = useMemo(
    () => messages.filter((message) => message.source === "app").length,
    [messages],
  );
  const conversationMessages = useMemo(() => messages.filter((message) => message.source === "app" || message.source === "ai"), [messages]);
  const lastConversationMessage = conversationMessages.at(-1);
  const streakDays = useMemo(() => {
    const currentDate = review?.localDate ?? localDate();
    const days = [...recentGrowthDays].sort((left, right) => left.localDate.localeCompare(right.localDate));
    let streak = 0;
    for (let index = days.length - 1; index >= 0; index -= 1) {
      const day = days[index]!;
      const currentReviewActivity = day.localDate === currentDate && userMessageCount > 0;
      const hasRealActivity = day.focusMinutes > 0 || day.closedTasks > 0 || day.points > 0 || currentReviewActivity;
      if (!hasRealActivity) break;
      streak += 1;
    }
    return streak;
  }, [recentGrowthDays, review?.localDate, userMessageCount]);
  async function save() {
    if (!review || !draft.trim()) return;
    setSaving(true);
    setError(null);
    const content = draft.trim();
    try {
      const result = await request<{ session: Review; message: Message }>(
        `/api/v1/reviews/${review.id}/messages`,
        "POST",
        { content, source: "app" },
      );
      setReview(result.session);
      setMessages((current) => [...current, result.message]);
      setDraft("");
    } catch {
      setError("这段复盘没有保存，请重试。");
      setSaving(false);
      return;
    }
    setSaving(false);
  }
  async function replyToLast() {
    if (!review || lastConversationMessage?.source !== "app") return;
    setSaving(true);
    setError(null);
    try {
      const result = await request<{ session: Review; messages: Message[] }>(
        `/api/v1/reviews/${review.id}/reply-last`,
        "POST",
      );
      setReview(result.session);
      setMessages(result.messages);
    } catch {
      setError("最近一条复盘仍然保留，AI 暂时没有回复；请稍后重试。");
      await load().catch(() => undefined);
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
    catch (requestError) {
      setError(requestError instanceof Error && requestError.message === "brief_sources_unavailable"
        ? "网页搜索服务暂时不可用，因此没有生成或保存缺少来源支撑的简报。请稍后重试。"
        : requestError instanceof Error && requestError.message === "brief_generation_unavailable"
          ? "搜索资料已读取，但 AI 没有生成合格的简报，因此没有保存不完整结果。请稍后重试。"
          : "至少保存一条由你写下的复盘后，才能生成今日简报。");
    }
    finally { setSaving(false); }
  }
  function returnToReviewInput() {
    setEmptyPromptActive(true);
    window.setTimeout(() => {
      reviewInputRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      window.setTimeout(() => reviewInputRef.current?.focus({ preventScroll: true }), 420);
      setEmptyPromptActive(false);
    }, 170);
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
          <strong>{userMessageCount}</strong>
          <span>条我的复盘</span>
        </div>
      </div>
      <section className="review-colophon" aria-label="今日题记">
        <div className="review-colophon-heading">
          <p className="section-kicker">今日回看</p>
          <time dateTime={review?.localDate ?? localDate()}>{reviewDateLabel(review?.localDate ?? localDate())}</time>
        </div>
        <div className="review-completion-mark">
          <strong>{chineseNumber(completed)}</strong>
          <span>今日完成</span>
        </div>
        <dl className="review-colophon-metrics">
          <div><dt>计划</dt><dd>{plannedTaskCount}<small>项</small></dd></div>
          <div><dt>专注</dt><dd>{effective}m</dd></div>
        </dl>
        <div
          className="review-growth-plant"
          data-growth-stage={effective >= 60 ? "two-leaf" : effective >= 20 ? "sprout" : "seed"}
          data-reviewed={userMessageCount > 0 ? "true" : "false"}
          style={{ "--review-streak-growth": `${Math.min(streakDays, 7) * 6}px` } as CSSProperties}
          aria-label={`今日植物：有效专注 ${effective} 分钟${userMessageCount > 0 ? "，已完成主动复盘" : ""}${streakDays > 0 ? `，连续留下记录 ${streakDays} 天` : ""}`}
        >
          <i className="review-seed" /><i className="review-stem" /><i className="review-leaf leaf-one" /><i className="review-leaf leaf-two" /><i className="review-new-leaf" />
        </div>
      </section>
      <section className="review-sheet" aria-labelledby="review-fragment-title">
        <header>
          <div><p className="section-kicker">今日片段</p><h2 id="review-fragment-title">让一句话，直接落在纸上。</h2></div>
          <span>{userMessageCount ? `已留下 ${userMessageCount} 笔` : "纸面尚空"}</span>
        </header>
        <div className="review-writing-field" aria-live="polite">
          {conversationMessages.length === 0 ? (
            <div className="stream-empty"><MessageCircle /><p>第一句话，会在这里亮起。</p></div>
          ) : (
            <div className="review-fragment-list">
              {conversationMessages.map((message, index) => (
                <article className={message.source === "ai" ? "ai" : "app"} key={message.id}>
                  <span>{message.source === "ai" ? "AI 回应" : `第 ${chineseNumber(index + 1)} 笔`}</span>
                  <p>{message.content}</p>
                </article>
              ))}
            </div>
          )}
          <textarea
            ref={reviewInputRef}
            aria-label="复盘正文"
            disabled={!isWorkspaceCurrent || !review}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="今天下午忽然觉得……"
            rows={6}
            maxLength={2000}
          />
        </div>
        <footer className="review-sheet-footer">
          <span>{draft.length}/2000</span>
          <div className="review-composer-actions"><button className="primary-button review-save-button" disabled={!isWorkspaceCurrent || !draft.trim() || saving} onClick={() => void save()}><Check />保存</button></div>
        </footer>
        {lastConversationMessage?.source === "app" && (
          <button className="text-button review-reply-last" type="button" disabled={saving} onClick={() => void replyToLast()}><RefreshCw />{saving ? "正在等待 AI" : "请 AI 回应最近一条"}</button>
        )}
        <div className="review-roll-actions">
          <section className="review-location-caption" aria-label="所在地点">
            <div className="review-location-copy"><strong><MapPin />所在地点</strong><small>可选填写</small><label><span>今天在哪里留下这段记录</span><input aria-label="所在地点" disabled={!isWorkspaceCurrent || !review} value={locationName} onChange={(event)=>setLocationName(event.target.value)} placeholder="例如：杭州" maxLength={120}/></label></div>
            <div className="review-location-art" role="img" aria-label="淡化的千里江山图局部" />
          </section>
          <button className="review-close-scroll" aria-label="收卷并生成今日简报" disabled={userMessageCount===0||saving} onClick={()=>void generateBrief()}>
            <span>收卷</span><i aria-hidden="true">成</i><small>生成今日简报</small>
          </button>
        </div>
      </section>
      <section className="review-radar-archive" aria-labelledby="review-radar-title">
        <div className="review-radar-archive-heading">
          <div><p className="section-kicker">今日六维</p><h2 id="review-radar-title">把体验留成一张图。</h2></div>
          <span>{radarSnapshot ? "已保存" : "尚未保存"}</span>
        </div>
        {radarSnapshot ? <div className="review-radar-snapshot">
          <RadarChart values={radarSnapshot.radar} ariaLabel="今日六维回看快照" />
          <div className="review-radar-snapshot-copy">
            <strong>今日体验快照</strong>
            <p>这张图来自你在成长页最后一次确认的六维评分。它固定保留在今天的复盘里，不会被之后的统计范围切换改写。</p>
            <div className="review-radar-snapshot-meta"><span>保存于 {new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(radarSnapshot.createdAt))}</span><span>六项均为 0–100 分</span></div>
          </div>
        </div> : <p className="review-radar-empty">今天还没有保存六维体验。去成长页拖动六个顶点，确认后它会出现在这里。</p>}
      </section>
      <section className="review-software-conversations" aria-labelledby="review-software-conversations-title">
        <div><p className="section-kicker">软件内对话</p><h2 id="review-software-conversations-title">今天与 AI 商量过的内容</h2><small>它与复盘正文分开保存，不会替代你在复盘页留下的一句话。</small></div>
        {context?.conversationMessages.length ? <div className="review-software-conversation-list">{context.conversationMessages.slice(-4).map((message) => <article key={message.id} className={message.role}><time>{new Intl.DateTimeFormat("zh-CN",{timeZone:"Asia/Shanghai",hour:"2-digit",minute:"2-digit",hour12:false}).format(new Date(message.createdAt))}</time><div><strong>{message.role === "user" ? "我提出的商量" : "AI 留下的回应"}</strong><p>{message.content}</p></div></article>)}</div> : <div className="review-software-conversation-empty"><strong>今日尚未起笔</strong><div aria-hidden="true"><i/><i/><i/></div><small>回到上方，留下一句今日复盘</small><button className={`review-empty-seal ${emptyPromptActive?"active":""}`} type="button" onClick={returnToReviewInput} aria-label="回到复盘输入区并开始书写"><span aria-hidden="true">待</span></button></div>}
      </section>
      {brief && <section className="review-brief-editor">
        <div>
          <p className="section-kicker">每日简报{brief.state === "confirmed" ? " · 已确认" : "草稿"}</p>
          {briefEditing
            ? <input className="brief-title-input" aria-label="简报标题" value={brief.content.title} maxLength={200} onChange={(event)=>setBrief({...brief,content:{...brief.content,title:event.target.value}})} />
            : <h2>{brief.content.title}</h2>}
          <div className="brief-toolbar">
            <button className="quiet-button" type="button" disabled={saving} onClick={()=>void generateBrief()}><RefreshCw />重新生成</button>
            <button className="quiet-icon" type="button" aria-label="导出简报" onClick={exportBrief}><Download /></button>
          </div>
        </div>
        <label>复盘摘要<textarea aria-label="简报复盘摘要" disabled={brief.state==="confirmed"&&!briefEditing} value={brief.content.reflection} onChange={event=>setBrief({...brief,content:{...brief.content,reflection:event.target.value}})} rows={5}/></label>
        <label>任务摘要<textarea aria-label="简报任务摘要" disabled={brief.state==="confirmed"&&!briefEditing} value={brief.content.taskSummary} onChange={event=>setBrief({...brief,content:{...brief.content,taskSummary:event.target.value}})} rows={3}/></label>
        <div className="brief-sections">{brief.content.sections.map((section,index)=><label key={`${index}-${section.title}`}>
          {briefEditing
            ? <input className="brief-section-title-input" aria-label={`第 ${index + 1} 个简报板块标题`} value={section.title} maxLength={100} onChange={event=>setBrief({...brief,content:{...brief.content,sections:brief.content.sections.map((item,itemIndex)=>itemIndex===index?{...item,title:event.target.value}:item)}})} />
            : section.title}
          <textarea aria-label={`${section.title}简报内容`} disabled={brief.state==="confirmed"&&!briefEditing} value={section.body} onChange={event=>setBrief({...brief,content:{...brief.content,sections:brief.content.sections.map((item,itemIndex)=>itemIndex===index?{...item,body:event.target.value}:item)}})} rows={3}/>
        </label>)}</div>
        <div className="brief-source-list" aria-label="简报来源">
          <strong>可追溯来源</strong>
          {brief.sources.map((source,index)=><div className="brief-source-item" key={`${source.kind}-${source.url ?? source.label}-${index}`}>
            {source.url ? <a href={source.url} target="_blank" rel="noreferrer">{source.label}</a> : <span>{source.label}</span>}
            {source.provider && <small>{source.provider}</small>}
          </div>)}
        </div>
        {brief.state==="confirmed"&&!briefEditing
          ? <button className="quiet-button" type="button" onClick={()=>setBriefEditing(true)}>编辑简报</button>
          : <button className="primary-button" disabled={saving||!brief.content.title.trim()||brief.content.sections.some(section=>!section.title.trim()||!section.body.trim())} onClick={()=>void (brief.state==="draft"?confirmBrief():saveBriefEdits())}><Check />{brief.state==="draft"?"确认简报":"保存修改"}</button>}
      </section>}
      {error && (
        <div className="focus-error" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}
