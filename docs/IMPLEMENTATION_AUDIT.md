# Implementation Audit

Audit date: 2026-07-27
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
use the Fastify API and PostgreSQL repository. These facts do **not** mean the
usable core product is complete: the current Today page is a sorted card list,
not a time-coordinate editor, and it lacks the complete manual task form.

The largest immediate structural conflict is that `tasks.entry_type` stores
tasks, ideas, and questions together. Confirmed behavior requires formal tasks
to own lifecycle and scheduling, while ideas/questions remain independent until
the user explicitly converts them. The scheduling slice therefore requires a
guarded migration; it cannot honestly be described as a UI-only change.

Focus, review, diary, and growth screens currently provide valuable visual
direction, but their user data is React-local and disappears on refresh. The
schema contains placeholder tables for several of these areas, but no service
or API routes use them. A particularly serious defect is that `cyber_diaries`
references a brief but not its required review session.

## 3. Functional Audit Matrix

| Capability | Requirement source | Status | Confidence | Current code / page | API / tables | Automated evidence | Missing work and next step |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Secure project/database baseline | Architecture, AGENTS | Fully implemented | High | `.gitignore`, DB guard/config | `personal_ai_assistant`, `personal_ai_app` | migration guard tests; `pnpm db:verify` | Keep the guard mandatory for every migration and E2E cleanup. |
| Task lifecycle and optimistic versioning | Product Spec, State Machines, Task Lifecycle | Partially implemented | High for backend; medium end-to-end | Today task actions in `App.tsx`; task service/repository | Task CRUD/action routes; `tasks`, lifecycle events, outcomes | service, route, repository, persistence tests | Browser flows and all lifecycle visual states need E2E coverage. |
| Append-only task outcomes and reopening | Product Spec, State Machines | Partially implemented | High for backend | Today complete/partial/reopen actions | outcome and reopen routes; `task_outcomes` | outcome history service tests | Full outcome form, focus linkage, refresh/browser verification, and subjective feedback remain. |
| Exact-time conflict detection and retention | Product Spec, Task Lifecycle | Partially implemented | High for backend; low for interaction | Conflict messages in Today page | task create/update/accept APIs; `task_conflict_acceptances` | overlap, history, stale set, rollback tests | No spatial overlap rendering, conflict dialog, drag/resize retry, or browser E2E. |
| Full manual task creation | Product Spec, Roadmap | Partially implemented | High | Quick capture has title and estimated minutes; edit form has limited scheduling | `POST /tasks` supports more fields; `tasks` contains them | API/domain tests only | Add a formal-task full form with every mapped field and frontend validation; explicit form entry must not call AI. |
| Quick task capture | Product Spec, Design Review | Partially implemented | Medium | Quick capture calls the real task API | `POST /tasks`; `tasks` | route test, no browser test | Rename duration copy/contract to planned effort; keep it unscheduled and add “complete and schedule”. |
| Independent ideas/questions | Product Spec | Conflicts with requirements | High | Type switch writes all entries through task flow | `POST /tasks`; `tasks.entry_type` | AI candidate non-write test only | Introduce `inbox_entries`; remove them from task lifecycle; preserve converted entries and source linkage. |
| AI candidate confirmation | Product Spec, Design Review | Partially implemented | Medium | AI drawer parses then asks for confirmation | `POST /api/v1/ai/tasks/parse`; confirmed candidate later uses task API | parser route test | Route ideas/questions to inbox, add correction/error tests, and preserve formal fields without silent scheduling. |
| Real Today timeline | Product Spec, Design Review | Partially implemented | High | Sorted task cards, no 24-hour coordinate system | Reads task list API | no Web/E2E tests | Build the real axis, current-time marker, daypart/unscheduled areas, spatial overlaps, auto-scroll, drag creation/move/resize. |
| Timeline persistence and cross-client reading | Product Spec, Architecture | Partially implemented | Medium | API-backed cards survive refresh | task list API; `tasks` | DB persistence verification, no real browser test | Prove create-refresh-desktop/mobile read and interaction persistence in Playwright. |
| Focus session workflow | Product Spec, State Machines, Roadmap | UI prototype only | High | Timer, pause, finish, and satisfaction are local `useState` | placeholder `focus_sessions`, `task_feedback`; no routes | none | Implement preparation/reminder/start/no-response/pause/resume/exit/recovery APIs and durable timers/results. |
| Review session workflow | Product Spec, State Machines | UI prototype only | High | Review messages and draft are local state | placeholder `review_sessions`, `review_messages`; no routes | none | Add independent daily review context, context loading, durable messages, restore, and finish/generate action. |
| Daily brief | Product Spec, Roadmap | Not implemented | High | no real brief page/editor | placeholder `daily_briefs`; no routes | none | Add search/weather adapters, source-backed sections, edit/regenerate/confirm/export, and no-review gating. |
| Cyber diary | Product Spec, State Machines | Conflicts with requirements | High | local draft and non-functional save button | `cyber_diaries` lacks required `review_session_id`; no routes | none | Fix relational model and implement confirmed-review + confirmed-brief validation, save/restore/edit/export. |
| Growth and statistics | Product Spec, Roadmap, Design Review | UI prototype only | High | local focus count plus fixed decorative plants | no growth/statistics API | none | Derive trends, subjective categories, state colors, radar, points, tree type/growth from persisted records. |
| Search, weather, location, export | Product Spec, Roadmap | Not implemented | High | no product integration | no adapters/routes | none | Implement provider-neutral adapters, source metadata, user location controls, and exports after core persistence. |
| Worker, Feishu, cloud runtime | Architecture, Roadmap | Not implemented | High | no worker application | no job/reminder or webhook API | none | Add durable jobs, cloud database/runtime, signed Feishu webhook, start/other-arrangement/open-task controls. |
| Long-range planning and AI task trees | Roadmap, Product Spec | Not implemented | High | no month/term/year views | no plan/tree API or tables | none | Add only after usable daily core; AI-created trees require explicit confirmation before writes. |
| PWA, cross-device sync, backup | Architecture, Roadmap | Not implemented | High | React web exists but has no PWA manifest/service worker | database API provides a future base only | none | Add installability, online synchronization policy, backup/export and recovery verification. |
| User profile and AI preferences | Product Spec privacy rules | Not implemented | High | no settings model | no API/tables | none | Add explicit user-controlled preferences only; no surveillance or inferred personality profile. |

## 4. Current Page to Real Function Mapping

| Page/surface | What is real today | What is only presentation/local state | Honest status |
| --- | --- | --- | --- |
| Today | Lists PostgreSQL tasks; quick task/idea/question capture currently writes through task API; task lifecycle actions and limited editing call real APIs | card ordering is not a timeline; no blank-slot creation, drag, resize, current-time indicator, or robust conflict dialog | Partially implemented |
| Focus | Selects a real task from the API-backed list | running time, pause state, finish state, satisfaction and recovery are local and vanish on refresh | UI prototype only |
| Review | Displays counts derived partly from loaded tasks | review messages, draft, “session” and focus summary are not persisted | UI prototype only |
| Diary | Enforces a visual local-message gate and creates an editable local draft | no brief, weather, review relation, save, restore or export | Conflicts with requirements |
| Growth | Displays local-session minutes | plants and weekly state are fixed frontend illustration data; no database statistics | UI prototype only |
| AI drawer | Server-side model parsing returns a candidate without an immediate write; user confirms before current save | ideas/questions are still saved as tasks; no durable conversation context | Partially implemented |
| Desktop shell/Tauri | Shared React interface and Tauri wrapper exist | no separately verified desktop-native workflow or background behavior | Partially implemented |
| 390px mobile | responsive CSS exists | no automated mobile viewport or cross-client persistence verification | Unverified prototype surface |

## 5. Field-to-Storage Contract

The following mapping is the gate for the manual scheduling slice. It proves
that a migration **is required** before implementation: the desired inbox and
source-link fields do not exist, and `estimated_minutes` must be renamed to
remove duration ambiguity.

### 5.1 Formal Task Form

| Page field | API field | Database field | Validation and authority |
| --- | --- | --- | --- |
| Task title | `title` | `tasks.title` | Required; trim; 1–200 characters. |
| Scheduling mode | `scheduleKind` | `schedule_kind` | Required enum: `none`, `daypart`, `exact`. |
| Date | `localDate` | `local_date` | Optional target date for `none`; required for `daypart`; forbidden in exact input and derived by the server. |
| Daypart | `daypart` | `daypart` | `morning`, `afternoon`, or `evening`; required only for `daypart`. |
| Start | `startAt` | `start_at` | Offset ISO 8601; required only for `exact`; stored as UTC `timestamptz`. |
| End | `endAt` | `end_at` | Offset ISO 8601; paired with start, later than start, minimum interval 5 minutes. |
| Time zone | `timeZone` | `time_zone` | Valid IANA zone; first UI defaults to `Asia/Shanghai`. Exact `localDate` is derived from start plus this zone. |
| Planned effort | `plannedEffortMinutes` | `planned_effort_minutes` | Optional integer 1–1440. This is the user's estimate of total effort, not the scheduled block length. |
| Difficulty | `difficulty` | `difficulty` | Optional: `low`, `medium`, `high`. |
| Task type | `taskType` | `task_type` | Optional trimmed string, maximum 80 characters. |
| Continuous focus | `requiresContinuousFocus` | `requires_continuous_focus` | Optional boolean. |
| Notes | `notes` | `notes` | Optional trimmed text, maximum 4000 characters. |
| Lifecycle (read/action UI) | `lifecycleStatus` | `lifecycle_status` | Not freely editable; transitions use explicit action APIs. |
| Current objective result | `currentOutcome` | `current_outcome` | Read-only in form; set with append-only outcome transaction. |
| Optimistic version | `expectedVersion` / `version` | `version` | Every task mutation checks/increments it. |
| Schedule version | `expectedScheduleRevision` / `scheduleRevision` | `schedule_revision` | Every schedule mutation checks it; increments only by the matrix in section 7. |
| Keep-conflict decision | `conflictDecision`, `expectedConflictFingerprint` | `task_conflict_acceptances` | `keep` requires the last complete server fingerprint; the server recomputes and atomically accepts all current pairs. |
| Scheduled block duration | response `scheduledDurationMinutes` | not stored | Derived from `endAt - startAt`; it is never copied into planned effort. |

Migration consequences:

- Rename `tasks.estimated_minutes` to `planned_effort_minutes` without changing
  existing values.
- Remove `tasks.entry_type`; a task row always represents a formal task.
- Add nullable unique `tasks.source_inbox_entry_id` referencing the retained
  source entry.

### 5.2 Idea and Question Inbox

Ideas and questions do not show task scheduling, planned effort, difficulty,
task type, or continuous-focus fields. They do not have task lifecycle states.

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

- `endAt` must be at least 5 minutes after `startAt`.
- Both instants must resolve to the same date in `timeZone`; Phase 1 rejects
  cross-midnight tasks.
- The full form accepts 5-minute precision. Drag/resize defaults to 15-minute
  snapping; a blank click uses 30 minutes only as a pre-filled default.
- Moving an existing 45-, 50-, or 90-minute block preserves its exact length.

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
| title, notes, difficulty, task type, continuous focus, planned effort | yes | no |

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
- Neither operation writes or derives `plannedEffortMinutes`.
- `plannedEffortMinutes` changes only when the user deliberately edits the
  labelled “Planned effort” field in a form.
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
   - Add `inbox_entries`, rename planned effort, make `tasks` formal-only, and
     add the retained source link.
   - Recheck existing entry counts at migration time. If legacy ideas/questions
     exist, copy them into inbox entries transactionally before removing the
     mixed field.
   - Run the existing database/role/host/port/PostgreSQL-major guard first.
2. **Domain and API contracts**
   - Split formal task and inbox schemas/routes.
   - Add transactional conversion, the exact schedule matrix, 5-minute minimum,
     planned/scheduled duration separation, and schedule-revision preconditions.
   - Keep complete `40001` transaction retries and atomic conflict acceptance.
3. **Entry experiences**
   - Preserve quick formal-task capture as title plus optional planned effort,
     saved to the unscheduled area.
   - Add “Complete and schedule” and a polished full task form containing every
     mapped field. Explicit form input never invokes AI.
   - Give ideas/questions their own restrained inbox form and an explicit,
     editable “Convert to task” confirmation flow.
4. **Real Today timeline**
   - Use a 00:00–24:00 vertical coordinate system with real ticks, current-time
     indicator, date context, daypart groups, and a distinct unscheduled area.
   - Blank click opens a 30-minute exact-task draft; blank drag selects a
     15-minute-snapped range. No row is written until form confirmation.
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
  `inbox_entries`, planned-effort rename, formal-task-only storage, source link,
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

No focus, review, brief, diary, growth, Worker, or Feishu implementation should
be added during this scheduling slice.

## 11. Test and Acceptance Plan

### Domain, service, and database

- Validate every allowed/forbidden schedule-shape combination in frontend and
  backend contracts, including null/omitted fields.
- Verify 5-minute minimum, 5-minute form precision, 45/50/90-minute intervals,
  time-zone date derivation, UTC storage, and cross-midnight rejection.
- Verify the complete schedule-revision matrix in section 7, including
  `localDate`, daypart, cancel, reopen, delete, restore, and non-schedule edits.
- Verify drag and resize service updates never change planned effort.
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
3. Drag it and verify duration plus planned effort are unchanged.
4. Resize it and verify only the scheduled duration changes.
5. Create an overlap and verify no silent write/move occurs.
6. Explicitly retain the complete conflict set.
7. Refresh again and verify positions, conflict acceptance, and visual states.
8. Open a 390px browser context and read the same task without overflow.
9. Clean up only the UUIDs captured by that test.

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

1. **Ideas and questions currently enter task lifecycle.** This directly
   conflicts with the confirmed product model and requires schema/API/UI change.
2. **The Today page is not a true timeline.** It cannot create from time-space,
   move/resize blocks, represent the current time, or prove conflict retention
   through real interaction.
3. **`estimatedMinutes` conflates two duration concepts.** It can make a
   scheduled block and total planned effort contradict each other unless renamed
   and kept independent.
4. **Schedule PATCH lacks an explicit schedule-revision precondition.** Version
   checks exist, but the confirmed drag/resize contract requires both versions.
5. **No Web or Playwright automated tests exist.** Current backend confidence
   must not be generalized to desktop/mobile product confidence.
6. **Focus, review, diary, and growth state is volatile.** Refresh or another
   client loses it; placeholder tables do not make the flows implemented.
7. **Cyber diary referential integrity is insufficient.** A diary cannot
   currently enforce association with both a valid review session and confirmed
   daily brief.
8. **Later Phase 1 dependencies remain absent.** Brief sources, weather,
   exports, durable Worker jobs, Feishu controls, cloud runtime, PWA, backups,
   and cross-device verification still need explicit implementation phases.

This audit is the only deliverable in its commit. Schema, API, and UI work may
start only after the document and implementation slice are confirmed.
