import { useCallback, useEffect, useState } from "react";
import { ArrowRight, Check, Download, Leaf, NotebookPen, Sparkles } from "lucide-react";

type Brief = { id: string; content: { title: string; reflection: string; taskSummary: string } };
type Review = { id: string; localDate: string };
type Diary = { id: string; localDate: string; reviewSessionId: string; briefId: string; content: { title: string; body: string } };
type DiaryRead = { diary: Diary | null; review: Review | null; confirmedBrief: Brief | null; hasReviewMessage: boolean };

const API = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3000";
const localDate = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const displayDate = () => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", weekday: "long", month: "long", day: "numeric" }).format(new Date());

async function request<T>(path: string, method = "GET", body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${API}${path}`, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  if (!response.ok) throw new Error((await response.json().catch(() => ({})) as { error?: string }).error ?? "diary_request_failed");
  return response.json() as Promise<T>;
}

function makeDraft(brief: Brief) {
  return `${brief.content.reflection}\n\n${brief.content.taskSummary}\n\n我把这一页留给明天的自己：继续向前，但不催促。`;
}

export function DiaryWorkspace({ onOpenReview }: { onOpenReview: () => void }) {
  const [data, setData] = useState<DiaryRead | null>(null);
  const [title, setTitle] = useState(displayDate());
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const result = await request<DiaryRead>(`/api/v1/diaries/${localDate()}`);
    setData(result);
    if (result.diary) { setTitle(result.diary.content.title); setBody(result.diary.content.body); }
  }, []);
  useEffect(() => { void load().catch(() => setError("无法读取赛博日记，请确认 API 正在运行。")); }, [load]);
  const ready = Boolean(data?.review && data.hasReviewMessage && data.confirmedBrief);
  function prepareDraft() {
    if (!data?.confirmedBrief) return;
    setTitle(data.diary?.content.title ?? displayDate());
    setBody(data.diary?.content.body ?? makeDraft(data.confirmedBrief));
  }
  async function save() {
    if (!data?.review || !data.confirmedBrief || !title.trim() || !body.trim()) return;
    setSaving(true); setError(null);
    try {
      const result = await request<{ diary: Diary }>(`/api/v1/diaries/${localDate()}`, "PUT", { reviewSessionId: data.review.id, briefId: data.confirmedBrief.id, content: { title: title.trim(), body: body.trim() } });
      setData((current) => current ? { ...current, diary: result.diary } : current);
    } catch (requestError) {
      setError(requestError instanceof Error && requestError.message === "confirmed_brief_required" ? "请先回到复盘页确认每日简报。" : "日记没有保存，请重试。");
    } finally { setSaving(false); }
  }
  function exportText() {
    if (!data?.diary) return;
    const file = new Blob([`${title}\n\n${body}\n`], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(file); const link = document.createElement("a");
    link.href = url; link.download = `${data.diary.localDate}-cyber-diary.txt`; link.click(); URL.revokeObjectURL(url);
  }
  return <section className="page diary-page" aria-labelledby="diary-title">
    <div className="diary-toolbar"><span /><div><p className="eyebrow">赛博日记</p><h1 id="diary-title">{displayDate()}</h1></div><button className="quiet-icon" type="button" aria-label="导出日记" disabled={!data?.diary} onClick={exportText}><Download /></button></div>
    {!data ? <div className="diary-lock"><NotebookPen /><h2>正在读取今天</h2></div> : !ready ? <div className="diary-lock"><NotebookPen /><h2>{!data.hasReviewMessage ? "先留下一条复盘" : "先确认每日简报"}</h2><p>{!data.hasReviewMessage ? "赛博日记从今天真实写下的一句话开始。" : "确认后的简报会成为这页日记可靠的素材。"}</p><button className="primary-button" type="button" onClick={onOpenReview}>去复盘 <ArrowRight /></button></div> : <div className="diary-sheet"><header><div className="diary-mood"><span /><span /><span className="active" /><span /><span /></div><p>{data.diary ? "已持久保存" : "今天的坐标"}</p><strong>{data.confirmedBrief?.content.title}</strong></header>{!body ? <div className="diary-ready"><Leaf /><h2>今天已经有材料了。</h2><p>把复盘与已确认简报整理成一页可以继续编辑的日记。</p><button className="primary-button" type="button" onClick={prepareDraft}><Sparkles />整理为草稿</button></div> : <><label className="diary-title-field"><span>标题</span><input aria-label="日记标题" value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} /></label><textarea className="diary-editor" aria-label="日记正文" value={body} onChange={(event) => setBody(event.target.value)} rows={11} maxLength={20_000} /><footer><span>{data.diary ? "已保存" : "草稿"}</span><button className="primary-button" type="button" disabled={saving || !title.trim() || !body.trim()} onClick={() => void save()}><Check />{saving ? "正在保存" : "保存日记"}</button></footer></>}</div>}
    {error && <div className="focus-error" role="alert">{error}</div>}
  </section>;
}
