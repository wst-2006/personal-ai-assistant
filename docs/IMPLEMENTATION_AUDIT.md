# Implementation Audit

Audit date: 2026-08-03
Audit scope: product specification, architecture, roadmap, state machines,
design review, repository rules, PostgreSQL schema, API routes, automated tests,
and the current desktop/mobile web implementation.

## 1. Audit Method

This audit does not treat a visible page, button, TypeScript type, or database
table as proof that a feature is complete. A feature is **fully implemented**
only when its confirmed product flow is connected to a real API, persisted in
PostgreSQL, restored after refresh, readable by another client, handles expected
errors, has proportionate automated tests, and complies with the product rules.

Implementation status and verification confidence are separate:

- **Fully implemented**: the complete confirmed flow meets the evidence bar.
- **Partially implemented**: a material working slice exists, but the confirmed
  flow or one of the persistence/error/testing requirements is incomplete.
- **UI prototype only**: visible interaction is driven by in-memory frontend
  state or fixed presentation data.
- **Not implemented**: no working product path exists.
- **Conflicts with requirements**: the current design or behavior contradicts a
  confirmed product rule.
- **High confidence**: confirmed directly from code plus relevant automated or
  database verification.
- **Medium confidence**: confirmed from code, but not through the complete real
  browser/database workflow.
- **Low confidence**: inferred from a prototype or incomplete evidence.

Primary requirement sources are `PRODUCT_SPEC.md`, `ARCHITECTURE.md`,
`ROADMAP.md`, `STATE_MACHINES.md`, `DESIGN_REVIEW.md`, `TASK_LIFECYCLE.md`, and
`AGENTS.md`. Current implementation evidence is primarily in
`packages/db/src/schema.ts`, `packages/domain/src/task.ts`,
`apps/api/src/task-*.ts`, and `apps/web/src/App.tsx`.

## 2. Executive Findings

The secure repository baseline and the backend task lifecycle/conflict slice
are real. Task creation, listing, editing, cancellation, reopening, soft
deletion, outcome closing, conflict reporting, and explicit conflict retention
use the Fastify API and PostgreSQL repository. The Today page now includes the
core manual form and a time-coordinate editor. These facts still do **not**
mean the usable core product is complete: persistent review/brief/diary flows
need broader browser acceptance, and growth capabilities remain. Cloud
deployment is explicitly deferred by the local-first execution decision.

The former `tasks.entry_type` conflict is resolved: formal tasks own lifecycle
and scheduling, while ideas/questions reside in `inbox_entries` until the user
explicitly converts one. That guarded migration is applied to the project
database and must be preserved in future schema work.

Focus, review, brief, diary and the basic growth path now use real API-backed
persistence. Review persistence and brief confirmation/edit/export now also
have a real PostgreSQL-backed browser acceptance path. Ordinary software
conversation now persists locally, restores after refresh, appears as a
separate review context, and never satisfies the review-message gate. The
richer diary and local reminder recovery requirements remain outstanding.

## 3. Functional Audit Matrix

| Capability | Requirement source | Status | Confidence | Current code / page | API / tables | Automated evidence | Missing work and next step |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Secure project/database baseline | Architecture, AGENTS | Fully implemented | High | `.gitignore`, DB guard/config | `personal_ai_assistant`, `personal_ai_app` | migration guard tests; `pnpm db:verify` | Keep the guard mandatory for every migration and E2E cleanup. |
| Task lifecycle and optimistic versioning | Product Spec, State Machines, Task Lifecycle | Partially implemented | High for backend and core browser paths | Today task actions and lifecycle service/repository | Task CRUD/action routes; `tasks`, lifecycle events, outcomes | service, route, repository, persistence and browser E2E tests | Expand visual acceptance for exceptional/recovery paths. |
| Append-only task outcomes and reopening | Product Spec, State Machines | Partially implemented | High for backend and core browser paths | Today outcome form, append-only result-history dialog, reopen actions and focus evaluation. The history reads every stored result with objective progress, source, note and time; reopening clears only the current result. | outcome and reopen routes; `task_outcomes` | outcome history and browser E2E tests | Add broader crash-recovery visual acceptance beyond the explicit `awaiting_outcome` state. |
| Exact-time conflict detection and retention | Product Spec, Task Lifecycle | Partially implemented | High for backend and browser core path | Spatial blocks, conflict prompt and explicit retention in Today | task create/update/accept APIs; `task_conflict_acceptances` | overlap, history, stale set, rollback and browser E2E tests | Add visual treatment for complex multi-lane conflict sets. |
| Full manual task creation | Product Spec, Roadmap | Partially implemented | High for mapped core fields and browser path | Dedicated formal-task dialog with title, schedule/date/time and notes; explicit form submit does not call AI | `POST /tasks`; `tasks` | API/domain and browser E2E tests | Add accessibility and error-state coverage for all schedule combinations. |
| Quick task capture | Product Spec, Design Review | Partially implemented | High for core path | Quick capture creates a title-only unscheduled task targeted to the selected date and can be completed later | `POST /tasks`; `tasks` | API and browser E2E coverage through Today | Add a distinct completion affordance in the unscheduled region. |
| Independent ideas/questions | Product Spec | Fully implemented | High for confirmed conversion and stale-version recovery | Idea/question capture writes separate inbox entries; conversion requires confirmation, creates a formal task only after submit, links `source_inbox_entry_id`, preserves the source with `converted_at`, and keeps the form when a stale version is rejected | inbox routes; `inbox_entries`, `tasks.source_inbox_entry_id` | API/domain tests and isolated PostgreSQL/browser conversion + stale-version E2E | Add broader conflict-error messaging only if future inbox editing introduces more concurrent mutations. |
| AI candidate confirmation and ordinary conversation | Product Spec, Design Review | Partially implemented | High for local persistence, explicit task confirmation, and live ordinary conversation; medium for provider failures and task-tree output | The AI drawer keeps ordinary user/assistant messages in one local daily conversation, restores them after refresh, and exposes them separately in review context. A separate explicit action parses an editable task, idea, or question candidate. The Planning workspace separately persists editable framework-level task-tree candidates. Neither candidate path creates a task before explicit confirmation. | `GET/POST /conversations`, `POST /ai/tasks/parse`, `POST /tasks`, `POST /inbox-entries`, task-tree candidate routes; `app_conversations`, `app_conversation_messages`, `tasks`, `inbox_entries`, `long_range_plan_task_tree_candidates` | conversation service/responder/review tests; real PostgreSQL/browser E2E sends a live DeepSeek reply, refreshes, reads it in review, and confirms the review-message gate; candidate edit + refresh and explicit confirmation E2E | Add explicit browser coverage for provider-unavailable and user-declined candidate conflict paths; run live task-tree structured output acceptance separately. |
| Real Today timeline | Product Spec, Design Review | Partially implemented | High for core schedule editing, keyboard movement and explicit conflict retention; medium for full interaction | 24-hour coordinate axis, current-time marker, daypart/unscheduled areas, creation, pointer drag/resize, keyboard move/resize and spatial overlaps. Conflict retention now uses an in-app alert dialog that names every current overlapping task, interval and status; it never silently moves a task. | task APIs; `tasks`, conflict acceptances | desktop and 390px browser E2E, including persisted keyboard movement/resize and accessible conflict confirmation | Add richer visual treatment for complex multi-lane conflict sets. |
| Timeline persistence and cross-client reading | Product Spec, Architecture | Partially implemented | High for refresh and local database read | Timeline reads the database-backed task list | task list API; `tasks` | DB persistence and browser refresh tests | Cross-device/cloud synchronization remains unimplemented. |
| Focus session workflow | Product Spec, State Machines, Roadmap | Partially implemented | High for persisted structure execution, local Worker recovery, local guidance and desktop/390px browser paths; medium for live external delivery | Future confirmation persists `scheduled`, task time enters a one-minute `preparing` countdown, preparation can be skipped manually, and timing then starts automatically without extending the fixed end. Confirmed continuous and segmented structures execute durably; 30 minutes has no rest, 60 minutes defaults to 55+5, every segmented focus has a 5-15 minute rest, and only the final rest can be explicitly skipped. Late starts continue at the original current segment, mark earlier segments skipped and record actual seconds. The current task structure locks from preparation onward while other tasks remain editable. Reminder, waiting, preparation and active-focus views show one stable, non-popup method hint and one brief encouragement derived locally from explicit title keywords or a general fallback; rest segments suppress work-method prompts and rendering never calls AI or modifies the plan. Exact tasks transactionally maintain a 15-minute reminder and a start+5-minute no-response follow-up; explicit start/other-arrangement cancels the follow-up, while the local Worker can create a stopped session, append one system `not_completed` outcome and close the task without the main window. Objective outcome and subjective satisfaction remain independent. | focus-session/structure routes, `POST /ai/plan-change-advisories`; `focus_sessions`, `focus_session_segment_runs`, `focus_timer_jobs`, `focus_structures`, `reminder_jobs`, `task_feedback`, `task_outcomes` | domain validation, dual reminder persistence verification, API/Worker tests, desktop and 390px browser E2E for skip-preparation, scheduled auto-preparation, structure execution, late-start history, final-rest skip, no-response recovery, stable local guidance, no-AI rendering and refresh | Live Feishu delivery still depends on the user's local credentials/network. Pause/resume and manual restart are intentionally excluded; remote delivery remains deferred. |
| Review session workflow | Product Spec, State Machines | Partially implemented | High for local PostgreSQL/browser persistence, explicit AI dialogue, prerequisite integrity and separated software conversation context; medium for live provider availability | Durable `daily_review` session, user/AI turn restore, real task/outcome/focus/feedback context, separate software conversation context and brief handoff. The user chooses between save-only and save-then-ask-AI. AI receives bounded same-day structured context, has no write authority, and provider failure leaves the user message saved with a retry action. Public input cannot forge `source: ai`; only a user-authored review row unlocks brief, diary, month-history and growth-review credit. | review routes and server-side review responder; `review_sessions`, `review_messages`, `app_conversations`, `app_conversation_messages` | domain/route/responder tests, guarded PostgreSQL context and failure-recovery tests, AI-only prerequisite tests, live desktop/390px review conversation E2E, existing review/brief persistence E2E | Live AI response still depends on configured DeepSeek credentials and network; broader alternate-provider acceptance remains. |
| Daily brief | Product Spec, Roadmap | Partially implemented | High for local review/standalone persistence and browser edit/confirm/export; medium for complete provider/location coverage | Review generates, edits, regenerates, confirms, exports and reloads a persisted brief with finance, AI, technology, task-expansion, humanities, weather and location sections. A normal conversation can now use a separate explicit AI-drawer action to create a confirmed standalone brief with `reviewSessionId = null`; it is listed, restored after refresh and exportable, and never qualifies for a cyber diary. Confirmed review content remains read-only until the user explicitly enters edit mode; edits persist through the brief API. | `brief-service.ts`, `brief-routes.ts`, `App.tsx`, `ReviewWorkspace.tsx`; `daily_briefs.content`, `daily_briefs.sources`, nullable `daily_briefs.review_session_id` | domain contract tests, API route tests, review and standalone PostgreSQL/browser E2E (including 390px), provider tests and build checks | Add opted-in device location and keep standalone briefs excluded from diary prerequisites. |
| Cyber diary | Product Spec, State Machines | Partially implemented | High for local persistence, editable six-dimensional review, month history, export and desktop/390px paths; medium for immutable final snapshots | API-backed month navigation, historical date selection, draft, explicit “确认并保存赛博日记”, reload, edit and text export. Saving requires a user-authored same-day review message and a confirmed linked brief. The six dimensions now match the confirmed model: mainline progress, overall execution and focus quality are database-prefilled but editable; energy state, wellbeing maintenance and growth gained remain visibly unrated until the user fills them. Final values are Domain-validated and saved in `cyber_diaries.content`; export includes them with focus/location/weather data. Green/yellow/red/grey daily state colors derive from real subjective feedback rather than focus minutes. The existing structured JSONB column already stores this content, so this correction requires no schema migration and does not use frontend-only state. | diary month/day routes, `diary-service.ts`, `DiaryWorkspace.tsx`; `cyber_diaries.content`, review/brief/task/focus/outcome/feedback tables | diary Domain validation, pure day-signal tests, guarded PostgreSQL growth aggregation and browser E2E for edit/save/reload/export/390px | Decide whether task/focus/weather portions of a finalized export need a separate immutable snapshot rather than authoritative live derivation. |
| Growth and statistics | Product Spec, Roadmap, Design Review | Partially implemented | High for seven-day/thirty-day database-derived paths and saved diary ratings; low for long-term trends | Real focus trends, subjective feedback counts, green/yellow/red/grey daily state grids, the confirmed six dimensions, points and tree feedback. Period radar values combine database-prefilled system dimensions with only the days where the user actually saved manual diary ratings; missing manual ratings remain “未填”. Tree quality uses actual progress percentages, while focus time drives growth. | `growth-routes.ts`, `growth-service.ts`, `GrowthWorkspace.tsx`; diary/task/focus/outcome/feedback/review tables | guarded API contract and PostgreSQL aggregation tests; diary/growth desktop and 390px browser E2E | Add longer-range trend exploration and decide whether persistent derived snapshots are justified. |
| Search, weather, location, export | Product Spec, Roadmap | Partially implemented | High for Tavily-backed local brief generation and export; medium for user-entered location | Tavily is the preferred optional LLM-oriented provider, Brave is the secondary optional provider, and free GDELT remains the no-key fallback. Open-Meteo geocoding/weather is server-only; location is entered per day, and source/snapshot metadata is retained. Generated search sections are bounded by the brief contract before persistence. | `brief-providers.ts`, `ReviewWorkspace.tsx`; `daily_briefs.content`, `daily_briefs.sources` | provider tests, live Tavily standalone PostgreSQL/browser E2E, review browser E2E and type checks | Add opted-in device location and broader provider-failure acceptance. |
| Local Worker and optional Feishu | Architecture, Roadmap | Partially implemented | High for guarded queues, five-minute recovery, persisted text-candidate/confirmation and local tray runtime; medium for environment-dependent live delivery | Exact-task writes transactionally create/update/cancel both revision-bound `task_start` and `task_follow_up` jobs. The local Worker claims atomically, normalizes database timestamps, rejects stale tasks, retries with absolute timestamps, delivers Feishu cards when configured, and finalizes unanswered task starts without requiring the main window. The official local Feishu long connection receives owner text, deduplicates by source message ID, persists a parsed candidate, and sends a confirmation card. Only explicit confirmation creates a formal task or inbox entry. | `reminder_jobs`, `focus_timer_jobs`, `feishu_intake_candidates`; `reminder-scheduler.ts`, `focus-no-response.ts`, `feishu-intake-service.ts`, `feishu-long-connection.ts`, `apps/worker`, Tauri tray runtime | migration guard/schema verification; dual-job persistence checks; Worker/provider/webhook/long-connection tests; Feishu intake PostgreSQL tests; real browser no-response E2E; user-accepted tray behavior | Delivery still requires the configured local Worker, network and Feishu credentials to remain healthy. Cloud deployment is intentionally out of scope. |
| Weekly health reference | Latest health-reference baseline | Partially implemented | High for the user-maintained profile, weekly candidate/confirmation model, Today summary, question/task handoffs, PostgreSQL persistence and desktop/390px browser flows; low only for provider-dependent visual extraction | The Health page provides a complete profile editor and seven-day template/AI/manual/sleep-revision candidates. Every revision binds to the active plan ID/version; confirmation also checks the profile version, so stale content cannot replace newer data. The Today page reads only the confirmed daily reference. Food/movement question actions prefill but do not send an ordinary conversation. Movement conversion opens a separate exact-task form with blank times and writes no task until confirmation; the source health reference remains. Template vegetables now vary by solar term, city remains user-entered, and the optional vision capability is reported explicitly. | `health-routes.ts`, `health-service.ts`, `health-planner.ts`, `sleep-image-analyzer.ts`, `HealthWorkspace.tsx`, `TodayWorkspace.tsx`, `App.tsx`; `health_profiles`, `health_week_plans`, `health_daily_references`, `health_sleep_analyses`, confirmed conversion uses normal `tasks` writes | domain/schema/guarded PostgreSQL tests; capability/day-summary API tests; stale-base integration test; real browser E2E for profile fields, candidate/confirm/refresh, Today summary, no-write question prefill, explicit task conversion, sleep revision, desktop and 390px | Configure and verify a real vision-capable provider model; no other confirmed health interaction gap remains in this slice. |
| Long-range planning and AI task trees | Roadmap, Product Spec | Partially implemented | High for user-controlled plans and the candidate/confirmation persistence loop; medium for live DeepSeek output | The Planning workspace lets the user create, edit, archive and restore monthly mainlines, semester plans and annual directions with ordered self-owned milestones. AI can now create a bounded framework-level candidate, which remains editable, can be explicitly discarded, and creates no task until the explicit confirmation action. Confirmation writes source-linked unscheduled open tasks only; it never changes a plan or moves the timeline. | `long-range-plan-*.ts`, `long-range-task-tree-*.ts`, `LongRangePlansWorkspace.tsx`; `long_range_plans`, milestones, candidates, `tasks.source_long_range_plan_id` | guarded schema verification; service test; real PostgreSQL browser E2E for candidate edit, discard, refresh, explicit confirmation, linked task writes, UUID-only cleanup and 390px smoke | Run a live structured DeepSeek response acceptance test after model credentials and quota are intentionally allocated. |
| Local logical backup | Architecture, Roadmap, local-first decision | Fully implemented | High for export; deliberately no restore claim | User-initiated topbar download reads the complete local application dataset through the API | `GET /backups/export`; all current product tables, including Feishu intake candidates, software conversations, health analysis, legacy metadata and timer/reminder records | Fastify download-contract test plus guarded PostgreSQL/browser download test and 390px smoke test | Design import/restore separately: it must validate format versions, handle conflicts, and never replace data implicitly. |
| PWA and cross-device sync | Architecture, Roadmap | Not implemented | High | React web exists but has no PWA manifest/service worker | database API provides a future base only | none | Keep remote sync and cloud deployment deferred. |
| User profile and AI preferences | Product Spec privacy rules | Fully implemented | High for local persistence and consent boundary | `UserProfileSettings.tsx` opens from the desktop shell; the user edits background, AI guidance, sharing consent and response style, with optimistic version recovery | `GET/PUT /api/v1/user-profile`; `user_profiles` singleton | service/API tests, real PostgreSQL browser E2E, desktop and 390px checks | Keep the profile user-authored; live model acceptance remains a separate provider concern. |

## 4. Current Page to Real Function Mapping

| Page/surface | What is real today | What is only presentation/local state | Honest status |
| --- | --- | --- | --- |
| Today | Database-backed task/inbox capture, complete form, 30-minute time axis/interactions, blank-slot creation, pointer and keyboard drag/resize, conflict retention, lifecycle actions, direct task-to-focus handoff, and a collapsible active-only daily health summary | Richer conflict visualization and cloud synchronization | Partially implemented |
| Focus | Reads real tasks and durable focus sessions; future scheduling, one-minute preparation with manual skip, fixed-end auto-start, late-start segment positioning, 30/60/long-block rest rules, final-rest skip, raw/effective time, objective result and subjective feedback write through API and survive refresh. A quiet local hint area uses only explicit title keywords or a general fallback, stays stable through refresh, avoids AI calls and disappears during rest. The main window may be hidden while the bundled Worker processes durable timers and no-response follow-ups. | Live Feishu delivery remains environment-dependent; cloud/offline-while-computer-off delivery is out of scope | Partially implemented |
| Review | Opens/restores a `daily_review` session, keeps user and AI turns separate, offers save-only or explicit AI response, preserves user text across provider failure, reads real task/focus/outcome/feedback and separate same-day software conversation context, generates/edits/confirms/regenerates/exports a brief, and keeps confirmed brief edits persisted through refresh | Live response remains provider/network dependent; the free-form workflow intentionally avoids a mandatory questionnaire | Partially implemented |
| Diary | Reads its review/brief prerequisites, supports database-backed month navigation and historical selection, saves, restores, edits and exports a persisted diary with server-side link validation. Real task/focus cards, weather/location, six metrics, daily state color and tree feedback are API-derived. | Product decision on an immutable final export snapshot remains | Partially implemented |
| Growth | Reads seven-day or thirty-day database-derived focus, outcomes, feedback and review signals; the range is user-selectable and loaded through the API | No year/long-term exploration or immutable derived snapshot | Partially implemented |
| Health | A complete user-controlled profile form, active/candidate weekly references, structured sleep screenshot analyses, and source-linked sleep revision candidates are API-backed and restored from PostgreSQL. Template/AI/manual revisions bind to the active plan version and display complete overview/supplement/day differences before confirmation. Today shows a collapsible active-only daily summary. Food/movement questions open a prefilled unsent conversation, while movement conversion opens an exact-task form with blank times and preserves the health reference. The optional vision capability is visibly disabled when no verified model exists. | A vision-capable provider model still needs real credential/model verification | Partially implemented |
| Planning | Real monthly, semester and annual plans with ordered milestones load from PostgreSQL, retain user edits after refresh, use optimistic versions, and require explicit archive/restore actions. The page also supports an editable AI framework task-tree candidate that can be explicitly saved, discarded or confirmed; no candidate creates tasks until the user confirms it, and confirmed tasks retain a source-plan link. | Live DeepSeek output still needs acceptance; no automatic plan/timeline change is permitted. | Partially implemented |
| AI drawer | Server-side ordinary conversation messages persist in `app_conversations` and `app_conversation_messages`, restore after refresh, and remain separate from review messages. Model parsing returns a transient candidate with editable task or inbox fields; only explicit confirmation writes through the real API, and saved tasks persist through refresh. A separate Planning path persists framework task-tree candidates and, after a separate explicit confirmation, creates only unscheduled source-linked tasks. A standalone-brief action persists a confirmed brief and restores it on reopen/refresh without creating a review or diary. “另有安排” opens a task/day-context advisory that returns visible options only and never writes a schedule change. | Provider-unavailable candidate UI, richer conversation controls, and a live DeepSeek task-tree response need dedicated acceptance | Partially implemented |
| Desktop shell/Tauri | Tauri development command and the standalone Windows executable start the bundled API/Worker runtime; the NSIS installer is rebuilt and health-checked | A fresh installation creates `%APPDATA%\\com.personalai.assistant\\.env` from a secret-free template; the user must fill local database settings before first launch | Partially implemented |
| Global backup control | A user-triggered download requests a versioned, read-only logical JSON backup from the local API; no page state, environment values, credentials, runtime files, or PostgreSQL directory contents are included | Restore/import is intentionally absent because it requires a separately validated destructive-operation design | Fully implemented for export |
| Personal settings | Opens a user-controlled profile and AI-preference layer from the top bar; changes persist and are restored without inference | Provider-specific model behavior remains external to the settings form | Fully implemented |
| 390px mobile | Responsive timeline and formal-task dialog, active health summary, complete health page and task-conversion form; automated mobile smoke checks pass without horizontal overflow | Cross-device/cloud persistence and broader device-specific visual acceptance | Partially implemented |

## 5. Field-to-Storage Contract

The following mapping is the contract used by the implemented manual
scheduling slice. The inbox/source-link migration and the
retired task metadata is archived in `task_legacy_metadata`; the live `tasks`
table and API do not expose or accept those fields.

### 5.1 Formal Task Form

| Page field | API field | Database field | Validation and authority |
| --- | --- | --- | --- |
| Task title | `title` | `tasks.title` | Required; trim; 1–200 characters. |
| Scheduling mode | `scheduleKind` | `schedule_kind` | Required enum: `none`, `daypart`, `exact`. |
| Date | `localDate` | `local_date` | Optional target date for `none`; required for `daypart`; forbidden in exact input and derived by the server. |
| Daypart | `daypart` | `daypart` | `morning`, `afternoon`, or `evening`; required only for `daypart`. |
| Start | `startAt` | `start_at` | Offset ISO 8601; required only for `exact`; stored as UTC `timestamptz`. |
| End | `endAt` | `end_at` | Offset ISO 8601; paired with start, on a half-hour boundary, and at least 30 minutes after start. |
| Time zone | `timeZone` | `time_zone` | Valid IANA zone; first UI defaults to `Asia/Shanghai`. Exact `localDate` is derived from start plus this zone. |
| Notes | `notes` | `notes` | Optional trimmed text, maximum 4000 characters. |
| Lifecycle (read/action UI) | `lifecycleStatus` | `lifecycle_status` | Not freely editable; transitions use explicit action APIs. |
| Current objective result | `currentOutcome` | `current_outcome` | Read-only in form; set with append-only outcome transaction. |
| Optimistic version | `expectedVersion` / `version` | `version` | Every task mutation checks/increments it. |
| Schedule version | `expectedScheduleRevision` / `scheduleRevision` | `schedule_revision` | Every schedule mutation checks it; increments only by the matrix in section 7. |
| Keep-conflict decision | `conflictDecision`, `expectedConflictFingerprint` | `task_conflict_acceptances` | `keep` requires the last complete server fingerprint; the server recomputes and atomically accepts all current pairs. |
| Scheduled block duration | response `scheduledDurationMinutes` | not stored | Derived only from `endAt - startAt`. |

Applied migration consequences:

- Archive the former effort, difficulty, task-type, and continuous-focus values
  in `task_legacy_metadata`, then remove those columns from live `tasks`.
- Remove `tasks.entry_type`; a task row always represents a formal task.
- Add nullable unique `tasks.source_inbox_entry_id` referencing the retained
  source entry.

### 5.2 Idea and Question Inbox

Ideas and questions do not show task scheduling or any formal-task fields. They
do not have task lifecycle states.

| Page field/action | API field | Database field | Validation and authority |
| --- | --- | --- | --- |
| Entry kind | `entryKind` | `inbox_entries.entry_kind` | Required: `idea` or `question`. |
| Content | `content` | `content` | Required after trimming; maximum length set by the shared schema. |
| Notes | `notes` | `notes` | Optional text. |
| Version | `expectedVersion` / `version` | `version` | Required for update/delete/convert concurrency control. |
| Conversion state | response field | `converted_at` | Null until a successful explicit conversion. |
| Soft deletion | delete action | `deleted_at` | Independent of conversion; conversion never deletes the entry. |
| Timestamps | response fields | `created_at`, `updated_at` | Server controlled. |
| Convert to task | `confirmed`, `expectedVersion`, nested `task` | `converted_at`, `tasks.source_inbox_entry_id` | Requires `confirmed: true`; creates one task and records both links in one transaction. |

### 5.3 Long-Range Planning

Long-range plans remain separate from daily `tasks`. They are user-authored
direction and milestones, not a second task lifecycle and not an automatic
scheduler.

| Page field/action | API field | Database field | Validation and authority |
| --- | --- | --- | --- |
| Plan scope | `scope` | `long_range_plans.scope` | Required enum: `month`, `semester`, `annual`; user selects it. |
| Title | `title` | `long_range_plans.title` | Required trimmed text, 1–200 characters. |
| Period | `periodStart`, `periodEnd` | `period_start`, `period_end` | Required ISO dates; the end must not precede the start. |
| Description | `description` | `description` | Optional trimmed text, maximum 8000 characters. |
| Ordered milestones | `milestones[]` | `long_range_plan_milestones` | Title required; optional target date and notes; maximum 30 and position is unique per plan. |
| Optimistic version | `expectedVersion` / `version` | `long_range_plans.version` | Required for edit/archive/restore; stale writes return `409 long_range_plan_version_conflict` and do not overwrite the database. |
| Archive/restore | `status` | `status`, `archived_at` | User action only; archived plans are immutable until explicitly restored. |

The user-authored plan API is `GET/POST /long-range-plans`,
`GET/PUT /long-range-plans/:id`, and `POST /long-range-plans/:id/status`.
These plan mutations do not write a daily task, invoke AI, or change a
schedule. The separately scoped candidate contract is below.

### 5.4 Framework Task-Tree Candidates

AI task-tree output is a proposed framework, never an automatic task tree.
Generation, candidate edits, and confirmation are separated so the user can
inspect and correct every proposed task before any write occurs. The Planning
workspace exposes a visible discard action, which records the terminal
cancelled state without modifying any task or plan.

| Page field/action | API field | Database field | Validation and authority |
| --- | --- | --- | --- |
| Optional decomposition instruction | `instructions` | `long_range_plan_task_tree_candidates.instructions` | Optional trimmed text, 1000-character maximum; supplies boundaries only. |
| Generate candidate | `expectedPlanVersion` | `long_range_plan_version` | The active plan's optimistic version must match before and after AI generation. A stale plan returns `409` and creates no candidate. |
| Candidate summary | `proposal.summary` | `proposal` JSONB | Required, 1–2000 trimmed characters. It is visible and editable before confirmation. |
| Candidate tasks | `proposal.tasks[]` | `proposal` JSONB | 1–12 items; each has a required title, optional target date, and optional notes. No exact time, daypart, difficulty, type, or focus metadata is accepted. |
| Candidate version | `expectedVersion` / `version` | `version` | Save, cancel, and confirm use optimistic versions. Stale candidate or plan writes return `409` before any task write. |
| Candidate state | response `state` | `state`, `confirmed_at`, `cancelled_at` | `candidate`, `confirmed`, or `cancelled`. A confirmed candidate is idempotent and returns its original task IDs. |
| Explicit confirmation | `POST /task-tree-candidates/:id/confirm` | `created_task_ids`, `tasks.source_long_range_plan_id` | Only this action writes tasks, in one transaction. Every result is an `open`, `none`-scheduled task with optional target `local_date`; it cannot create a time block or modify the source plan. |

The candidate API is `GET /long-range-plans/:planId/task-tree-candidate`,
`POST /long-range-plans/:planId/task-tree-candidates/ai`,
`PUT /task-tree-candidates/:id`, and `POST` actions at `/cancel` or
`/confirm`. Both candidate-to-plan and created-task-to-plan relations are
database foreign keys.

The conversion endpoint is
`POST /api/v1/inbox-entries/:id/convert-to-task`. The source `inbox_entry`
remains readable after conversion, records `converted_at`, and is not
automatically deleted. A unique source link prevents duplicate task creation;
stale or repeated conversion returns `409` without partial writes.

## 6. Schedule Kind Validation Matrix

Frontend conditional fields and validation, the shared Zod contract, service
validation, and PostgreSQL checks must all enforce the same matrix:

| Kind | `localDate` | `daypart` | `startAt` / `endAt` | Timeline behavior |
| --- | --- | --- | --- | --- |
| `none` | optional target date | forbidden | both forbidden | Unscheduled area; no exact conflict detection. |
| `daypart` | required | required | both forbidden | Morning/afternoon/evening group; no exact conflict detection. |
| `exact` | forbidden in request; server derived | forbidden | both required | 24-hour coordinate timeline and exact overlap detection. |

Additional exact rules:

- `startAt` and `endAt` must resolve to `:00` or `:30` in `timeZone`, and
  `endAt` must be at least 30 minutes after `startAt`.
- Both instants must resolve to the same date in `timeZone`; Phase 1 rejects
  cross-midnight tasks.
- The full form, blank selection, drag and resize all use one 30-minute
  interval contract. A blank click creates a 30-minute draft.
- Moving a block preserves its exact scheduled length; resizing changes the
  block by 30-minute increments. Neither operation changes the task's title,
  notes, or other non-scheduling fields.

## 7. Version and Schedule Revision Rules

`version` increments for every successful task mutation. `scheduleRevision`
increments for every operation that changes either scheduling content or
eligibility for conflict participation:

| Change or transition | Increment `version` | Increment `scheduleRevision` |
| --- | --- | --- |
| `scheduleKind` | yes | yes |
| `localDate` | yes | yes |
| `daypart` | yes | yes |
| `startAt` or `endAt` | yes | yes |
| `timeZone` | yes | yes |
| `open -> active -> awaiting_outcome` | yes | no |
| enter `closed` by recording outcome | yes | yes |
| cancel | yes | yes |
| reopen from `closed` or `cancelled` | yes | yes |
| soft delete | yes | yes |
| restore a soft-deleted task | yes | yes |
| orphan recovery `active -> awaiting_outcome` | yes | no |
| title, notes | yes | no |

`localDate` and `daypart` changes increment the schedule revision even though
they do not participate in exact overlap calculations. This keeps all visible
scheduling edits under one unambiguous concurrency contract. The
`active -> awaiting_outcome` crash-recovery transition does not alter conflict
eligibility because both states remain in the blocking group.

Schedule-changing PATCH requests must provide both `expectedVersion` and
`expectedScheduleRevision`. A mismatch returns
`409 task_schedule_revision_conflict` with the current task snapshot before any
conflict acceptance or task update is written.

## 8. Lifecycle, Conflict, and Timeline Interaction

| State | Conflict role | Move/resize | Visual behavior |
| --- | --- | --- | --- |
| `open` | blocking | allowed | normal actionable block |
| `active` | blocking | forbidden | locked, active focus state |
| `awaiting_outcome` | blocking | forbidden | locked, outcome required |
| `closed` | historical overlap only | forbidden | retained in history with completed styling |
| `cancelled` | excluded | forbidden | removed from active timeline or shown only in history filters |
| soft-deleted | excluded | forbidden | hidden from normal views |

Adjacent intervals do not conflict. Overlapping blocks are never automatically
moved or overwritten. They render side by side with a conflict marker and a
deliberate “keep conflict” flow.

Drag/resize invariants:

- A drag changes only `startAt` and `endAt`, preserving the scheduled block
  duration exactly.
- A resize changes only the scheduled interval endpoint and therefore only the
  derived scheduled duration.
- Neither operation writes or derives any retired task metadata.
- Every drag/resize PATCH sends `expectedVersion` and
  `expectedScheduleRevision`. A keep-conflict retry also sends the exact
  fingerprint returned for that proposed interval.
- The UI commits the block position only after API success. Validation,
  concurrency, conflict-set, network, or server failure restores the original
  position and presents an actionable error.

## 9. Manual Entry and Timeline Implementation Plan

This slice should retain the “Night Voyage Garden” visual language and deliver
a portfolio-quality temporal workspace, not a conventional admin scheduler.
Correctness constraints define its behavior; they do not justify reducing the
experience to forms and rows.

1. **Guarded data migration**
   - Add `inbox_entries`, archive retired task metadata, make `tasks`
     formal-only, and
     add the retained source link.
   - Recheck existing entry counts at migration time. If legacy ideas/questions
     exist, copy them into inbox entries transactionally before removing the
     mixed field.
   - Run the existing database/role/host/port/PostgreSQL-major guard first.
2. **Domain and API contracts**
   - Split formal task and inbox schemas/routes.
   - Add transactional conversion, the exact schedule matrix, 30-minute minimum,
     schedule-revision preconditions, and strict rejection of retired task
     metadata.
   - Keep complete `40001` transaction retries and atomic conflict acceptance.
3. **Entry experiences**
   - Preserve quick formal-task capture as title only, saved to the unscheduled
     area for later scheduling.
   - Add “Complete and schedule” and a polished full task form containing every
     mapped field. Explicit form input never invokes AI.
   - Give ideas/questions their own restrained inbox form and an explicit,
     editable “Convert to task” confirmation flow.
4. **Real Today timeline**
   - Use a 00:00–24:00 vertical coordinate system with real ticks, current-time
     indicator, date context, daypart groups, and a distinct unscheduled area.
   - Blank click opens a 30-minute exact-task draft; blank drag selects a
     30-minute-snapped range. No row is written until form confirmation.
   - Support touch/mouse drag and resize, locked lifecycle states, spatial
     overlaps, historical warnings, optimistic overlays, rollback, and explicit
     keep-conflict dialog.
   - Auto-scroll today near current Shanghai time, another date to its first
     exact task, and an empty date to 08:00.
5. **Responsive and visual completion**
   - Desktop prioritizes a spacious temporal canvas and fast repeated actions.
     At 390px the timeline remains readable and touch-operable without text or
     controls overlapping.
   - Motion is limited to useful placement, drawer, conflict, and state feedback;
     it must not distract during focus or compromise performance.

## 10. Planned Files and Interfaces

After this audit is approved, the implementation is expected to modify:

- Database: `packages/db/src/schema.ts` plus a guarded Drizzle migration for
  `inbox_entries`, legacy metadata archival, formal-task-only storage, source link,
  and exact-interval constraints.
- Domain/API: task schemas/service/repository/routes plus new inbox schemas,
  service, repository, and routes. Schedule PATCH gains
  `expectedScheduleRevision`; responses gain derived
  `scheduledDurationMinutes`.
- Web: split task/inbox API clients and form components; full task dialog;
  inbox conversion dialog; timeline axis, blocks, unscheduled/daypart areas,
  conflict dialog, and interaction state.
- Tests: domain validation, API/service/repository integration, migration
  verification, frontend interaction tests, and Playwright browser E2E.

The scheduling-slice plan above is historical. Focus, review, brief, diary,
growth and the Worker queue have since been implemented in separate commits;
live Feishu delivery acceptance remains pending.

## 11. Test and Acceptance Plan

### Domain, service, and database

- Validate every allowed/forbidden schedule-shape combination in frontend and
  backend contracts, including null/omitted fields.
- Verify the shared 30-minute boundary/minimum contract in the form, timeline,
  API and database, plus time-zone date derivation, UTC storage, and
  cross-midnight rejection.
- Verify the complete schedule-revision matrix in section 7, including
  `localDate`, daypart, cancel, reopen, delete, restore, and non-schedule edits.
- Verify drag and resize service updates change only the scheduled interval.
- Verify retained inbox entries, transactional conversion, unique source link,
  stale versions, repeated conversion, and rollback.
- Verify open/active/awaiting/closed/cancelled/deleted conflict behavior and
  movability rules.
- Re-run overlap boundaries, multi-conflict atomic acceptance, stale
  fingerprints, and complete `40001` transaction retries.

### Real browser E2E

A serial Playwright scenario must use the real API and PostgreSQL database:

1. Create an exact formal task through the full form.
2. Refresh and verify all form/timeline values persist.
3. Drag it and verify the scheduled duration is unchanged.
4. Resize it and verify only the scheduled duration changes.
5. Create an overlap and verify no silent write/move occurs.
6. Explicitly retain the complete conflict set.
7. Refresh again and verify positions, conflict acceptance, and visual states.
8. Open a 390px browser context and read the same task without overflow.
9. Clean up only the UUIDs captured by that test.

The timeline acceptance must assert persisted `startAt`/`endAt` values after
blank creation, drag and resize. Visual displacement alone is not evidence.

E2E cleanup must refuse to run until it verifies the project database name,
role, host, port, and PostgreSQL major version. It may delete only captured
UUIDs and their dependent test records; broad predicates, truncation, and
wildcard cleanup are forbidden.

### Completion reporting

Verification results must be reported independently for shared validation,
PostgreSQL persistence, API integration, desktop browser interaction, and
390px mobile behavior. A backend pass alone cannot raise full-product
verification confidence to high.

## 12. Serious Issues and Requirement Gaps

Corrective audit findings fixed on 2026-07-29:

- The grid displayed 30-minute rows while blank selection, move and resize still
  used 15/5-minute internals. One 30-minute contract now drives the form,
  interactions, shared validation and guarded PostgreSQL migration `0008`.
- `App.tsx` contained hidden obsolete Today/Review implementations and reused
  their removed `entryType`/`estimatedMinutes` task model in the live AI drawer.
  The hidden implementation was removed; AI tasks now use the current task
  contract and ideas/questions use `inbox_entries`.
- A 30-minute block was only 18px tall, so its visible action button overlapped
  the resize handle and could not be clicked. Each half-hour lane now has a
  stable 36px height with disjoint action/resize hit regions; browser E2E covers
  the task-to-focus handoff.

Remaining gaps:

1. **Ideas/questions conflict coverage is intentionally narrow.** Confirmed
   conversion, source retention, task linkage, and stale-version form recovery
   are verified. Additional conflict variants only become necessary if inbox
   editing or multi-step conversion is expanded.
2. **Timeline complex-conflict visualization remains incomplete.** Pointer
   creation, drag/resize, keyboard manipulation and the accessible conflict
   detail/confirmation path are verified. The next visual gap is a clearer
   treatment when several lanes overlap at once.
3. **Retired task metadata is archived, not exposed.**
   Existing values remain queryable only through `task_legacy_metadata`; new
   task requests containing those keys are rejected.
4. **Cross-device confidence is not established.** Local refresh and browser
   interaction are verified; cross-device synchronization is intentionally
   outside the current local-first scope.
5. **Browser coverage is broad but not exhaustive.** The serial real-API,
   real-PostgreSQL Playwright suite covers task/inbox
   capture, timeline conflict retention, focus execution and recovery, review,
   brief, diary, growth, health, long-range planning, backup, desktop commands
   and 390px layouts. Provider-unavailable states and additional browsers still
   need dedicated acceptance.
6. **Growth feedback remains intentionally bounded.** Seven-day and thirty-day
   views now use the confirmed six dimensions, saved user ratings and real
   satisfaction-based state colors. Year/long-term trends and a deeper
   statistical model are not yet implemented.
7. **Cyber diary finalization semantics need one product decision.** Referential
   integrity, month history, task/focus cards, weather/location, editable six
   dimensions, state color and tree data are verified against the guarded
   database. Saved radar values are now part of the diary content, but the
   remaining derived task/focus/weather data still uses authoritative live
   records; a separate immutable final snapshot has not been specified.
8. **Later dependencies remain absent.** PWA and cross-device verification
   still need explicit implementation phases. Cloud runtime remains deferred;
   the durable local Worker and initial Feishu controls already exist.
9. **Sleep visual extraction is provider-dependent.** The local boundary,
   validation, hash-only persistence, structured output contract and browser
   flow are real. A provider must actually support image input; otherwise the
   API returns an explicit unavailable response and writes nothing. The
   current slice never treats a failed provider call as an analysis result.
10. **Manual weekly editing is intentionally a full candidate editor, not a
    clinical decision engine.** It persists only user-entered reference text
    and ranges, uses optimistic versions, and still requires a separate
    confirmation to replace the active week. It does not infer health data,
    generate tasks, score the user, or prescribe treatment.
11. **Some live provider acceptance remains scoped.** The configured DeepSeek
    text provider has now passed a real ordinary-conversation browser flow and
    a live no-write task-parse request. Framework task-tree structured output and
    vision-capable analysis still require separate provider/model acceptance;
    those gaps do not block the local conversation and review-context slice.

This audit records the approved contract and current verification status. The
live implementation now includes the guarded legacy-field migration and real
browser coverage for the reduced task form.
