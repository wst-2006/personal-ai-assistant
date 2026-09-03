import { useEffect, useRef, type KeyboardEvent } from "react";
import {
  progressForOutcome,
  type FocusOutcome,
  type FocusSatisfaction,
} from "./FocusEvaluationForm";

type CyberFocusEvaluationProps = {
  taskTitle: string;
  outcome: FocusOutcome;
  progress: string;
  satisfaction: FocusSatisfaction;
  note: string;
  busy: boolean;
  error: string | null;
  onOutcomeChange: (value: FocusOutcome) => void;
  onProgressChange: (value: string) => void;
  onSatisfactionChange: (value: FocusSatisfaction) => void;
  onNoteChange: (value: string) => void;
  onSubmit: () => void;
  showNote?: boolean;
};

const outcomeOptions: Array<{ value: FocusOutcome; label: string }> = [
  { value: "complete", label: "完成" },
  { value: "partial", label: "部分完成" },
  { value: "not_completed", label: "未完成" },
];

const satisfactionOptions: Array<{ value: FocusSatisfaction; label: string }> = [
  { value: "satisfied", label: "满意" },
  { value: "neutral", label: "一般" },
  { value: "dissatisfied", label: "不满意" },
];

function nextOption<T extends string>(options: Array<{ value: T }>, current: T, direction: 1 | -1) {
  const index = options.findIndex((option) => option.value === current);
  return options[(index + direction + options.length) % options.length]!.value;
}

export function CyberFocusEvaluation(props: CyberFocusEvaluationProps) {
  const objectiveRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLInputElement>(null);
  const feelingRef = useRef<HTMLDivElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    objectiveRef.current?.focus();
  }, []);

  function handleObjectiveKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      event.preventDefault();
      props.onOutcomeChange(nextOption(outcomeOptions, props.outcome, 1));
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault();
      props.onOutcomeChange(nextOption(outcomeOptions, props.outcome, -1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (props.outcome === "partial") progressRef.current?.focus();
      else feelingRef.current?.focus();
    }
  }

  function handleFeelingKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      event.preventDefault();
      props.onSatisfactionChange(nextOption(satisfactionOptions, props.satisfaction, 1));
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault();
      props.onSatisfactionChange(nextOption(satisfactionOptions, props.satisfaction, -1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      noteRef.current?.focus();
    }
  }

  return <section className="cyber-evaluation" aria-labelledby="cyber-evaluation-title">
    <p className="cyber-copyright">Personal AI Assistant [Version 0.1]</p>
    <p className="cyber-prompt">PS C:\Focus\review&gt; evaluate --latest</p>
    <h1 id="cyber-evaluation-title">{props.taskTitle}</h1>

    <div className="cyber-command-group" ref={objectiveRef} tabIndex={0} role="listbox" aria-label="客观完成情况" onKeyDown={handleObjectiveKey}>
      <p>[?] 这一段完成得怎样？</p>
      {outcomeOptions.map((option, index) => <button
        type="button"
        role="option"
        aria-selected={props.outcome === option.value}
        className={props.outcome === option.value ? "selected" : ""}
        key={option.value}
        onClick={() => props.onOutcomeChange(option.value)}
      ><span>{props.outcome === option.value ? ">" : " "}</span>[{index + 1}] {option.label}</button>)}
    </div>

    {props.outcome === "partial" && <label className="cyber-progress-input">
      <span>PS C:\Focus\review&gt; progress --percent</span>
      <input
        ref={progressRef}
        aria-label="实际完成进度"
        type="number"
        min="1"
        max="99"
        value={props.progress}
        onChange={(event) => props.onProgressChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            feelingRef.current?.focus();
          }
        }}
      />%
    </label>}

    <div className="cyber-command-group" ref={feelingRef} tabIndex={0} role="listbox" aria-label="主观感受" onKeyDown={handleFeelingKey}>
      <p>[?] 专注之后的声音？</p>
      {satisfactionOptions.map((option, index) => <button
        type="button"
        role="option"
        aria-selected={props.satisfaction === option.value}
        className={`satisfaction-${option.value} ${props.satisfaction === option.value ? "selected" : ""}`}
        key={option.value}
        onClick={() => props.onSatisfactionChange(option.value)}
      ><span>{props.satisfaction === option.value ? ">" : " "}</span>[{index + 1}] {option.label}</button>)}
    </div>

    {props.showNote !== false ? <label className="cyber-note-input">
      <span className="cyber-prompt">PS C:\Focus\review&gt; note --optional</span>
      <textarea
        ref={noteRef}
        aria-label="专注过程与原因"
        value={props.note}
        onChange={(event) => props.onNoteChange(event.target.value)}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
            event.preventDefault();
            props.onSubmit();
          }
        }}
        rows={3}
        maxLength={4000}
        placeholder="输入原因；可留空。Ctrl + Enter 保存"
      />
    </label> : null}

    <p className={`cyber-evaluation-status ${props.error ? "error" : ""}`} role={props.error ? "alert" : "status"}>
      {props.error ?? `OUTCOME=${props.outcome.toUpperCase()}  PROGRESS=${props.outcome === "partial" ? props.progress : progressForOutcome(props.outcome)}%`}
    </p>
    <button className="cyber-submit" type="button" disabled={props.busy} onClick={props.onSubmit}>
      {props.busy ? "EXECUTING..." : "[ ENTER ] SAVE_RESULT"}
    </button>
    <p className="cyber-key-help">↑ / ↓ 选择 · Enter 下一项 · Ctrl + Enter 保存</p>
  </section>;
}
