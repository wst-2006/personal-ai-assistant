# Personal AI Assistant

A single-user, desktop-first task management and learning companion. The first
release uses a React PWA for the shared interface, a Fastify API, PostgreSQL,
and a future Tauri Windows shell.

## Prerequisites

- Node.js 24 and pnpm 11
- PostgreSQL 18.4 running locally during development
- A local `.env` copied from `.env.example` with the `personal_ai_app` password

## Local setup

```powershell
pnpm install
Copy-Item .env.example .env
pnpm db:generate
pnpm db:migrate
pnpm dev:api
pnpm dev:web
```

`pnpm db:migrate` checks database name, role, host, port, and PostgreSQL major
version before applying any migration. It refuses any target other than the
configured `personal_ai_assistant` development database.

## Workspace

- `apps/web`: responsive React PWA interface
- `apps/api`: Fastify API and future integration entry point
- `apps/desktop`: Tauri Windows-shell configuration
- `packages/domain`: shared states and validation schemas
- `packages/db`: Drizzle schema, migrations, and migration guard
- `docs`: product, architecture, roadmap, state-machine, and decision records
