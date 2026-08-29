# Feature Audit Goal

## Current Goal
Audit the complete single-user application and fix confirmed bugs that can silently skip work, advance state without explicit confirmation, or break local features when optional integrations fail.

## Non-Goals
- No redesign or unrelated visual refactor.
- No deletion or rewriting of existing user data.
- No public registration, multi-user, surveillance, or automatic plan changes.

## Invariants
- Product spec and explicit state machines remain authoritative.
- AI, Feishu, database, reminders, and desktop runtime stay behind module boundaries.
- User approval remains required before plan changes and focus starts.
- API keys remain server-only.

## Progress
- Previous reminder/provider coupling bug was fixed and tested.
- Current work: full module audit.

## Next
Inventory routes, workers, desktop commands, and UI workflows; then run focused tests and repair confirmed defects.

## Anchor
1/20
