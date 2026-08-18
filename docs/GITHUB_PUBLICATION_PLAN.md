# GitHub Publication Plan

## Release shape

Publish two things separately:

1. The source repository, without local configuration, personal data, generated
   output, database files, logs or installers.
2. A tagged GitHub Release containing the verified Windows NSIS installer and
   its SHA-256 checksum. Build products should not be committed to the main
   branch.

The first public push should go to a private staging repository. Make it public
only after the clean-clone build, secret scan and screenshot review pass.

## Build and packaging

The repository pins pnpm 11.9.0. Use Corepack so a globally installed `pnpm`
is not required.

```powershell
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm local:verify
corepack pnpm build:desktop
```

The desktop build prepares a self-contained Node/API/Worker runtime, builds the
Tauri application, rebuilds the NSIS installer and verifies its structure. The
installer verification already rejects a bundled private `.env` and reports a
SHA-256 checksum.

Before creating a public tag:

- keep the versions in the root package, desktop package, Cargo manifest and
  Tauri configuration identical;
- ensure every Drizzle migration needed by the published source is present;
- build from a fresh clone using only `.env.example` plus throwaway local
  credentials;
- install, upgrade, launch, complete one demo focus session and uninstall in a
  disposable Windows account or virtual machine;
- sign the Windows application if a trusted code-signing certificate is
  available; otherwise clearly disclose that the first unsigned release may
  trigger Windows reputation warnings.

## Secrets and personal-data boundary

The public repository may contain variable names and placeholders, but never
real values. Keep these only in the ignored local `.env` or the installed
application's user-owned configuration file:

- database URL and password;
- DeepSeek, vision, Tavily and Brave keys;
- Feishu app ID, app secret, target open ID, verification token and encryption
  key;
- any future signing certificate or signing password.

The installer must continue to bundle `.env.example` only. The PostgreSQL
database is external to the repository and must never be exported into Git.
Local backups, logs, test output, Playwright traces, `output/`, `.pnpm-store/`,
Tauri `runtime/` and `target/` remain ignored.

Before publication, scan both the current tree and the complete Git history. If
a real credential is found in history, revoke/rotate it first and then rewrite
the affected history; deleting it only from the latest commit is insufficient.
Commit metadata also exposes author names and email addresses. Decide whether
the repository will be published under the current identity or a GitHub
`noreply` identity before the first push; changing this later requires a history
rewrite.

## Repository material still needed

- Capture and add public promotional screenshots from a disposable demo profile.
- Add a short architecture diagram or overview if the README needs more visual
  orientation for first-time readers.
- Commit the public-domain artwork source notes together with the artwork.

Completed in the working tree:

- The root `LICENSE` now contains the standard Apache License 2.0 text, and the
  public attribution choice is GitHub username plus the account's exact GitHub
  `noreply` email.
- The public product name and application identifier remain
  `Personal AI Assistant` / `com.personalai.assistant`.
- README now presents the product in Chinese, explains the complete user-facing
  workflow, privacy boundary, limitations, developer verification, and links
  to the first-run documentation.
- `docs/INSTALLATION.md`, `docs/INTEGRATIONS.md`, and
  `docs/GITHUB_FIRST_PUBLISH.md` now cover zero-to-first-launch setup, provider
  configuration, owner-only GitHub actions, repository staging, attribution,
  and Release assets.
- `SECURITY.md` and `CONTRIBUTING.md` define the public-data boundary and safe
  contribution workflow.
- `scripts/audit-public-release.mjs` and the `release:audit` command check the
  public file set, likely credential material, local paths, ignored artifacts,
  required release docs, and version consistency.
- `.github/workflows/ci.yml` runs the public audit, type-check, database-free
  unit suites, and publishable package build without personal credentials.

## Promotional screenshot set

Use a dedicated public directory such as `docs/media/`. Every screenshot must
be generated from a disposable demo profile with fictional tasks, a generic
location and no real health, Feishu or account information.

Recommended set:

1. **Hero image — Today:** three vertically stacked daypart sheets with the
   active sheet in front, plus separate scheduled and unscheduled tasks.
2. **Focus workflow:** one compact strip showing one-minute preparation,
   running focus, green rest and the evaluation window.
3. **Five themes:** a consistent `25:00` comparison of ink stamp, minimal flip,
   glow tube, vaporwave and cyber terminal.
4. **Growth:** the bamboo scene with the three task-completion stages and the
   restrained linear subjective-feedback statistics.
5. **Health:** weekly note plus daily food, hydration and movement references.
6. **Personalization:** theme, window position, desktop/Feishu focus controls
   and health-page visibility in one clean settings screenshot.

Do not publish screenshots containing real task titles, exact personal
schedule, location, health notes, API diagnostics, Feishu identifiers, QR
codes, access tokens, database URLs or desktop file paths.

## Current release blockers

- The working tree contains a large, coherent product update that is not yet
  organized into reviewable commits.
- Existing commits use a local author identity; before organizing the public
  commits, the owner still needs to provide the exact GitHub `noreply` address
  shown in account settings so it is not guessed incorrectly.
- Final promotional screenshots have not yet been captured from a disposable
  demo profile.
- The current guarded PostgreSQL schema verifies successfully and the complete
  API/Worker test suite passes locally. A final clean-clone verification still
  needs to run after the release commits are organized.
- No remote repository is configured yet; the first push should go to a private
  staging repository selected by the owner.
