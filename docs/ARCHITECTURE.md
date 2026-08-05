# Architecture

## Chosen Architecture

The project is a pnpm monorepo. A responsive React interface provides the
shared desktop and narrow-screen UI; it is not currently shipped as a PWA.
Tauri wraps the same interface for the Windows-first experience. A Fastify
API owns business operations, provider adapters, and server-side secrets. A
separate worker will process durable reminders and retries. PostgreSQL stores
application state and the future job queue.

## Boundaries

- `apps/web` owns presentation and local interaction only.
- `apps/api` owns use cases, authorization boundary, API contracts, and
  provider orchestration.

The standalone Windows bundle includes the API/Worker runtime and only a
secret-free `.env.example`. On first launch Tauri creates the user-owned
`%APPDATA%\\com.personalai.assistant\\.env`; database credentials and provider
keys are entered there and are never copied into the installer or committed to
the repository.
- `packages/domain` owns explicit state values and input schemas.
- `packages/db` owns PostgreSQL schema, migrations, and migration safety guard.
- External model, search, weather, Feishu, and calendar clients implement
  replaceable adapters. Business logic must not depend on a provider SDK.
- Health profile, weekly-plan, daily-reference, and sleep-analysis records use
  dedicated database tables and API services. They are never simulated through
  task, focus, outcome, or growth tables. The Today surface reads only the
  confirmed daily reference, while candidate creation and confirmation stay in
  the Health module.

## Database Safety

Development uses the local PostgreSQL service but only the
`personal_ai_assistant` database and `personal_ai_app` role. A migration guard
queries the connected server before every migration and rejects a mismatch in
database name, role, address, port, or PostgreSQL major version. The current
release is local-first: API, web, worker, and PostgreSQL run on the user's
Windows computer. Cloud databases, server purchases, and data-directory
copies are out of the current implementation scope.

## External Integrations

DeepSeek is called only by the API. Search results and weather responses are
normalized and stored with source metadata before a brief is composed. Feishu
uses its official long connection for local inbound text/card events and
outbound reminders; an encrypted HTTP callback remains an explicit fallback
for card actions only. Inbound text is first stored as a deduplicated candidate
and never creates a task until the owner confirms its card. Huawei Calendar
remains an unimplemented adapter until its capability is verified.

Sleep screenshot analysis is an optional vision-adapter capability. When no
verified image-capable model is configured, the API exposes that capability as
unavailable and stores neither the uploaded image nor a fabricated result.
