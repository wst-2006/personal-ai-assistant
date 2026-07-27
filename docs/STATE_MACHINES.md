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

`scheduled -> reminded -> preparing -> awaiting_start -> running <-> paused ->
ended -> evaluated`

"Other arrangement" ends the session and opens a plan-change conversation. A
five-minute non-response ends the session with a provisional `not_completed`
outcome. A manual restart skips preparation and begins from the current time.
Only `partial` and `complete` evaluations count accumulated active minutes as
effective focus time.

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
