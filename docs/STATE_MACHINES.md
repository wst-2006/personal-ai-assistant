# State Machines

## Task

Stored tasks use a lifecycle that is independent from scheduling:

`open -> active -> awaiting_outcome -> closed`

- `open -> closed` records an outcome without a focus session.
- `open -> cancelled` explicitly cancels a task.
- `closed | cancelled -> open` reopens a task and clears only its current
  outcome. Append-only outcome history is retained.
- Any non-active task can be soft-deleted. Deletion is independent from the
  lifecycle.
- A recovery process may move an orphaned `active` task to
  `awaiting_outcome`; this transition is idempotent and records a system event.

Schedule kind is separate: `none | daypart | exact`. Transitions inside the
blocking lifecycle group (`open | active | awaiting_outcome`) do not change the
schedule revision. Entering or leaving `closed`, `cancelled`, or deleted state
does.

AI candidates are not stored as task lifecycle states. The user confirms a
candidate before a task is created. Objective outcome remains separate from
subjective satisfaction.

## Focus Session

The normal confirmed execution path is:

`scheduled -> preparing -> running -> ended -> evaluated`

`reminded` is a separate waiting-for-response entry state, not a mandatory
step in every session. A positive response moves to `scheduled` when the exact
task has not started yet, or directly to `preparing` when the task interval is
already in progress. "Other arrangement" ends that reminder interaction and
opens a plan-change conversation without changing the stored task.

Preparation lasts one minute and then starts timing automatically. The user
may explicitly skip the remaining preparation countdown and start immediately.
There is no pause or manual restart in the current API, UI, or state machine.
Legacy `awaiting_start`, `paused`, and pause timestamp columns remain readable
only for historical compatibility; new operations do not create those states.

Once preparation begins, the current task's focus structure is immutable;
other tasks remain editable. A late start locates the user's current position
inside the already confirmed structure, marks earlier segments as skipped,
records only the actually executed seconds, and keeps the original fixed
`endAt`. It never compresses, extends, or automatically rearranges the
structure. The user may explicitly skip only the final rest segment; doing so
ends the session and records that decision. Only `partial` and `complete`
evaluations count executed focus-segment seconds as effective focus time.

Every eligible exact task has two revision-bound durable reminder jobs: a
start reminder available 15 minutes before `startAt`, and a non-response
follow-up due five minutes after `startAt`. An explicit start or "other
arrangement" response cancels the follow-up. If neither the app nor Feishu
receives a response, the local Worker creates or stops a `stopped_no_response`
session, appends one system `not_completed` outcome, and closes the task. This
works while the main window is closed as long as the local desktop runtime and
Worker are running.

Focus structures are durable candidates tied to the task version and
`scheduleRevision`. A continuous block of 30 minutes is one uninterrupted
focus segment. A block of 60 minutes or longer reserves a final rest segment,
defaulting to 5 minutes and allowing 5-15 minutes. Segmented structures must
alternate focus and rest, every focus segment must have its own 5-15 minute
rest segment, and all segments must exactly fill the fixed task interval.

## Review, Brief, and Diary

Review sessions are independently durable:

`not_opened -> review_open -> review_has_message`

An explicit finish-and-generate action then follows:

`review_has_message -> brief_generating -> brief_ready -> diary_draft ->
diary_saved`

The transition to `brief_generating` is unavailable without a review-page
message. Normal-chat brief generation is a separate path that ends at
`brief_ready` and cannot create a diary. A saved diary must reference both the
review session and a confirmed brief.

## Health Reference

Weekly plans use explicit durable states:

`candidate -> active -> superseded`

A candidate may instead transition to `cancelled`. Creating a candidate never
changes the active week. Template, AI, manual, and sleep-based candidates store
the health-profile version used to create them. A revision of an active week
also stores `basedOnPlanId` and `basedOnPlanVersion`.

Confirmation checks the candidate version, current profile version, and current
active-plan identity/version inside one serializable transaction. If any base
has changed, the candidate remains non-active and the API returns a conflict;
it never silently replaces the newer plan. Confirming one candidate supersedes
the previous active plan and cancels other still-pending candidates for that
week.

Only an `active` daily reference is exposed to the Today summary. Asking about
food or movement opens an ordinary AI conversation but is not a plan state
transition. “Convert to task” opens an unsaved formal-task form; only the
separate task-form confirmation creates the task, and the health reference is
not changed or marked complete.
