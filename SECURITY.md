# Security Policy

## Scope

Personal AI Assistant is a local-first, single-user application. The public
repository must never contain real database credentials, AI provider keys,
Feishu identifiers, signing material, local backups, or personal task data.

The supported release boundary is:

- the API and reminder worker run on the user's machine;
- PostgreSQL is a local development dependency;
- DeepSeek, vision, search, and Feishu integrations are optional server-side
  adapters;
- the desktop installer must not bundle the repository `.env` file.

## Reporting a vulnerability

Please do not publish credentials, personal data, exploit details, or Feishu
payloads in a public issue. Use a private GitHub security report when the
repository has GitHub Security Advisories enabled. If it does not, contact the
repository maintainer through the private channel listed in the repository
profile and include only the minimum reproducible details.

Reports should include:

- the affected version or commit;
- the smallest reproduction that does not contain personal data;
- the impact and whether credentials or user data may be exposed;
- any suggested mitigation.

## Credential exposure

If a real key, password, token, or Feishu secret is committed accidentally,
assume it is compromised: revoke or rotate it first, then remove it from the
repository history. Deleting it only from the latest working tree is not
sufficient.

## Safe development defaults

- Copy `.env.example` to a local ignored `.env`.
- Keep API keys server-only; never place them in `apps/web` or public assets.
- Follow `docs/INTEGRATIONS.md` for the supported local configuration boundary.
- Use fictional tasks and disposable accounts in tests and screenshots.
- Run the guarded database preflight before migrations.
- Do not upload PostgreSQL data directories, backups, logs, installer output,
  or local runtime folders.
