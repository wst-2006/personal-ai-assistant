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
- Task outcome and subjective satisfaction are independent records.
- Only partial and complete outcomes contribute effective focus time.
- A cyber diary requires at least one message from the review page on that date.
- A normal conversation may generate a brief only when explicitly requested;
  it never generates a cyber diary by itself.
- The product does not monitor user behavior, mood, camera, microphone, or
  external AI history. It does not perform personality analysis.

## Scope

First release: task creation, daily timeline and conflict warnings, focus
sessions, review mode, brief and diary workflow, search/weather adapters,
export, basic trends, and cloud-backed Feishu reminders. File parsing, Huawei
Calendar integration, native Android work, and advanced game visuals remain
future work.
