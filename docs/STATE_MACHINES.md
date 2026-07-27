# State Machines

## Task

`draft -> awaiting_confirmation -> scheduled | unscheduled -> active ->
awaiting_outcome -> closed`

The user can explicitly cancel or reopen a task. Objective outcome is separate:
`not_completed | partial | complete`. Subjective satisfaction is also separate:
`satisfied | neutral | dissatisfied`.

## Focus Session

`scheduled -> reminded -> preparing -> awaiting_start -> running <-> paused ->
ended -> evaluated`

"Other arrangement" ends the session and opens a plan-change conversation. A
five-minute non-response ends the session with a provisional `not_completed`
outcome. A manual restart skips preparation and begins from the current time.
Only `partial` and `complete` evaluations count accumulated active minutes as
effective focus time.

## Review, Brief, and Diary

`not_opened -> review_open -> review_has_message -> brief_generating ->
brief_ready -> diary_draft -> diary_saved`

The transition to `brief_generating` is unavailable without a review-page
message. Normal-chat brief generation is a separate path that ends at
`brief_ready` and cannot create a diary.
