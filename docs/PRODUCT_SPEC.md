# Product Specification

## Purpose

The product is a single-user personal task manager and learning companion. The
user enters goals, formally scheduled tasks, completion status, notes, and
review thoughts. AI organizes natural-language input, identifies obvious
conflicts, offers optional adjustments, recommends focus structures, and
creates search-backed daily briefs when explicitly requested.

## Non-negotiable Behavior

- The user confirms natural-language task extraction before it is stored.
- Form entries that are already complete do not call AI.
- A live formal task stores only its title, schedule/date/time, and optional
  notes. Exact duration is derived from `startAt` and `endAt`; retired effort,
  difficulty, task-type, and continuous-focus metadata are rejected by the
  task API and form. Historical values remain in a legacy archive only.
- Tasks, ideas, and questions are distinct entry types.
- A dated formal task with `scheduleKind = none` follows the user's explicit
  persisted day-end preference. The default and current preference is to carry
  it to the following day. The alternative removes it from active views by
  soft deletion so it remains recoverable from the recycle bin. Only `open`,
  undeleted, formal tasks are eligible; backfills, daypart/exact tasks, closed
  or cancelled tasks, ideas, questions, and inbox entries are never touched.
- Deleted tasks remain recoverable for the user's persisted recycle-retention
  window, which defaults to three days and may be set from 1 to 30 days. The
  local Worker permanently removes expired task records and their dependent
  focus/reminder/history rows in one transaction; a partial purge is forbidden.
  The user may also explicitly empty the recycle bin from the app after a
  confirmation; this permanently purges all currently deleted tasks and the
  same dependent rows immediately.
- Day-end processing is performed by the local Worker after the Shanghai date
  changes. Each local date is claimed once in a durable ledger, making retries
  and application restarts idempotent. Carry-forward increments both task
  version counters because the visible target date changes; automatic deletion
  follows the ordinary soft-delete version contract.
- AI may advise on conflicts and changes but never changes a confirmed plan
  without an explicit user decision.
- A plan-change consultation may return transient schedule candidates only for
  existing `open` tasks. Each candidate is bound to the task `version` and
  `scheduleRevision`; selecting it merely opens the normal editable task form.
  A stale candidate is rejected, and only the user's final save through the
  versioned task/conflict API changes the database.
- The application database is the authoritative task and schedule source.
  External calendars may remind, synchronize, or import but do not override it.
- Exact overlapping formal tasks are rejected and never moved automatically.
  The user must adjust one interval before saving. Tasks without exact times are excluded.
- Phase 1 exact tasks cannot cross midnight. Timestamps are stored in UTC with
  an IANA time zone; the default is `Asia/Shanghai`.
- Task outcome and subjective satisfaction are independent records.
- Task outcomes are append-only; reopening clears only the current result.
- An ended focus session contributes its actually executed focus time
  immediately, before task evaluation. Objective outcome and subjective
  satisfaction never erase or retroactively reduce recorded focus time.
  Structured sessions count only executed focus segments; breaks remain
  excluded. Legacy ended/evaluated sessions without a populated effective
  value fall back to their recorded active seconds.
- Every eligible exact task enters a one-minute desktop preparation surface at
  `startAt - 1 minute`. Preparation, a persisted schedule, and reminder delivery
  never count as execution by themselves. The task produces focus time only
  after the user explicitly chooses `Start task` in the desktop or Feishu card,
  or explicitly tells the Feishu AI that the task has started.
- A start confirmation during the one-minute preparation arms the task to begin
  at its fixed `startAt`. If no confirmation exists at `startAt`, the session
  enters a temporary `awaiting_late_start` state rather than running or closing.
  It may still start from the actual confirmation time while a focus segment
  remains inside the original interval. The fixed task end is never extended.
- A new focus session may be created only for an `open`, formal task with
  `scheduleKind = exact` and persisted `startAt`/`endAt`. Unscheduled and
  daypart tasks stay outside the focus picker until the user drags them into
  the timeline or confirms exact times through the full form. A previously
  persisted current session remains recoverable even if it predates this rule.
- A formally started focus session cannot be paused, cancelled, deleted,
  rescheduled, or ended early. Closing the companion hides it while the fixed
  schedule and background accounting continue. Beginning preparation locks the
  current task's confirmed focus structure when one exists. Unrelated tasks and
  pending evaluations remain independent.
- The focus room uses a restrained ink-clepsydra presentation with one large
  remaining-time value and a growing ink stroke. Minute-tick, first focus start,
  break start, break end, and final task end sounds are distinct, independently
  user-controlled and persisted. Sound is generated and played locally; focus
  state transitions remain authoritative even when audio is muted or blocked.
  With no selected task or after returning from a completed session, the stroke
  resets to its left-hand origin instead of retaining the previous session's
  completed progress.
- The Today task list presents scheduled and unscheduled work as separate
  paper-like sections. Only an `open`, formal, unscheduled task is draggable
  into the timeline; scheduled tasks and factual backfills remain read-only in
  this placement interaction.
- Review reports the number of planned formal tasks as an item count, not as a
  sum of scheduled minutes. Growth uses the current day's closed/planned task
  ratio for its bamboo scene: shoots below 33%, shoots with short bamboo from
  33% up to 66%, and the full bamboo grove from 66% upward. The shoots stage is
  still; the latter two retain restrained pointer-wind motion. The visible
  current-day task count and growth percentage use that same ratio; focus
  minutes never masquerade as the bamboo's task-completion percentage.
- Focus configuration and focus execution are separate surfaces. Before start,
  a valid structure draft can be confirmed in one action; the client performs
  candidate creation and confirmation without forcing a separate temporary-save
  click. The AI planner remains collapsed until requested. During preparation,
  awaiting-late-start or running, the editor and task picker collapse; the countdown remains
  dominant, with task, phase end, next phase and essential controls only. The
  full arrangement is disclosed on request, and viewing it is separate from
  the explicit change-arrangement path.
- The Tauri desktop runtime owns a real frameless focus companion window and a
  real Windows tray menu. Both read the same persisted focus snapshot as the
  main window. The companion remembers and clamps its physical position across
  monitor/DPI changes, has its own taskbar entry, can be minimized, hidden,
  locked or placed always-on-top, and does not own a second timer. Closing the
  companion hides it without ending focus; the taskbar or tray can restore it.
  When automatic display is enabled, a newly preparing or running session opens
  the companion at the visible lower-right work area. Pin and position-lock
  controls live in the title bar; the timer footer contains only named execution
  actions. When the persisted session enters `ended`, the companion always
  restores and expands into a dedicated evaluation surface instead of retaining
  the timer composition. Objective outcome/progress and subjective satisfaction
  remain separate inputs; optional process notes are never converted into a
  diary. Saving returns to the main application and hides the evaluation window.
  Notifications are limited to focus start, phase changes and completion.
- Every task reserves a final rest: 30 minutes defaults to 25 minutes focus plus
  5 minutes rest; 60 minutes defaults to 55 plus 5; 90 minutes defaults to 80
  plus 10; 120 minutes and longer cap the final rest at 15 minutes. Segmented
  plans give every focus segment the same rest it would receive as an
  independent task, must exactly fill the fixed interval, and permit skipping
  only the final rest of the whole task.
- Late starts resume at the current clock position inside the confirmed
  structure. Earlier segments are recorded as skipped; elapsed time is not
  fabricated, compressed, or rearranged. The final rest may be explicitly
  skipped and recorded.
- Exact tasks maintain durable T-15, T-1, T0 and fixed-end reminder transitions.
  T-15 sends one Feishu card with only `Other arrangement` and the two-step
  `Cancel task` action. T-1 updates that same card to add `Start task`. T0
  disables the unpressed start control and marks the session as awaiting a late
  explicit start. A successful on-time or late start disables every action on
  the original card and displays `Task already started`. If the fixed end is
  reached without a start, the Worker records one system `not_completed`
  outcome, closes the task, and does not create subjective feedback or an
  evaluation surface.
- At T-1, both the desktop companion and the existing Feishu card expose the
  explicit start confirmation. They are two views over one persisted focus
  session: confirming in either place is sufficient, the desktop reflects a
  Feishu confirmation on its next refresh, and a desktop confirmation queues an
  immediate replacement of the original Feishu card with `Task already started`.
- The T-1 desktop preparation countdown and the running focus timer are distinct
  native-window lifecycles. When an explicitly confirmed session reaches its
  fixed start, or a late start is explicitly confirmed, the preparation window
  is destroyed and a new running window is created, positioned and focused in
  the configured corner. An unconfirmed session never creates that running
  window merely because the preparation countdown reached zero.
- `Other arrangement` removes the task from the exact timeline and returns it
  to the unscheduled task list. `Cancel task` requires a second confirmation.
  Each terminal card action updates the original Feishu card so repeated taps
  cannot repeat the command.
- Feishu task intake remains a confirmation workflow. When an otherwise exact
  task specifies a start but not a duration/end, the AI asks `准备做多久` and
  waits for the answer before generating the confirmation card. No task is
  written while the duration remains unknown.
- A review session may be saved without a brief. A cyber diary requires a
  review message and references both its review session and a confirmed brief.
- The review page is an explicit `daily_review` context. The user can save a
  private review fragment without calling AI or explicitly ask AI to respond.
  User and AI turns are persisted separately; AI receives bounded same-day
  tasks, outcomes, focus, feedback, related in-app conversation, and review
  history. A failed provider call never removes the saved user fragment and
  can be retried. Only a user-authored review message unlocks brief and diary
  prerequisites; a client cannot submit a forged AI review message.
- Normal conversations do not expose standalone-brief generation.
- External daily-brief subscriptions, web search, and Work Buddy/forwarded-
  message import are disabled in the published build. They must not call
  Tavily, Brave, GDELT, RSS/Atom feeds, or a Work Buddy sender.
- The existing review-to-diary path remains local to the user's bounded review
  and task material so disabling external briefs does not break review, diary,
  task, focus, health, or Feishu task-intake behavior.
- A cyber diary uses the six confirmed dimensions: mainline progress, overall
  execution, focus quality, energy state, wellbeing maintenance, and growth
  gained. The first three are prefilled from persisted task/outcome/focus/
  feedback records but remain user-editable. The latter three stay explicitly
  unrated until the user chooses values; the system and AI do not invent them.
  The final user-controlled values are saved with the diary and restored after
  refresh. Daily and monthly state colors derive from the real satisfied,
  neutral, and dissatisfied feedback mix: green for predominantly satisfied,
  yellow for mixed/neutral, red for predominantly dissatisfied, and grey when
  no subjective feedback exists.
- Weekly health references are separate from tasks, focus, outcomes, points,
  and growth. The user maintains the health profile; template, AI, manual, and
  sleep-based changes remain versioned candidates until explicit confirmation.
- The Health page owns a dedicated, week-scoped AI collaboration ledger. A
  user message is persisted before the provider reply begins, remains visible
  if the provider fails, and can be retried without duplicating the original
  message. Health collaboration never enters ordinary conversation, review,
  brief or diary records. Opening the Health page never calls the planning
  model automatically; candidate generation requires an explicit user action.
- Health AI work exposes visible saved, replying, generating, extended-wait,
  validated and failed states. Concurrent repeated reply or candidate requests
  share one in-flight provider call, so repeated clicks cannot silently create
  parallel token-consuming generations. Timeout, invalid structured output and
  provider failure remain distinct recoverable errors and never persist a
  partial candidate.
- When Feishu credentials are configured, an AI clarification originating in
  the Health page is mirrored to the single user's Feishu account. Replies with
  the explicit `健康：` prefix are stored in the current Shanghai health week
  and routed back to the health responder before task intake, so they cannot be
  misclassified as tasks. The Health page remains the primary and complete
  interface when Feishu is unavailable.
- The Health page uses a "weekly note + daily reference" hierarchy. A newly
  generated AI candidate must provide conservative target ranges for protein,
  carbohydrate, fat, fibre and hydration; optional, executable hydration timing
  guidance; a reference macro ratio; concrete
  meal examples, protein rotation, substitute foods, movement focus and short
  safety notes. These are optional references, never measured intake,
  completion progress, medical prescriptions, forced tracking or automatic
  tasks. Older stored references without the richer fields remain readable and
  visibly report that the field was not provided instead of inventing values.
- The manual health editor exposes the same richer fields but keeps each richer
  group optional for backward compatibility. Saving creates or updates only a
  versioned candidate; the active week changes only after explicit confirmation.
- The Today page reads only the confirmed health reference for that date. Food
  and movement question buttons open a prefilled ordinary conversation without
  sending it or modifying the plan. Converting a movement reference opens a
  new exact-task form with blank start/end fields; no task is written until the
  user confirms those times, and the original health reference remains intact.
- A health candidate is bound to the profile version and, when revising an
  active week, to that active plan ID/version. A stale candidate cannot replace
  newer profile or plan data. Sleep screenshot analysis is opt-in and reports
  an explicit unavailable state when no verified vision model is configured.
  It uses an independent replaceable vision adapter and receives only the
  user-selected date, file metadata and uploaded screenshot. Personal profile
  and AI collaboration guidance are excluded from screenshot extraction.
- The product does not monitor user behavior, mood, camera, microphone, or
  external AI history. It does not perform personality analysis.

## Scope

First release: task creation, daily timeline and conflict warnings, focus
sessions, review mode, brief and diary workflow, search/weather adapters,
export, basic trends, a user-controlled weekly health reference, and an
optional local Worker for focus/reminders and dated unscheduled-task day-end
handling while the computer is running. Cloud
deployment, remote access, and cloud-backed reminders are explicitly deferred.
File parsing, Huawei Calendar integration, native Android work, and advanced
game visuals remain future work.

Initial Feishu controls are staged reminder delivery, start confirmation at
T-1, other arrangement, and two-step cancellation. Complex editing and full
review remain in the application. AI-created long-range task trees require explicit confirmation.
The growth garden remains basic data-driven feedback in Phase 1.

The Today timeline offers two views over the same 07:00-23:00 schedule: three
  vertically stacked folio sheets (07:00-12:00, 12:00-18:00 and 18:00-23:00)
  and one combined long timeline. The sheet nearest the computer's current
  Shanghai time is brought to the front by default; selecting any visible
  daypart tab brings that sheet directly to the front without first closing the
  current sheet. Only the front sheet mounts the interactive grid. Both views preserve drag-only
creation, origin-return cancellation, backfill rules and conflict handling.
The current-time marker is driven by a minute-aligned local clock while the
page remains open; clicks, focus changes and task interactions are not its
primary update mechanism.

Month, semester and annual long-range plans allow at most three stored plans
per scope, including archived plans. A plan may be permanently deleted without
deleting tasks previously created from its confirmed task-tree candidate; those
tasks simply lose the source-plan link. The user's free-form planning statement
is a real AI collaboration input: DeepSeek may return a visible title,
description and milestone candidate, but the draft changes only after the user
applies it and is still editable before saving.
