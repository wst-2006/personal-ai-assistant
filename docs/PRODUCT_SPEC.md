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
- AI may advise on conflicts and changes but never changes a confirmed plan
  without an explicit user decision.
- A plan-change consultation may return transient schedule candidates only for
  existing `open` tasks. Each candidate is bound to the task `version` and
  `scheduleRevision`; selecting it merely opens the normal editable task form.
  A stale candidate is rejected, and only the user's final save through the
  versioned task/conflict API changes the database.
- The application database is the authoritative task and schedule source.
  External calendars may remind, synchronize, or import but do not override it.
- Exact overlapping tasks are reported and never moved automatically. The user
  may explicitly retain the overlap. Tasks without exact times are excluded.
- Phase 1 exact tasks cannot cross midnight. Timestamps are stored in UTC with
  an IANA time zone; the default is `Asia/Shanghai`.
- Task outcome and subjective satisfaction are independent records.
- Task outcomes are append-only; reopening clears only the current result.
- Only partial and complete outcomes contribute effective focus time.
- A future exact task that the user confirms for focus waits in `scheduled`;
  at `startAt` it enters a one-minute preparation countdown and then starts
  automatically. The countdown may be skipped manually. The fixed task end is
  never extended.
- Current focus sessions do not support pause or manual restart. Historical
  pause fields remain compatibility data only. Beginning preparation locks the
  current task's confirmed focus structure, while unrelated tasks remain
  editable.
- During reminder, scheduling, preparation, and active focus, the interface may
  show one quiet method hint and one brief encouragement. These are selected
  locally from explicit task-title keywords with a general fallback; they do
  not call AI, infer mood or personality, open popups, alter the plan, or
  interrupt the timer. Rest segments do not show work-method prompts.
- A 30-minute task is one continuous 30-minute focus segment. A 60-minute
  continuous task defaults to 55 minutes of focus plus a 5-minute final rest.
  Longer continuous tasks also reserve a final 5-15 minute user-configurable
  rest. Segmented plans give every focus segment its own independently
  adjustable 5-15 minute rest and must exactly fill the fixed task interval.
- Late starts resume at the current clock position inside the confirmed
  structure. Earlier segments are recorded as skipped; elapsed time is not
  fabricated, compressed, or rearranged. The final rest may be explicitly
  skipped and recorded.
- Exact tasks maintain a 15-minute reminder and a durable five-minute
  non-response follow-up. An explicit start or other-arrangement response
  cancels the follow-up. Without a response, the local Worker records one
  system `not_completed` outcome and closes the task even when the main window
  is hidden, provided the desktop runtime is still running.
- A review session may be saved without a brief. A cyber diary requires a
  review message and references both its review session and a confirmed brief.
- The review page is an explicit `daily_review` context. The user can save a
  private review fragment without calling AI or explicitly ask AI to respond.
  User and AI turns are persisted separately; AI receives bounded same-day
  tasks, outcomes, focus, feedback, related in-app conversation, and review
  history. A failed provider call never removes the saved user fragment and
  can be retried. Only a user-authored review message unlocks brief and diary
  prerequisites; a client cannot submit a forged AI review message.
- A normal conversation may generate a brief only when explicitly requested;
  it never generates a cyber diary by itself.
- Daily-brief generation is server-side and uses the configured DeepSeek model
  to edit bounded review/task context together with retrieved search results.
  The fixed sections are finance, AI, big-data/technology, task-related
  expansion, history/humanities/society, and a short encouragement, followed
  by optional location/weather data. Search URLs and provider metadata remain
  attached to the saved brief. If the model cannot return valid structured
  content, the API returns a recoverable error and does not persist an
  incomplete brief as if generation succeeded.
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
- The Today page reads only the confirmed health reference for that date. Food
  and movement question buttons open a prefilled ordinary conversation without
  sending it or modifying the plan. Converting a movement reference opens a
  new exact-task form with blank start/end fields; no task is written until the
  user confirms those times, and the original health reference remains intact.
- A health candidate is bound to the profile version and, when revising an
  active week, to that active plan ID/version. A stale candidate cannot replace
  newer profile or plan data. Sleep screenshot analysis is opt-in and reports
  an explicit unavailable state when no verified vision model is configured.
- The product does not monitor user behavior, mood, camera, microphone, or
  external AI history. It does not perform personality analysis.

## Scope

First release: task creation, daily timeline and conflict warnings, focus
sessions, review mode, brief and diary workflow, search/weather adapters,
export, basic trends, a user-controlled weekly health reference, and an
optional local Feishu reminder worker while the computer is running. Cloud
deployment, remote access, and cloud-backed reminders are explicitly deferred.
File parsing, Huawei Calendar integration, native Android work, and advanced
game visuals remain future work.

Initial Feishu controls are reminder delivery, start, other arrangement, and
opening the corresponding task. Complex editing and full review remain in the
application. AI-created long-range task trees require explicit confirmation.
The growth garden remains basic data-driven feedback in Phase 1.
