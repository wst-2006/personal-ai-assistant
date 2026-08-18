# Decisions

## 2026-07-27: Single-user v1

The first release has no public registration, multi-tenant model, social graph,
or friends system. Data schemas retain internal ownership fields only where
they reduce future migration cost; no multi-account UI or authorization model
is introduced.

## 2026-07-27: Desktop-first hybrid client

Tauri plus a React PWA is chosen over Electron and a web-only product. It keeps
the Windows application lightweight while allowing a low-cost Android companion
without claiming unreliable PWA background reminders.

## 2026-07-27: PostgreSQL migration guard

All migration commands require a verified connection to
`personal_ai_assistant` as `personal_ai_app` at the configured host, port, and
PostgreSQL major version. This protects other local projects sharing the
PostgreSQL service.

## 2026-07-27: Independent task lifecycle and schedule state

Task lifecycle is `open | active | awaiting_outcome | closed | cancelled`.
Scheduling is represented independently as `none | daypart | exact`, and soft
deletion is independent from both. The application database is the sole source
of truth; external calendars are reminder, synchronization, or import channels.

Exact overlaps are advisory and never auto-adjust a task. Active blocking
overlaps require explicit confirmation, while overlaps with closed tasks are
shown as historical warnings. Conflict confirmations are tied to a canonical
task pair and both tasks' schedule revisions.

## 2026-07-27: Append-only task outcomes

Every task close operation appends a `task_outcomes` record. Reopening clears
the current outcome value but preserves prior outcomes. Subjective satisfaction
remains separate and will be recorded with focus feedback.

## 2026-07-31: Local-first execution

The user's computer is expected to remain on while the application is in use.
The current implementation therefore runs PostgreSQL, API, web, and the
optional reminder worker locally. Cloud servers, cloud PostgreSQL, remote
access, and off-device reminders are not prerequisites and must not be added
to the active implementation plan without a new explicit decision.

## 2026-08-10: Unscheduled retention, backfill facts, growth, and weekly health

An unscheduled formal task belongs to a specific day. If the user checks
“保留以后的未排期任务顺移到下一天”, it is carried to the following day and is
not deleted at the end of the current day. Without that choice, the untouched
unscheduled formal task is automatically removed from active views after the
day ends. The implementation uses the existing recoverable soft-delete model
instead of an irreversible background hard delete; the recycle bin remains the
explicit recovery path. This cleanup never applies to ideas, questions, inbox
entries, backfills, completed/cancelled tasks, or tasks with a real schedule.
The local Worker records one serializable day-end run per Shanghai date so a
restart or retry cannot move or delete the same source date twice.

A backfill preserves the actual start and end selected by the user's timeline
drag. Those timestamps are factual review material only: they do not occupy the
formal schedule, create conflicts, schedule reminders, create focus sessions,
or contribute growth/effective-focus credit.

Growth feedback uses a small, understandable daily formula with visible
variation. Raw task count cannot add points. The score should distinguish weak,
ordinary, and strong days without producing fake precision or clustering every
day near the same maximum.

The original Sunday-open generation rule is superseded by the explicit health
collaboration decision below. Its information hierarchy may learn from
high-quality wellness dashboards, but its content and visual treatment remain
original and consistent with this application's Eastern editorial design.

## 2026-08-16: Explicit weekly health collaboration

Opening Health or reaching Sunday never calls DeepSeek. The Health page owns a
week-scoped conversation ledger: user text is saved before an AI reply is
requested, provider failure leaves that text available for retry, and only an
explicit generation action may create a versioned candidate. The candidate is
not active until the user confirms it. Optional Feishu clarification replies
use the explicit `健康：` prefix and are routed before task intake.

Installed desktop releases carry the complete Drizzle journal. Before starting
API or Worker processes, the desktop checks whether migrations are pending. A
pending migration must pass the fixed database target guard and activity guard,
create a non-empty backup in the user application-data directory, and then run.
An already-current database is neither backed up nor changed, and an older app
runtime refuses to start against a newer migration history.
