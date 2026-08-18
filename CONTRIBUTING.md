# Contributing

Personal AI Assistant is currently a local-first, single-user project. The
repository is being prepared for public review; contributions should preserve
that boundary unless the product specification is explicitly changed.

## Before making a change

1. Read `AGENTS.md`, `docs/PRODUCT_SPEC.md`, and `docs/STATE_MACHINES.md`.
2. Keep AI, database, reminder, and external-provider code behind their current
   module boundaries.
3. Use fictional tasks and throwaway credentials for tests. Never commit `.env`
   or a database dump.
4. Do not change a confirmed plan automatically or infer task state from chat
   text.

## Local setup

```powershell
corepack enable
corepack pnpm install --frozen-lockfile
Copy-Item .env.example .env
corepack pnpm db:preflight
corepack pnpm db:migrate
```

The database guard only permits the configured `personal_ai_assistant`
development database. Do not point migrations at another database.

## Verification

Run the smallest relevant checks first, then the full local verification when
the change is ready:

```powershell
corepack pnpm check
corepack pnpm test:unit
corepack pnpm test
corepack pnpm build
```

`test:unit` runs the domain and database-schema suites without personal
credentials. The API and Worker suites include database-backed integration
tests, so the full `test` command requires the configured `.env` and a
prepared development database.

For desktop changes, also run the runtime and installer verification scripts.
Do not commit generated `dist`, `target`, runtime, test-result, or installer
output directories.

## Pull requests

Describe the user-visible behavior, the state-machine or data boundary touched,
the checks you ran, and any migration or configuration requirement. Include
screenshots only when they use fictional data and contain no local paths,
tokens, Feishu identifiers, or personal schedule/health information.
