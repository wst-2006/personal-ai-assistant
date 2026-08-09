# Personal AI Assistant

A single-user, desktop-first task management and learning companion. The first
release uses a React interface inside a Tauri Windows shell, a Fastify API,
PostgreSQL, and an optional local reminder worker.

## Prerequisites

- Node.js 24 and pnpm 11
- PostgreSQL 18.4 running locally during development
- A local `.env` copied from `.env.example` with the `personal_ai_app` password

## Local-first setup

```powershell
pnpm install
Copy-Item .env.example .env
pnpm db:generate
pnpm db:migrate
pnpm dev:local
```

`pnpm dev:local` starts the API, web app, and local reminder worker together.
The worker stays idle when optional Feishu values are empty; task, focus,
review, brief, diary, and growth features do not require a cloud server.

Open the web app at `http://127.0.0.1:5173` and the API health check at
`http://127.0.0.1:3000/health`. To run one process separately, use
`pnpm dev:api`, `pnpm dev:web`, or `pnpm dev:worker`.

For the Windows desktop shell during development, use `pnpm dev:desktop`.
Tauri starts the same local API, web app, and worker before opening the native
window. `pnpm build:desktop` prepares the bundled Node/API/Worker runtime,
builds the Tauri application, rebuilds the NSIS package in safe in-place update
mode, and verifies the installer before it is released.

The installed application keeps the API and Worker alive while its main window
is hidden in the tray, starts at Windows login, and stops its managed processes
only when the user explicitly exits from the tray. Private configuration stays
in `%APPDATA%\com.personalai.assistant\.env`; it is never bundled into the
installer. Source-tree release launches remain available for development when
the repository runtime is present.

The current release is intentionally local-first. Do not create a cloud
database, purchase a server, or copy the local PostgreSQL data directory.
Remote deployment is deferred until a separate product decision explicitly
requires remote access or reminders while the computer is off.

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
