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

### Dated unscheduled task at day end

Only `formal + open + scheduleKind:none + localDate:<today + undeleted` enters
this Worker-controlled transition. The policy is a user-authored singleton
setting, not an AI decision:

- `carry_forward`: `localDate D -> D+1`, with `version` and
  `scheduleRevision` incremented;
- `delete_at_day_end`: the task receives `deletedAt`, with the same version
  increments, and becomes recoverable through the normal recycle bin.

The Worker stores one `unscheduled_task_day_end_runs` row per processed local
date in the same serializable transaction as the task mutations. A failure
rolls back both claim and mutations; a repeated poll or restart cannot process
the same date twice. Backfills, non-open tasks, daypart/exact tasks and the
separate inbox tables never enter this transition.

### Recycle retention

Task deletion remains a soft transition while `deletedAt + retentionDays` is in
the future. During that window only an explicit user restore may return the
task to active storage. After the deadline, the local Worker performs one
transactional dependency purge followed by task deletion. There is no restore
transition after that transaction commits.

AI candidates are not stored as task lifecycle states. The user confirms a
candidate before a task is created. Objective outcome remains separate from
subjective satisfaction.

## Focus Session

Creating a new focus session first requires an `open`, formal, exact task with
persisted `startAt` and `endAt`. `none` and `daypart` tasks do not enter this
state machine. Existing current sessions remain readable and recoverable for
backward compatibility.

The normal explicit-confirmation path is:

`scheduled -> preparing -> armed -> running -> ended -> evaluated`

The local Worker enters `preparing` at `startAt - 1 minute`. `Start task` during
that minute performs `preparing -> armed`; `armed -> running` occurs at the
fixed `startAt`. If no start confirmation exists at `startAt`, the session
performs `preparing -> awaiting_late_start`. A desktop start command or an
explicit Feishu AI message while a focus segment still remains performs
`awaiting_late_start -> running` and records the actual start time. Repeated
start commands for `armed` or `running` are idempotent.

Preparation and `awaiting_late_start` are not execution. They do not activate
the task, create focus seconds, or imply completion. Reaching the fixed end
without a valid start performs `awaiting_late_start -> stopped_no_response`,
records one objective `not_completed` outcome, closes the task, and never
creates an evaluation or subjective-feedback record.

Plan-change advice is not a task state. A structured schedule candidate may
target only an `open` task and remains transient. It carries the task version
and schedule revision observed during consultation. Choosing it opens the
normal editable form; no transition or schedule mutation occurs until the user
saves successfully through the existing version/conflict checks. A changed or
locked task invalidates the candidate instead of being overwritten.

Preparation lasts one minute and never starts timing automatically without an
explicit start confirmation. Once `running`, there is no pause, cancel,
reschedule, delete, or early-end transition. Closing the window is a pure
presentation action and does not change session state. Legacy `paused` and
`awaiting_start` rows remain readable only for recovery compatibility and no
new command may create them.

Once preparation begins, the current task's focus structure is immutable;
other tasks remain editable. A late start locates the user's current position
inside the already confirmed structure, marks earlier segments as skipped,
records only the actually executed seconds, and keeps the original fixed
`endAt`. It never compresses, extends, or automatically rearranges the
structure. The user may explicitly skip only the final rest segment; doing so
ends the session and records that decision. Entering `ended` immediately
records the actually executed focus time. For a structured session this is the
sum of executed focus segments and excludes breaks; for an unstructured legacy
session it is the recorded active time.

Entering `ended` replaces the desktop timer composition with an independent
evaluation composition. This is a presentation change over the same persisted
session, not a second session or inferred state. The evaluation records an
objective outcome and progress independently from subjective satisfaction, with
an optional user-authored process note. Only a successful evaluation command
performs `ended -> evaluated`; closing or hiding the window leaves the session
in `ended` and allows the tray to restore it. Evaluation records outcome,
progress and satisfaction but does not clear or recalculate the already
recorded focus duration.

Every eligible exact task has four revision-bound durable transitions: T-15
creates one Feishu reminder card, T-1 updates the same card with `Start task`
and opens desktop preparation, T0 disables an unpressed start control and
enters `awaiting_late_start`, and fixed-end finalizes a never-started task as
missed. The original Feishu message ID is persisted so `started`,
`returned_to_unscheduled`, `cancelled`, and `missed` replace the original
controls instead of leaving stale buttons.

The reminder card's `Other arrangement` transition changes an eligible open
task from `exact` to `none` and returns it to the unscheduled list. Cancellation
uses `cancel_requested -> cancelled`, where the first action only produces a
confirmation card and the second action performs the lifecycle transition.
Neither action is valid after `running` begins.

Focus structures are durable candidates tied to the task version and
`scheduleRevision`. A continuous block of 30 minutes is one uninterrupted
focus segment. A block of 60 minutes or longer reserves a final rest segment,
defaulting to 5 minutes and allowing 5-15 minutes. Segmented structures must
alternate focus and rest, every focus segment must have its own 5-15 minute
rest segment, and all segments must exactly fill the fixed task interval.

## Review, Brief, and Diary

Review sessions are independently durable:

`not_opened -> review_open -> review_has_message`

Only a user-authored review-page message performs
`review_open -> review_has_message`. A server-generated AI response is a
separate persisted turn and never satisfies the review prerequisite by itself.
The user may save without AI, explicitly request a reply, or retry a failed
reply without duplicating or losing the saved user message.

An explicit finish-and-generate action then follows:

`review_has_message -> brief_generating -> brief_ready -> diary_draft ->
diary_saved`

The transition to `brief_generating` is unavailable without a review-page
message. Normal chat, Work Buddy, and forwarded Feishu messages cannot create
a brief. A saved diary must reference both the review session and a confirmed
brief.

`brief_generating` sends only bounded local review/task context to the
server-side configured writer. External RSS/Atom subscriptions, web search and
Work Buddy imports are disabled. The structured result is validated before
persistence; a provider or schema failure returns a recoverable error and
leaves the previous confirmed brief intact. Regenerating a confirmed brief
creates a new draft state until the user confirms it again.

`diary_draft` contains editable title, body, and six-dimensional review data.
Mainline progress, overall execution, and focus quality start from database-
derived values but may be adjusted by the user. Energy state, wellbeing
maintenance, and growth gained remain `null` until the user actively rates
them. `diary_saved` persists these values inside the validated diary content;
refresh and growth aggregation read the saved values rather than rebuilding
manual ratings. Older diary rows without the optional radar object remain
readable and receive current derived defaults until they are saved again.

## Health Reference

Health collaboration is a separate durable ledger, not a plan state:

`empty -> user_message_saved -> assistant_reply_saved`

Provider failure after `user_message_saved` leaves that user message intact.
Retrying requests only the missing assistant reply and does not append the user
message again. One in-flight reply is shared per conversation. Messages are
bound to one `weekStart`; app messages may trigger a Feishu clarification, and
explicit `健康：` Feishu replies return to the same current Shanghai week.
Neither message state creates, replaces, confirms or edits a health plan.

AI candidate generation begins only from an explicit Health-page action and
shares one in-flight request per week. Opening the page or reaching Sunday is
not a generation transition. Provider timeout, invalid JSON/schema output or
provider rejection leaves the week in its previous plan state.

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

## Long-range plan collaboration

Long-range plan content uses `draft -> candidate_visible -> draft_applied ->
saved`. AI organization only creates `candidate_visible`; it cannot persist the
plan or create tasks. Discarding the candidate returns to the untouched draft.
Applying copies the candidate into the editable draft, and only the normal save
operation persists it. Permanent plan deletion first detaches generated tasks,
then removes task-tree candidates, milestones and the plan in one transaction.
