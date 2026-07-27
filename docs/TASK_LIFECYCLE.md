# Task Lifecycle, Scheduling, and Conflict Contract

## Stored Task Model

Lifecycle, scheduling, and deletion are independent:

- `lifecycleStatus`: `open | active | awaiting_outcome | closed | cancelled`
- `scheduleKind`: `none | daypart | exact`
- `deletedAt`: nullable soft-delete timestamp
- `version`: increments for every task mutation
- `scheduleRevision`: increments only when conflict semantics change
- `timeZone`: valid IANA zone, default `Asia/Shanghai`
- `localDate`: PostgreSQL `date`
- `daypart`: `morning | afternoon | evening | null`
- `startAt`, `endAt`: UTC `timestamptz`
- `currentOutcome`: nullable current objective result

Exact scheduling requires both timestamps and `endAt > startAt`. The server
derives `localDate` from `startAt + timeZone`, validates that both endpoints
fall on the same local date, and rejects Phase 1 cross-midnight tasks. Non-exact
tasks have no timestamps. A daypart requires a date and daypart. Ideas and
questions cannot use exact scheduling.

`scheduleRevision` changes when schedule kind, exact interval, exact time zone,
blocking category, cancellation, or deletion changes. It does not change for
title, notes, difficulty, or transitions inside `open | active |
awaiting_outcome`.

## Outcomes and Events

`task_outcomes` is append-only and contains task ID, optional focus session ID,
outcome, objective progress percentage, source, optional note, and timestamp.
Not completed is 0%, complete is 100%, and partial is 1-99%. Closing appends an
outcome and updates the current result in one transaction. Reopening clears the
current result without deleting history.

`task_lifecycle_events` audits lifecycle changes with source and optional
reason. It is not the source of historical task outcomes.

## Conflict Semantics

Blocking conflicts are exact overlaps where both tasks are undeleted and in
`open | active | awaiting_outcome`. Closed overlaps are historical warnings.
Cancelled and deleted tasks, dayparts, and tasks without exact times are
excluded. Adjacent intervals do not overlap.

Conflict acceptances use canonical UUID ordering and have the unique key:

`(task_id_low, task_schedule_revision_low, task_id_high,
task_schedule_revision_high)`

Acceptance rows are append-only. A row is current only when both stored
schedule revisions match the tasks. Accept-all compares an expected conflict
set fingerprint, recomputes the complete set in the transaction, and inserts
all current task pairs atomically. A changed set returns
`409 conflict_set_changed` without partial writes.

Every schedule mutation and acceptance runs in a complete serializable
transaction. SQLSTATE `40001` retries the entire transaction from the beginning
at most three times. Business and validation errors are not retried.

## API Contract

- `POST /api/v1/tasks`: create, with schedule input and optional confirmed
  conflict fingerprint.
- `GET /api/v1/tasks?date=YYYY-MM-DD`: tasks, blocking conflicts, and historical
  overlaps.
- `GET /api/v1/tasks/:id`: detail, versions, current outcome, and outcome
  history summary.
- `PATCH /api/v1/tasks/:id`: edit with required `expectedVersion`.
- `DELETE /api/v1/tasks/:id`: soft-delete a non-active task.
- `POST /api/v1/tasks/:id/cancel`: cancel an open task.
- `POST /api/v1/tasks/:id/reopen`: reopen a closed or cancelled task.
- `POST /api/v1/tasks/:id/outcomes`: append an outcome and close.
- `POST /api/v1/tasks/:id/conflicts/accept-all`: atomically accept the current
  blocking conflict set.

Responses use offset ISO 8601 timestamps plus IANA time zone and derived local
date. Version mismatch returns `409 task_version_conflict`; invalid transition
returns `409 invalid_task_transition`; blocking overlap returns
`409 task_time_conflict` with schedule revisions and a conflict set
fingerprint.

## Test Contract

Tests cover lifecycle/schedule independence, transition validity, version and
schedule-revision increments, time-zone and cross-midnight validation,
append-only outcomes, current-result clearing, overlap boundaries, historical
warnings, atomic multi-conflict acceptance, stale fingerprints, complete
`40001` transaction retries, and idempotent orphaned-active recovery.
