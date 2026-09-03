import { Check, CheckCircle2, CircleDashed, XCircle } from "lucide-react";

export type FocusOutcome = "not_completed" | "partial" | "complete";
export type FocusSatisfaction = "satisfied" | "neutral" | "dissatisfied";

export type FocusEvaluationValue = {
  outcome: FocusOutcome;
  progress: string;
  satisfaction: FocusSatisfaction;
  note: string;
};

type FocusEvaluationFormProps = FocusEvaluationValue & {
  taskTitle: string;
  busy?: boolean;
  error?: string | null;
  headingId: string;
  onOutcomeChange: (value: FocusOutcome) => void;
  onProgressChange: (value: string) => void;
  onSatisfactionChange: (value: FocusSatisfaction) => void;
  onNoteChange: (value: string) => void;
  onSubmit: () => void;
  showNote?: boolean;
};

const outcomes: Array<{ value: FocusOutcome; label: string; icon: typeof CheckCircle2 }> = [
  { value: "complete", label: "完成", icon: CheckCircle2 },
  { value: "partial", label: "部分完成", icon: CircleDashed },
  { value: "not_completed", label: "未完成", icon: XCircle },
];

const feelings: Array<{ value: FocusSatisfaction; label: string; hint: string }> = [
  { value: "satisfied", label: "满意", hint: "过程与结果都合意" },
  { value: "neutral", label: "一般", hint: "有所得，也有阻滞" },
  { value: "dissatisfied", label: "不满意", hint: "需要回看原因" },
];

export function progressForOutcome(value: FocusOutcome): string {
  return value === "complete" ? "100" : value === "not_completed" ? "0" : "50";
}

export function validFocusEvaluation(outcome: FocusOutcome, progress: string): boolean {
  const value = Number(progress);
  return outcome === "complete"
    ? value === 100
    : outcome === "not_completed"
      ? value === 0
      : Number.isInteger(value) && value >= 1 && value <= 99;
}

export function FocusEvaluationForm({
  taskTitle,
  outcome,
  progress,
  satisfaction,
  note,
  busy = false,
  error,
  headingId,
  onOutcomeChange,
  onProgressChange,
  onSatisfactionChange,
  onNoteChange,
  onSubmit,
  showNote = true,
}: FocusEvaluationFormProps) {
  return (
    <section className="focus-evaluation-sheet" aria-labelledby={headingId}>
      <header className="focus-evaluation-heading">
        <p>专注已结束</p>
        <h1 id={headingId}>为这一段留下真实记录</h1>
        <strong title={taskTitle}>{taskTitle}</strong>
      </header>

      <fieldset className="focus-evaluation-section focus-evaluation-objective">
        <legend><span>01</span>客观完成情况</legend>
        <div className="focus-evaluation-outcomes">
          {outcomes.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              type="button"
              className={outcome === value ? "selected" : ""}
              aria-pressed={outcome === value}
              onClick={() => onOutcomeChange(value)}
            >
              <Icon />
              {label}
            </button>
          ))}
        </div>
        {outcome === "partial" && (
          <label className="focus-evaluation-progress">
            <span>实际完成进度</span>
            <input
              type="number"
              min="1"
              max="99"
              inputMode="numeric"
              value={progress}
              onChange={(event) => onProgressChange(event.target.value)}
            />
            <em>%</em>
          </label>
        )}
      </fieldset>

      <fieldset className="focus-evaluation-section focus-evaluation-subjective">
        <legend><span>02</span>这次专注的感受</legend>
        <div className="focus-evaluation-feelings">
          {feelings.map(({ value, label, hint }) => (
            <button
              key={value}
              type="button"
              className={`feeling-${value} ${satisfaction === value ? "selected" : ""}`}
              aria-pressed={satisfaction === value}
              onClick={() => onSatisfactionChange(value)}
            >
              <strong>{label}</strong>
              <small>{hint}</small>
            </button>
          ))}
        </div>
      </fieldset>

      {showNote ? <label className="focus-evaluation-note">
        <span><b>03</b>过程与原因 <em>选填</em></span>
        <textarea
          aria-label="专注过程与原因"
          placeholder="哪里做得好，哪里受阻，或者只留下一句话……"
          value={note}
          onChange={(event) => onNoteChange(event.target.value)}
          rows={4}
          maxLength={4000}
        />
      </label> : null}

      <footer className="focus-evaluation-footer">
        <p role={error ? "alert" : undefined}>{error ?? "完成情况和主观感受会分别保存。"}</p>
        <button type="button" disabled={busy} onClick={onSubmit}>
          <Check />
          {busy ? "正在保存" : "保存本次专注"}
        </button>
      </footer>
    </section>
  );
}
