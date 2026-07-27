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
