# Architecture

## Chosen Architecture

The project is a pnpm monorepo. A React PWA provides shared desktop and mobile
UI. Tauri wraps the same interface for the Windows-first experience. A Fastify
API owns business operations, provider adapters, and server-side secrets. A
separate worker will process durable reminders and retries. PostgreSQL stores
application state and the future job queue.

## Boundaries

- `apps/web` owns presentation and local interaction only.
- `apps/api` owns use cases, authorization boundary, API contracts, and
  provider orchestration.
- `packages/domain` owns explicit state values and input schemas.
- `packages/db` owns PostgreSQL schema, migrations, and migration safety guard.
- External model, search, weather, Feishu, and calendar clients implement
  replaceable adapters. Business logic must not depend on a provider SDK.

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
will expose inbound commands and outbound reminders through a signed webhook
adapter. Huawei Calendar remains an unimplemented adapter until its capability
is verified.
