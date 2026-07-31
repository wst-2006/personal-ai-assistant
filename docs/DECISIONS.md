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
