import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Cloud, CloudFog, CloudLightning, CloudRain, CloudSnow, CloudSun, LocateFixed, MapPin, MessageCircle, RefreshCw, Sun } from "lucide-react";
import { RadarChart, type RadarValues } from "./ReviewRadar";

type Review = { id: string; localDate: string; state: string };
type Message = { id: string; content: string; source: string; createdAt: string };
type RadarSnapshot = { id: string; reviewSessionId: string; radar: RadarValues; createdAt: string };
type Context = {
  tasks: Array<{ id: string; title: string; recordKind?: string; scheduleKind: "none" | "daypart" | "exact"; lifecycleStatus: string; currentOutcome: string | null; startAt: string | null; endAt: string | null }>;
  outcomes: Array<{ taskId: string; outcome: string; progressPercent: number }>;
  focusSessions: Array<{ id: string; taskId: string; rawActiveSeconds: number; effectiveFocusSeconds: number; state: string; startedAt?: string | null }>;
  feedback: Array<{ taskId: string; satisfaction: string }>;
  conversationMessages: Array<{ id: string; conversationId: string; role: "user" | "assistant"; content: string; createdAt: string }>;
};
type WeatherBrief = { id: string; content: { title: string; sections: Array<{ title: string; body: string }>; location?: { name: string; latitude: number; longitude: number; timeZone: string } | null; weather?: { temperatureCelsius: number; apparentTemperatureCelsius: number; weatherCode: number; observedAt: string | null } | null } };
type ConversationTurn = { id: string; askedAt: string; question: string; replies: Context["conversationMessages"] };
type TauriInternals = { invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T> };
const API = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3000";
const localDate = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
async function request<T>(path: string, method = "GET", body?: Record<string, unknown>): Promise<T> { const response = await fetch(`${API}${path}`, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined }); if (!response.ok) throw new Error((await response.json().catch(() => ({})) as { error?: string }).error ?? "review_request_failed"); return await response.json() as T; }
const chineseDigits = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
function chineseNumber(value: number) { if (value < 10) return chineseDigits[value] ?? String(value); if (value < 20) return `十${value === 10 ? "" : chineseDigits[value % 10]}`; if (value < 100) return `${chineseDigits[Math.floor(value / 10)]}十${value % 10 === 0 ? "" : chineseDigits[value % 10]}`; return String(value); }
function reviewDateLabel(value: string) { const date = new Date(`${value}T12:00:00+08:00`); const weekday = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", weekday: "short" }).format(date); return `${chineseNumber(Number(value.slice(5, 7)))}月${chineseNumber(Number(value.slice(8, 10)))} · ${weekday}`; }
function timeLabel(value: string | null) { return value ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value)) : "未排期"; }
function weatherDateLabel(value: string | null | undefined) { return value ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "long", day: "numeric" }).format(new Date(value)) : new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "long", day: "numeric" }).format(new Date()); }
function weatherPresentation(code: number | undefined) {
  if (code === 0) return { label: "晴", Icon: Sun };
  if (code !== undefined && [1, 2].includes(code)) return { label: "少云", Icon: CloudSun };
  if (code === 3) return { label: "阴 / 多云", Icon: Cloud };
  if (code !== undefined && [45, 48].includes(code)) return { label: "雾", Icon: CloudFog };
  if (code !== undefined && [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return { label: "有雨", Icon: CloudRain };
  if (code !== undefined && [71, 73, 75, 77, 85, 86].includes(code)) return { label: "有雪", Icon: CloudSnow };
  if (code !== undefined && [95, 96, 99].includes(code)) return { label: "雷雨", Icon: CloudLightning };
  return { label: "天气暂不可用", Icon: Cloud };
}
function locationCoordinates(value: string | null | undefined) {
  const match = value?.trim().match(/^(-?\d+(?:\.\d+)?)\s*[，,]\s*(-?\d+(?:\.\d+)?)$/u);
  if (!match) return null;
  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  return Number.isFinite(latitude) && Number.isFinite(longitude) ? { latitude, longitude } : null;
}
function outcomeLabel(outcome: string | null | undefined, progress?: number) { if (outcome === "complete") return "完成"; if (outcome === "partial") return `部分完成${progress === undefined ? "" : ` · ${progress}%`}`; if (outcome === "not_completed") return "未完成"; return "未记录结果"; }
function satisfactionLabel(value: string | null | undefined) { if (value === "satisfied") return "满意"; if (value === "neutral") return "一般"; if (value === "dissatisfied") return "不满意"; return "未评价"; }
function conversationTurns(messages: Context["conversationMessages"]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      turns.push({ id: message.id, askedAt: message.createdAt, question: message.content, replies: [] });
      continue;
    }
    const current = turns.at(-1);
    if (current) current.replies.push(message);
  }
  return turns;
}

export function ReviewWorkspace({ isWorkspaceCurrent = true }: { isWorkspaceCurrent?: boolean }) {
  const [review, setReview] = useState<Review | null>(null); const [messages, setMessages] = useState<Message[]>([]); const [radarSnapshot, setRadarSnapshot] = useState<RadarSnapshot | null>(null); const [context, setContext] = useState<Context | null>(null); const [weatherBrief, setWeatherBrief] = useState<WeatherBrief | null>(null); const [locationName, setLocationName] = useState(""); const [draft, setDraft] = useState(""); const [saving, setSaving] = useState(false); const [locating, setLocating] = useState(false); const [error, setError] = useState<string | null>(null); const [conversationOpen, setConversationOpen] = useState(false); const [taskSummaryExpanded, setTaskSummaryExpanded] = useState(false); const reviewInputRef = useRef<HTMLTextAreaElement>(null);
  const load = useCallback(async () => { const data = await request<{ session: Review; messages: Message[]; radarSnapshot: RadarSnapshot | null; context: Context; briefs: WeatherBrief[] }>(`/api/v1/reviews/${localDate()}`); setReview(data.session); setMessages(data.messages); setRadarSnapshot(data.radarSnapshot); setContext(data.context); let latest = [...data.briefs].reverse().find((brief) => brief.content.title === "今日地点及天气情况") ?? null; const savedLocation = latest?.content.location; const legacyCoordinates = locationCoordinates(savedLocation?.name); if (latest && savedLocation && legacyCoordinates) { try { latest = (await request<{ brief: WeatherBrief }>(`/api/v1/reviews/${data.session.id}/location-weather`, "POST", { latitude: savedLocation.latitude, longitude: savedLocation.longitude })).brief; } catch { latest = null; } } setWeatherBrief(latest); const name = latest?.content.location?.name; setLocationName(name && !locationCoordinates(name) ? name : ""); }, []);
  useEffect(() => { void load().catch(() => setError("无法加载今日复盘，请确认 API 正在运行。")); }, [load]);
  const plannedTaskCount = useMemo(() => context?.tasks.filter((task) => task.recordKind !== "backfill" && task.lifecycleStatus !== "cancelled").length ?? 0, [context]); const effective = useMemo(() => Math.round((context?.focusSessions.reduce((sum, session) => sum + session.effectiveFocusSeconds, 0) ?? 0) / 60), [context]); const completed = useMemo(() => context?.tasks.filter((task) => {
    if (task.currentOutcome === "complete" || task.currentOutcome === "partial") return true;
    if (task.currentOutcome === "not_completed" || task.scheduleKind !== "exact" || !task.startAt || !task.endAt) return false;
    const startAt = task.startAt;
    const endAt = task.endAt;
    return Boolean(startAt && endAt && context.focusSessions.some((session) => session.taskId === task.id && session.startedAt && new Date(session.startedAt).getTime() >= new Date(startAt).getTime() && new Date(session.startedAt).getTime() < new Date(endAt).getTime()));
  }).length ?? 0, [context]); const userMessages = useMemo(() => messages.filter((message) => message.source === "app"), [messages]); const conversationMessages = useMemo(() => messages.filter((message) => message.source === "app" || message.source === "ai"), [messages]); const lastConversationMessage = conversationMessages.at(-1);
  const taskSummaries = useMemo(() => {
    if (!context) return [];
    const now = Date.now();
    return context.tasks.flatMap((task) => {
      if (task.recordKind === "backfill" || task.scheduleKind !== "exact" || !task.startAt || !task.endAt || task.lifecycleStatus === "cancelled") return [];
      const outcome = [...context.outcomes].reverse().find((item) => item.taskId === task.id);
      const feedback = [...context.feedback].reverse().find((item) => item.taskId === task.id);
      const taskFocusSessions = context.focusSessions.filter((item) => item.taskId === task.id);
      const focusSeconds = taskFocusSessions.reduce((sum, item) => sum + item.effectiveFocusSeconds, 0);
      const startedWithinWindow = Boolean(task.startAt && task.endAt && taskFocusSessions.some((session) => session.startedAt && new Date(session.startedAt).getTime() >= new Date(task.startAt!).getTime() && new Date(session.startedAt).getTime() < new Date(task.endAt!).getTime()));
      const hasFinishedRecord = task.lifecycleStatus === "awaiting_outcome" || task.lifecycleStatus === "closed" || Boolean(outcome) || taskFocusSessions.some((item) => item.state === "ended" && (item.rawActiveSeconds > 0 || item.effectiveFocusSeconds > 0));
      if (new Date(task.endAt).getTime() > now && !hasFinishedRecord) return [];
      return [{ ...task, outcome, feedback, focusSeconds, startedWithinWindow }];
    });
  }, [context]);
  const softwareConversationTurns = useMemo(() => conversationTurns(context?.conversationMessages ?? []), [context?.conversationMessages]);
  async function save() { if (!review || !draft.trim()) return; setSaving(true); setError(null); try { const result = await request<{ session: Review; message: Message }>(`/api/v1/reviews/${review.id}/messages`, "POST", { content: draft.trim(), source: "app" }); setReview(result.session); setMessages((current) => [...current, result.message]); setDraft(""); } catch { setError("这段复盘没有保存，请重试。"); } finally { setSaving(false); } }
  async function replyToLast() { if (!review || lastConversationMessage?.source !== "app") return; setSaving(true); setError(null); try { const result = await request<{ session: Review; messages: Message[] }>(`/api/v1/reviews/${review.id}/reply-last`, "POST"); setReview(result.session); setMessages(result.messages); } catch { setError("最近一条复盘仍然保留，AI 暂时没有回复；请稍后重试。"); await load().catch(() => undefined); } finally { setSaving(false); } }
  async function recordWeather(body: Record<string, unknown>) { if (!review) return; setSaving(true); setError(null); try { const result = await request<{ brief: WeatherBrief }>(`/api/v1/reviews/${review.id}/location-weather`, "POST", body); const name = result.brief.content.location?.name; if (locationCoordinates(name)) { setWeatherBrief(null); setLocationName(""); setError("本机位置已读取，但城市识别没有返回结果。请重启 API 后再读取一次位置。"); } else { setWeatherBrief(result.brief); if (name) setLocationName(name); } } catch { setError("地点或天气没有记录，请检查地点后重试。"); } finally { setSaving(false); } }
  async function useDeviceLocation() {
    const tauri = (window as typeof window & { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
    if (tauri) {
      setLocating(true); setError(null);
      try {
        const coordinates = await tauri.invoke<{ latitude: number; longitude: number }>("device_location");
        setLocating(false);
        await recordWeather(coordinates);
        return;
      } catch (reason) {
        setLocating(false);
        const message = String(reason);
        setError(message.includes("permission_denied") ? "Windows 已拒绝位置权限。请在“设置 > 隐私和安全性 > 位置”中开启位置服务和桌面应用访问权限。" : "Windows 没有返回可用位置。请确认位置服务已开启，或继续使用手动地点。");
        return;
      }
    }
    if (!navigator.geolocation) { setError("当前桌面环境没有提供系统定位接口，请手动填写地点。"); return; }
    setLocating(true); setError(null);
    try {
      const permissions = navigator.permissions?.query ? await navigator.permissions.query({ name: "geolocation" as PermissionName }) : null;
      if (permissions?.state === "denied") { setLocating(false); setError("系统已拒绝本机定位权限。请在 Windows 的位置权限中允许此应用，或直接填写地点。"); return; }
    } catch { /* 某些桌面 WebView 不实现 Permissions API，继续尝试定位。 */ }
    navigator.geolocation.getCurrentPosition(
      (position) => { setLocating(false); void recordWeather({ latitude: position.coords.latitude, longitude: position.coords.longitude }); },
      (reason) => { setLocating(false); const detail = reason.code === 1 ? "系统拒绝了定位权限" : reason.code === 2 ? "系统没有返回可用位置" : "读取位置超时"; setError(`${detail}。请在 Windows 位置权限中允许此应用，或继续使用手动地点。`); },
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 300000 }
    );
  }
  function returnToReviewInput() { reviewInputRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }); window.setTimeout(() => reviewInputRef.current?.focus({ preventScroll: true }), 420); }
  const displayedTaskSummaries = taskSummaries.slice(0, taskSummaryExpanded ? 4 : 2);
  return <section className="page review-page" aria-labelledby="review-title">
    <div className="review-heading"><div><p className="eyebrow">一天将要落幕</p><h1 id="review-title">把今天还给自己。</h1><p>完成与感受可以同时成立，不需要互相证明。</p></div><div className="review-count"><strong>{userMessages.length}</strong><span>条我的复盘</span></div></div>
    <section className="review-colophon" aria-label="今日题记"><div className="review-colophon-heading"><p className="section-kicker">今日回看</p><time dateTime={review?.localDate ?? localDate()}>{reviewDateLabel(review?.localDate ?? localDate())}</time></div><div className="review-completion-mark"><strong>{chineseNumber(completed)}</strong><span>今日完成</span></div><dl className="review-colophon-metrics"><div><dt>计划</dt><dd>{plannedTaskCount}<small>项</small></dd></div><div><dt>专注</dt><dd>{effective}m</dd></div></dl></section>
    <div className="review-board">
      <div className="review-main-column">
        <section className="review-sheet" aria-labelledby="review-fragment-title"><header><div><p className="section-kicker">每日复盘</p><h2 id="review-fragment-title">留下今天的感受。</h2></div><span>{userMessages.length ? `已留下 ${userMessages.length} 笔` : "纸面尚空"}</span></header><div className="review-writing-field" aria-live="polite">{conversationMessages.length === 0 ? <div className="stream-empty"><MessageCircle /><p>第一句话，会在这里亮起。</p></div> : <div className="review-fragment-list">{conversationMessages.map((message, index) => <article className={message.source === "ai" ? "ai" : "app"} key={message.id}><span>{message.source === "ai" ? "AI 回应" : `第 ${chineseNumber(index + 1)} 笔`}</span><p>{message.content}</p></article>)}</div>}<textarea ref={reviewInputRef} aria-label="每日复盘" disabled={!isWorkspaceCurrent || !review} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="今天下午忽然觉得……" rows={userMessages.length ? 1 : 6} maxLength={2000} /></div><footer className="review-sheet-footer"><span>{draft.length}/2000</span><div className="review-composer-actions"><button className="primary-button review-save-button" disabled={!isWorkspaceCurrent || !draft.trim() || saving} onClick={() => void save()}><Check />保存</button></div></footer>{lastConversationMessage?.source === "app" && <button className="text-button review-reply-last" type="button" disabled={saving} onClick={() => void replyToLast()}><RefreshCw />{saving ? "正在等待 AI" : "请 AI 回应最近一条"}</button>}
          <div className="review-inline-ai"><button className="review-collapsible-heading" type="button" onClick={() => setConversationOpen((value) => !value)} aria-expanded={conversationOpen}><span><p className="section-kicker">同一张复盘纸面</p><h3 id="review-software-conversations-title">与 AI 的交流</h3></span><ChevronDown className={conversationOpen ? "open" : ""} /></button>{conversationOpen ? (softwareConversationTurns.length ? <div className="review-software-conversation-list">{softwareConversationTurns.map((turn, index) => <details key={turn.id}><summary><time>{new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(turn.askedAt))}</time><strong>问题 {index + 1} · {turn.question}</strong></summary><div className="review-software-conversation-turn"><p className="user"><b>我：</b>{turn.question}</p>{turn.replies.length ? turn.replies.map((reply) => <p className="assistant" key={reply.id}><b>AI：</b>{reply.content}</p>) : <p className="assistant pending"><b>AI：</b>这条问题还没有回复。</p>}</div></details>)}</div> : <div className="review-software-conversation-empty"><strong>今天尚未起笔</strong><small>AI 对话会按当天记录保存在这里</small><button className="review-empty-seal" type="button" onClick={returnToReviewInput} aria-label="回到复盘输入区"><span aria-hidden="true">待</span></button></div>) : <p className="review-collapsed-hint">默认收起，展开后可按具体问题回溯。</p>}</div>
        </section>
      </div>
      <aside className="review-side-column" aria-label="今日侧边信息">
        <section className="review-radar-archive" aria-labelledby="review-radar-title"><div className="review-radar-archive-heading"><div><p className="section-kicker">今日六维</p><h2 id="review-radar-title">把体验留成一张图。</h2></div><span>{radarSnapshot ? "已保存" : "尚未保存"}</span></div>{radarSnapshot ? <div className="review-radar-snapshot"><RadarChart compact values={radarSnapshot.radar} ariaLabel="今日六维回看快照" /><div className="review-radar-snapshot-copy"><strong>今日体验快照</strong><p>这张图来自你最后一次确认的六维评分，会固定保留在今天的复盘里。</p></div></div> : <p className="review-radar-empty">今天还没有保存六维体验。</p>}</section>
        <section className="review-location-panel" aria-labelledby="review-location-title"><div className="review-section-heading"><div><p className="section-kicker">今日地点及天气情况</p><h2 id="review-location-title">只在你主动点击时记录一次。</h2></div><MapPin /></div><div className="review-location-controls"><label><span>所在城市或行政区</span><input aria-label="所在城市或行政区" disabled={!isWorkspaceCurrent || !review || saving} value={locationName} onChange={(event) => setLocationName(event.target.value)} placeholder="例如：昆明" maxLength={120} /></label><div className="review-location-buttons"><button className="quiet-button" type="button" disabled={!isWorkspaceCurrent || !review || saving || !locationName.trim()} onClick={() => void recordWeather({ locationName: locationName.trim() })}><MapPin />记录手动地点</button><button className="quiet-button" type="button" disabled={!isWorkspaceCurrent || !review || saving || locating} onClick={() => void useDeviceLocation()}><LocateFixed />{locating ? "正在读取" : "读取本机位置"}</button></div></div>{weatherBrief?.content.location && !locationCoordinates(weatherBrief.content.location.name) && (() => { const weather = weatherBrief.content.weather; const presentation = weatherPresentation(weather?.weatherCode); const WeatherIcon = presentation.Icon; return <div className="review-weather-result"><div className="review-weather-main"><WeatherIcon aria-hidden="true" /><div><strong>{weather ? `${weather.temperatureCelsius}°` : "--"}</strong><span>{presentation.label}</span></div></div><div className="review-weather-meta"><time>{weatherDateLabel(weather?.observedAt)}</time><p>{weatherBrief.content.location.name}</p><small>{weather ? `体感 ${weather.apparentTemperatureCelsius}°C` : "天气暂不可用"}</small></div></div>; })()}</section>
      </aside>
    </div>
    <section className="review-task-summary" aria-labelledby="review-task-summary-title"><div className="review-section-heading"><div><p className="section-kicker">任务复盘</p><h2 id="review-task-summary-title">今天发生了什么</h2></div><span>{taskSummaries.length} 项任务</span></div>{taskSummaries.length ? <><div className={`review-task-summary-list ${taskSummaryExpanded ? "expanded" : ""}`}>{displayedTaskSummaries.map((task) => <article key={task.id}><div><strong>{task.title}</strong><small>{timeLabel(task.startAt)} – {timeLabel(task.endAt)}</small></div><p><b>做了什么：</b>{task.title}<br /><b>完成情况：</b>{outcomeLabel(task.outcome?.outcome ?? task.currentOutcome ?? (task.startedWithinWindow ? "complete" : null), task.outcome?.progressPercent)} · 有效专注 {Math.round(task.focusSeconds / 60)} 分钟<br /><b>最后反馈：</b>{satisfactionLabel(task.feedback?.satisfaction)}</p></article>)}</div>{taskSummaries.length > 2 && <button className="review-task-summary-toggle" type="button" aria-expanded={taskSummaryExpanded} onClick={() => setTaskSummaryExpanded((value) => !value)}>{taskSummaryExpanded ? "收起任务" : "展开查看最多 4 项"}<ChevronDown className={taskSummaryExpanded ? "open" : ""} /></button>}</> : <p className="review-radar-empty">今天还没有可复盘的正式任务。</p>}</section>
    {error && <div className="focus-error" role="alert">{error}</div>}
  </section>;
}
