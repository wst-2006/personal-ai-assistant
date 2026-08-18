# Focus Schema V2 Migration Plan

Status: applied and verified on August 10, 2026. The live migration is
`0024_curvy_nemesis.sql` through `0027_dazzling_cargill.sql`; the reviewed SQL
files remain as human-readable design/rollback references.

Reviewed SQL drafts:

- `FOCUS_SCHEMA_V2_PENDING.sql`
- `FOCUS_SCHEMA_V2_ROLLBACK_PENDING.sql`

## Purpose

Support the Golden Spec focus rules without rewriting historical execution:

- continuous 30-minute structures are `30 focus + 0 break`;
- continuous 60-minute-or-longer structures reserve a final 5-15 minute break;
- segmented structures contain at least two focus segments, begin with focus,
  alternate focus and break, and give every focus segment its own final break;
- segmented focus segments remain at least 30 minutes;
- pause columns remain compatibility-only; new API/UI/state-machine operations
  never create a paused session or a manual restart;
- repeated client commands are idempotent and auditable.

## Verified live-data baseline (2026-08-10)

- no focus session is currently preparing, running, or paused;
- one active structure is a valid continuous `55 + 5` structure;
- one cancelled historical structure contains two focus and two break segments;
- historical structures and segment runs must not be rewritten.

## Proposed schema changes

1. Add `focus_structures.mode` with values `continuous | segmented` (applied).
2. Backfill mode from the number of focus segments: one is continuous, two or
   more is segmented.
3. Replace the per-segment focus minimum check with a database floor of 25
   minutes. Domain/service validation keeps the stricter 30-minute minimum for
   segmented structures because a row-level PostgreSQL CHECK cannot validate
   sibling segment topology.
4. Add `focus_sessions.paused_total_seconds integer not null default 0`.
5. Add `focus_session_segment_runs.paused_seconds integer not null default 0`.
6. Add `focus_session_operations`, an append-only idempotency ledger containing
   `command_id`, session, operation, expected/resulting versions, result state,
   and timestamp. A command ID can be applied only once.
7. Add missing indexes needed by this workflow:
   `focus_sessions(focus_structure_id)`, `task_feedback(task_id)`, and
   `task_outcomes(focus_session_id)`.

## Runtime invariants after migration

- the database stores broad row safety; Domain and API transactions validate
  the complete ordered topology;
- an active structure is immutable once preparation starts;
- historical paused rows remain readable, but are not actionable by new
  commands;
- reopening a five-minute no-response session is allowed only while the task's
  original `end_at` is still in the future and does not repeat preparation;
- historical cancelled/evaluated structures remain readable even if their old
  topology is no longer valid for new candidates.

## Migration order

1. Stop the desktop runtime through the tray so API and Worker cannot write.
2. Run the connection guard and runtime-activity preflight.
3. Create a custom-format `pg_dump` backup under `backups/migrations`.
4. Add nullable columns/table/indexes.
5. Backfill `focus_structures.mode` and validate counts before setting NOT NULL.
6. Replace the segment duration constraint.
7. Add new non-negative checks and idempotency constraints.
8. Run the expanded schema verifier and focused migration assertions.
9. Start API and Worker only after verification succeeds.

## Runtime follow-through

The Domain/API now writes the structure `mode` on every new candidate and
accepts an optional UUID `commandId` for create, start, countdown-skip,
reminder response, end, final-break skip, and evaluation. A repeated command
ID replays the persisted result instead of duplicating session, task, timer,
outcome, or feedback writes. Pause/resume/manual-restart remain prohibited;
legacy pause columns are compatibility data only.

## Refusal conditions

The migration must stop before any DDL when:

- the target is not `personal_ai_assistant` / `personal_ai_app`;
- any session is preparing, running, or paused;
- a focus-timer or reminder job is currently processing;
- another application/API/Worker database connection is still open;
- `pg_dump` is unavailable or the backup is empty;
- mode backfill finds a structure with zero focus segments;
- the live schema differs from the expected pre-migration contract.

## Rollback

Before the new runtime writes V2 data, the additive migration can be reverted by
dropping the new ledger/table/columns/indexes and restoring the former segment
duration constraint. If any V2 focus command or 25-minute focus segment has been
written, do not attempt a partial SQL downgrade. Stop the runtime and restore
the pre-migration custom backup, then run `pnpm db:verify` before restarting.

No rollback operation is automatic because restoring a database is destructive
and must be separately confirmed.
