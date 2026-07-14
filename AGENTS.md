# Repository Guidelines

## Project Structure & Module Organization

This repository was split from OpenClaw's `extensions/feishu` extension and remains a **standalone** TypeScript ESM plugin for the Feishu/Lark channel. It is not an OpenClaw monorepo checkout and should not be restructured into one. Keep public plugin and runtime APIs compatible with upstream OpenClaw extension contracts. Core implementation modules live in `src/`; keep features near their domain, such as `src/docx.ts`, `src/drive.ts`, and the `src/monitor.*.ts` handlers. Root-level files such as `index.ts`, `api.ts`, and `setup-entry.ts` are public or host-facing entry points. Agent-facing Feishu capabilities and their references live under `skills/`. Build output goes to `dist/` and is ignored; do not commit generated files.

Standalone packaging that monorepo does not use (keep these when syncing):

- `tsdown` build (`tsdown.config.ts`, `npm run build`)
- independent `package.json` / `npm-shrinkwrap.json` (no `workspace:*`)
- this `AGENTS.md`, link-install oriented `README.md`, and repo-local `.gitignore`

## Syncing From Monorepo (`extensions/feishu` → this repo)

**Direction:** import monorepo `extensions/feishu` sources **into this plugin repo**. Do not move this repo back into monorepo or replace this repo's layout with monorepo workspace packaging.

Recommended order when rebasing onto a new OpenClaw tag (for example `v2026.7.1`):

1. Take production sources from monorepo `extensions/feishu` as the code baseline (`src/**`, root entry `*.ts`, `openclaw.plugin.json`, `skills/`, etc.).
2. Restore standalone packaging (build scripts, non-workspace dependencies, `files`, repository URL).
3. Bump `openclaw.compat.pluginApi`, `openclaw.build.openclawVersion`, and `peerDependencies.openclaw` to match the host tag when the sync requires it.
4. Re-apply **fork-specific behavior** below on top of the new baseline (port by intent into the updated file layout; do not wholesale restore old `bot.ts` over upstream fixes).
5. Verify with `npx tsc --noEmit`, `npm run build`, and `openclaw plugins install --link "$PWD"`.

Do not copy monorepo-only concerns (workspace devDependencies, monorepo test harness requirements) unless this repo intentionally adds the same tooling.

## Fork-Specific Behavior (vs monorepo `extensions/feishu`)

This checkout is not a pure mirror of upstream Feishu. After every monorepo sync, preserve the following unless an intentional product change says otherwise.

### Topic / thread → session isolation

Different Feishu topics (threads) map to different agent sessions. Important pieces:

- Default scope: native `topic_group` chats (and inbound thread context when `topicSessionMode` is not `disabled`) resolve to `group_topic` unless `groupSessionScope` is set explicitly. Upstream monorepo has tightened this toward an explicit opt-in default of `group`.
- Session keys use conversation ids such as `chat:topic:…` / `…:sender:…` (`conversation-id.ts`, `bot-content.ts`).
- Missing starter `thread_id` on topic events is hydrated before sequential queueing so first turns and follow-ups stay on the same topic session (`monitor.message-handler.ts`).
- Sequential control lanes and outbound reply anchors should stay aligned with the topic session peer (`sequential-key.ts`, reply / channel send paths).

Related config: `channels.feishu.groupSessionScope`, legacy `topicSessionMode`, and `replyInThread`.

### `/stop` cancellation

Authorized abort commands (`/stop` and other `isAbortRequestText` matches) supersede in-flight Feishu reply work for that session:

- `src/feishu-reply-fence.ts` tracks per-session generation and aborts active `AbortController`s.
- `src/bot.ts` wires `replyOptions.abortSignal` into dispatch and skips no-visible-reply fallbacks when the fence was superseded.
- Group `/stop` must authorize against the command-facing body and, when the bot is mentioned, the sender as command owner where applicable.

Upstream monorepo Feishu does not currently ship this reply-fence path; do not drop it when syncing a newer OpenClaw tag into this repo.

## Build, Test, and Development Commands

- `npm ci` installs the exact dependency versions recorded in `npm-shrinkwrap.json`.
- `npm run build` runs `tsdown`, cleans `dist/`, and bundles all configured ESM entry points for Node 22.
- `npx tsc --noEmit` performs a strict TypeScript check without writing output.
- `openclaw plugins install --link "$PWD"` links the checkout into a local OpenClaw installation for manual integration testing.

There is currently no `npm test` script or checked-in test suite. If a change introduces automated tests, add the corresponding script to `package.json` so CI and contributors have one stable command.

## Coding Style & Naming Conventions

Follow the existing TypeScript style: two-space indentation, double quotes, semicolons, trailing commas in multiline structures, and explicit `type` imports. Use `camelCase` for functions and variables, `PascalCase` for types, and descriptive kebab-case filenames. Related handler files may use dotted qualifiers, for example `monitor.message-handler.ts`. Keep `.js` extensions in relative imports; NodeNext resolves them to the TypeScript source. Preserve strict typing and validate data at external API boundaries. No formatter or linter is configured, so match surrounding code and keep diffs focused.

## Testing Guidelines

Name unit tests `*.test.ts`; `tsconfig.json` already excludes that pattern from production compilation. Test success paths, Feishu API failures, malformed event payloads, and multi-account behavior where relevant. Until a test runner is added, verify every change with `npx tsc --noEmit`, `npm run build`, and a linked-plugin smoke test.

## Commit & Pull Request Guidelines

Recent commits use short, imperative subjects such as `Fix Feishu stop command cancellation`. Keep each commit scoped to one logical change. Pull requests should explain user-visible behavior, list verification commands, link relevant issues, and call out configuration or compatibility effects. Include screenshots or message/card samples for UI-facing Feishu changes, and never include app secrets, tokens, or tenant data.
