# Implementation Audit

Audit date: 2026-07-31
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
have a real PostgreSQL-backed browser acceptance path. The richer diary and
local reminder recovery requirements remain outstanding.

## 3. Functional Audit Matrix

| Capability | Requirement source | Status | Confidence | Current code / page | API / tables | Automated evidence | Missing work and next step |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Secure project/database baseline | Architecture, AGENTS | Fully implemented | High | `.gitignore`, DB guard/config | `personal_ai_assistant`, `personal_ai_app` | migration guard tests; `pnpm db:verify` | Keep the guard mandatory for every migration and E2E cleanup. |
| Task lifecycle and optimistic versioning | Product Spec, State Machines, Task Lifecycle | Partially implemented | High for backend and core browser paths | Today task actions and lifecycle service/repository | Task CRUD/action routes; `tasks`, lifecycle events, outcomes | service, route, repository, persistence and browser E2E tests | Expand visual acceptance for exceptional/recovery paths. |
| Append-only task outcomes and reopening | Product Spec, State Machines | Partially implemented | High for backend and core browser paths | Today outcome form, reopen actions and focus evaluation | outcome and reopen routes; `task_outcomes` | outcome history and browser E2E tests | Add richer outcome history display and recovery-state acceptance. |
| Exact-time conflict detection and retention | Product Spec, Task Lifecycle | Partially implemented | High for backend and browser core path | Spatial blocks, conflict prompt and explicit retention in Today | task create/update/accept APIs; `task_conflict_acceptances` | overlap, history, stale set, rollback and browser E2E tests | Add visual treatment for complex multi-lane conflict sets. |
| Full manual task creation | Product Spec, Roadmap | Partially implemented | High for mapped core fields and browser path | Dedicated formal-task dialog with title, schedule/date/time and notes; explicit form submit does not call AI | `POST /tasks`; `tasks` | API/domain and browser E2E tests | Add accessibility and error-state coverage for all schedule combinations. |
| Quick task capture | Product Spec, Design Review | Partially implemented | High for core path | Quick capture creates a title-only unscheduled task targeted to the selected date and can be completed later | `POST /tasks`; `tasks` | API and browser E2E coverage through Today | Add a distinct completion affordance in the unscheduled region. |
| Independent ideas/questions | Product Spec | Fully implemented | High for confirmed conversion and stale-version recovery | Idea/question capture writes separate inbox entries; conversion requires confirmation, creates a formal task only after submit, links `source_inbox_entry_id`, preserves the source with `converted_at`, and keeps the form when a stale version is rejected | inbox routes; `inbox_entries`, `tasks.source_inbox_entry_id` | API/domain tests and isolated PostgreSQL/browser conversion + stale-version E2E | Add broader conflict-error messaging only if future inbox editing introduces more concurrent mutations. |
| AI candidate confirmation | Product Spec, Design Review | Partially implemented | Medium | AI drawer parses then asks for confirmation; formal tasks use the current task contract while ideas/questions use the independent inbox API | parse, task and inbox routes; `tasks`, `inbox_entries` | parser route and shared contract tests | Add browser confirmation/error coverage and an editable correction flow. |
| Real Today timeline | Product Spec, Design Review | Partially implemented | High for core schedule editing; medium for full interaction | 24-hour coordinate axis, current-time marker, daypart/unscheduled areas, creation, drag/resize and spatial overlaps | task APIs; `tasks`, conflict acceptances | desktop and 390px browser E2E | Add keyboard-accessible movement and richer conflict explanations. |
| Timeline persistence and cross-client reading | Product Spec, Architecture | Partially implemented | High for refresh and local database read | Timeline reads the database-backed task list | task list API; `tasks` | DB persistence and browser refresh tests | Cross-device/cloud synchronization remains unimplemented. |
| Focus session workflow | Product Spec, State Machines, Roadmap | Partially implemented | High for core persistence and desktop/390px browser paths; medium for external interaction | API-backed preparation, reminder response, auto-start, fixed-end timing, end, objective outcome and subjective feedback; exact tasks transactionally schedule a 15-minute reminder | focus-session routes; `focus_sessions`, `task_feedback`, `task_outcomes`, `reminder_jobs`, `focus_structures` | domain validation, database reminder verification, desktop browser E2E and 390px mobile focus E2E | Durable structure execution, local five-minute recovery and explicit plan-change conversation remain. Pause/resume and manual restart are intentionally excluded by the current product decision. Remote delivery is deferred. |
| Review session workflow | Product Spec, State Machines | Partially implemented | High for local PostgreSQL/browser persistence; medium for full workflow | Durable daily review session, message restore, real task/outcome/focus/feedback context and brief handoff | review routes; `review_sessions`, `review_messages` | domain validation, guarded integration verification, review PostgreSQL/browser E2E and build checks | Software conversation context and richer review prompts remain. |
| Daily brief | Product Spec, Roadmap | Partially implemented | High for local review/standalone persistence and browser edit/confirm/export; medium for complete provider/location coverage | Review generates, edits, regenerates, confirms, exports and reloads a persisted brief with finance, AI, technology, task-expansion, humanities, weather and location sections. A normal conversation can now use a separate explicit AI-drawer action to create a confirmed standalone brief with `reviewSessionId = null`; it is listed, restored after refresh and exportable, and never qualifies for a cyber diary. Confirmed review content remains read-only until the user explicitly enters edit mode; edits persist through the brief API. | `brief-service.ts`, `brief-routes.ts`, `App.tsx`, `ReviewWorkspace.tsx`; `daily_briefs.content`, `daily_briefs.sources`, nullable `daily_briefs.review_session_id` | domain contract tests, API route tests, review and standalone PostgreSQL/browser E2E (including 390px), provider tests and build checks | Add opted-in device location and keep standalone briefs excluded from diary prerequisites. |
| Cyber diary | Product Spec, State Machines | Partially implemented | High for the local persistence, month-history and derived-data browser paths; medium for the complete diary experience | API-backed month navigation, historical date selection, draft, save, reload, edit and text export. Saving requires a same-day review session with at least one message and a confirmed brief linked to that review. The page derives task/focus cards, raw and effective focus, location/weather, six daily metrics, state color and the day's tree from PostgreSQL records and the linked confirmed brief. | diary month/day routes, `diary-service.ts`, `DiaryWorkspace.tsx`; `cyber_diaries`, `review_sessions`, `review_messages`, `daily_briefs`, task/focus/outcome/feedback tables | diary domain and day-data calculation tests; guarded browser E2E for month switching, save/reload/export/390px with UUID-only cleanup | Decide whether final diary exports need an immutable derived-data snapshot rather than authoritative live derivation. |
| Growth and statistics | Product Spec, Roadmap, Design Review | Partially implemented | Medium for the seven-day data path; low for long-term trends | Real seven-day focus trend, subjective feedback counts, daily state grid, six metrics, points and tree feedback | `growth-routes.ts`, `growth-service.ts`, `GrowthWorkspace.tsx`; task/focus/outcome/feedback/review tables | guarded API contract verification; desktop browser visual verification | Add month views, persistent derived snapshots only if justified, and dedicated browser/API automated tests. |
| Search, weather, location, export | Product Spec, Roadmap | Partially implemented | High for Tavily-backed local brief generation and export; medium for user-entered location | Tavily is the preferred optional LLM-oriented provider, Brave is the secondary optional provider, and free GDELT remains the no-key fallback. Open-Meteo geocoding/weather is server-only; location is entered per day, and source/snapshot metadata is retained. Generated search sections are bounded by the brief contract before persistence. | `brief-providers.ts`, `ReviewWorkspace.tsx`; `daily_briefs.content`, `daily_briefs.sources` | provider tests, live Tavily standalone PostgreSQL/browser E2E, review browser E2E and type checks | Add opted-in device location and broader provider-failure acceptance. |
| Local Worker and optional Feishu | Architecture, Roadmap | Partially implemented | High for guarded local queue contract; medium for adapter/webhook tests; low for live delivery | Exact-task writes transactionally create/update/cancel revision-bound reminder jobs. The local worker claims atomically, rejects stale tasks, retries failures, obtains Feishu tenant tokens and sends interactive cards when configured. | `reminder_jobs`; `reminder-scheduler.ts`, `apps/worker`, `feishu-webhook.ts` | migration guard/schema and database persistence verification; Worker/provider/webhook tests and builds | Complete local five-minute no-response recovery and local end-to-end delivery if enabled. Cloud deployment is out of scope. |
| Long-range planning and AI task trees | Roadmap, Product Spec | Not implemented | High | no month/term/year views | no plan/tree API or tables | none | Add only after usable daily core; AI-created trees require explicit confirmation before writes. |
| PWA, cross-device sync, backup | Architecture, Roadmap | Not implemented | High | React web exists but has no PWA manifest/service worker | database API provides a future base only | none | Keep remote sync and cloud deployment deferred; add local backup/export and recovery only when the local core is stable. |
| User profile and AI preferences | Product Spec privacy rules | Not implemented | High | no settings model | no API/tables | none | Add explicit user-controlled preferences only; no surveillance or inferred personality profile. |

## 4. Current Page to Real Function Mapping

| Page/surface | What is real today | What is only presentation/local state | Honest status |
| --- | --- | --- | --- |
| Today | Database-backed task/inbox capture, complete form, 30-minute time axis/interactions, blank-slot creation, drag/resize, conflict retention, lifecycle actions and direct task-to-focus handoff | Rich keyboard manipulation and cloud synchronization | Partially implemented |
| Focus | Reads real tasks and durable focus sessions; preparation, fixed-end timing, raw/effective time, objective result and subjective feedback write through API and survive refresh | Durable structure execution, cloud/offline reminder delivery, rich plan-change conversation, and production mobile acceptance remain | Partially implemented |
| Review | Opens/restores a daily review session, saves messages, reads real context, generates/edits/confirms/regenerates/exports a brief, and keeps confirmed brief edits persisted through refresh | Software conversation context and richer guided prompts | Partially implemented |
| Diary | Reads its review/brief prerequisites, supports database-backed month navigation and historical selection, saves, restores, edits and exports a persisted diary with server-side link validation. Real task/focus cards, weather/location, six metrics, daily state color and tree feedback are API-derived. | Product decision on an immutable final export snapshot remains | Partially implemented |
| Growth | Reads seven-day database-derived focus, outcomes, feedback and review signals | No month/year exploration or dedicated automated acceptance yet | Partially implemented |
| AI drawer | Server-side model parsing returns a candidate without an immediate write; user confirms before save. A separate explicit standalone-brief action persists a confirmed brief and restores it on reopen/refresh without creating a review or diary | no durable conversation context or long-range task-tree confirmation flow | Partially implemented |
| Desktop shell/Tauri | Tauri development command and the standalone Windows executable start the bundled API/Worker runtime; the NSIS installer is rebuilt and health-checked | A fresh installation creates `%APPDATA%\\com.personalai.assistant\\.env` from a secret-free template; the user must fill local database settings before first launch | Partially implemented |
| 390px mobile | responsive timeline and formal-task dialog; mobile smoke test passes | cross-device/cloud persistence and focus/review/mobile visual acceptance | Partially implemented |

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
2. **Timeline keyboard accessibility remains incomplete.** Pointer creation,
   drag/resize and explicit conflict retention are verified; keyboard
   manipulation and complete accessible conflict detail are not yet implemented.
3. **Retired task metadata is archived, not exposed.**
   Existing values remain queryable only through `task_legacy_metadata`; new
   task requests containing those keys are rejected.
4. **Cross-device confidence is not established.** Local refresh and browser
   interaction are verified; cross-device synchronization is intentionally
   outside the current local-first scope.
5. **Browser coverage remains focused.** Playwright now covers Today, Focus,
   Review/Brief persistence and the diary path; ideas/questions conversion,
   guided software context and broader provider failures still need dedicated
   acceptance.
6. **Growth feedback is intentionally basic.** It now derives from persisted
   records, but month/year trends and a deeper statistical model are not yet
   implemented.
7. **Cyber diary finalization semantics need one product decision.** Referential
   integrity, month history, task/focus cards, weather/location, six metrics,
   state color and tree data are verified against the guarded database. The
   current page derives those signals from authoritative records; an immutable
   snapshot for finalized exports has not been specified or implemented.
8. **Later dependencies remain absent.** Local Feishu controls, PWA, backups,
   and cross-device verification still need explicit implementation phases;
   cloud runtime is deferred and the durable local Worker queue now exists.

This audit records the approved contract and current verification status. The
live implementation now includes the guarded legacy-field migration and real
browser coverage for the reduced task form.
