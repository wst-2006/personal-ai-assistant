# Product Specification

## Purpose

The product is a single-user personal task manager and learning companion. The
user enters goals, tasks, time estimates, difficulty, completion status, and
review thoughts. AI organizes natural-language input, identifies obvious
conflicts, offers optional adjustments, recommends focus structures, and
creates search-backed daily briefs when explicitly requested.

## Non-negotiable Behavior

- The user confirms natural-language task extraction before it is stored.
- Form entries that are already complete do not call AI.
- Tasks, ideas, and questions are distinct entry types.
- AI may advise on conflicts and changes but never changes a confirmed plan
  without an explicit user decision.
- The application database is the authoritative task and schedule source.
  External calendars may remind, synchronize, or import but do not override it.
- Exact overlapping tasks are reported and never moved automatically. The user
  may explicitly retain the overlap. Tasks without exact times are excluded.
- Phase 1 exact tasks cannot cross midnight. Timestamps are stored in UTC with
  an IANA time zone; the default is `Asia/Shanghai`.
- Task outcome and subjective satisfaction are independent records.
- Task outcomes are append-only; reopening clears only the current result.
- Only partial and complete outcomes contribute effective focus time.
- A review session may be saved without a brief. A cyber diary requires a
  review message and references both its review session and a confirmed brief.
- A normal conversation may generate a brief only when explicitly requested;
  it never generates a cyber diary by itself.
- The product does not monitor user behavior, mood, camera, microphone, or
  external AI history. It does not perform personality analysis.

## Scope

First release: task creation, daily timeline and conflict warnings, focus
sessions, review mode, brief and diary workflow, search/weather adapters,
export, basic trends, and an optional local Feishu reminder worker while the
computer is running. Cloud deployment, remote access, and cloud-backed
reminders are explicitly deferred. File parsing, Huawei Calendar integration,
native Android work, and advanced game visuals remain future work.

Initial Feishu controls are reminder delivery, start, other arrangement, and
opening the corresponding task. Complex editing and full review remain in the
application. AI-created long-range task trees require explicit confirmation.
The growth garden remains basic data-driven feedback in Phase 1.
