# Repository Guidelines

## Project Structure & Module Organization

This repository was split from OpenClaw's `extensions/feishu` extension and remains a TypeScript ESM plugin for the Feishu/Lark channel. Keep its public plugin and runtime APIs compatible with the upstream OpenClaw extension contracts. Core implementation modules live in `src/`; keep features near their domain, such as `src/docx.ts`, `src/drive.ts`, and the `src/monitor.*.ts` handlers. Root-level files such as `index.ts`, `api.ts`, and `setup-entry.ts` are public or host-facing entry points. Agent-facing Feishu capabilities and their references live under `skills/`. Build output goes to `dist/` and is ignored; do not commit generated files.

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
