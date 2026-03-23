# Agent Instructions

## Description
- This repo is a small monorepo-style package of reference extensions for `pi-coding-agent`, published as `pi-hooks`.
- Root `package.json` registers these extension entrypoints via `pi.extensions`:
  - `./checkpoint/checkpoint.ts`
  - `./lsp/lsp.ts`
  - `./lsp/lsp-tool.ts`
  - `./permission/permission.ts`
  - `./ralph-loop/ralph-loop.ts`
  - `./repeat/repeat.ts`
  - `./token-rate/token-rate.ts`
- Verified package areas:
  - `checkpoint/` Git-backed checkpointing and restore flows
  - `lsp/` LSP hook plus on-demand LSP tool
  - `permission/` layered permission control
  - `ralph-loop/` looped subagent execution tool
  - `repeat/` repeat recent bash/edit/write tool calls
  - `token-rate/` footer TPS status extension
- Optimize for small, local edits inside the affected extension package.
- Scope boundary: this repo is extension code and docs, not the `pi` core app.
- Inferred: the packages are intended to stay independently installable as well as usable through the root aggregator package.

## Priorities
- Preserve existing extension behavior, package names, and registered entrypoints.
- Prefer minimal churn over repo-wide cleanup.
- Keep docs, manifests, and user-facing commands/settings aligned.
- Treat `checkpoint/` restore behavior and `permission/` command classification as high-sensitivity areas.
- For `lsp/`, favor correctness and bounded resource usage over cleverness; the README explicitly documents cache/cleanup behavior and multi-language support.

## Commands
### Setup
- Install the aggregated package: `pi install npm:pi-hooks`
- Enable or disable installed extensions: `pi config`
- Repo testing setup from root `README.md`:
  - `cd lsp && npm install`
  - `cd ../permission && npm install`

### Test
- `cd checkpoint && npm test`
- `cd lsp && npm test`
- `cd lsp && npm run test:tool`
- `cd lsp && npm run test:integration`
- `cd lsp && npm run test:all`
- `cd permission && npm test`
- `cd token-rate && npm test` — currently prints `No tests yet`

### Verified script values
- `checkpoint/package.json`: `test = "npx tsx tests/checkpoint.test.ts"`
- `lsp/package.json`:
  - `test = "npx tsx tests/lsp.test.ts"`
  - `test:tool = "npx tsx tests/index.test.ts"`
  - `test:integration = "npx tsx tests/lsp-integration.test.ts"`
  - `test:all = "npm test && npm run test:tool && npm run test:integration"`
- `permission/package.json`: `test = "npx tsx tests/permission.test.ts"`
- `token-rate/package.json`: `test = "echo \"No tests yet\""`

### Verified not found
- No root `scripts` in `package.json`
- No verified repo-level build, dev, lint, format, or typecheck command
- No `.github/workflows/` directory
- No `CONTRIBUTING*`, `.cursorrules`, `.cursor/rules/**`, or `.github/copilot-instructions.md`

## Conventions
- Package manifests inspected at root and in all extension folders use TypeScript entrypoints and `pi.extensions` registration.
- Every inspected package manifest sets `"type": "module"`.
- `checkpoint/tsconfig.json` and `lsp/tsconfig.json` both use:
  - `target: "ES2022"`
  - `module: "NodeNext"`
  - `moduleResolution: "NodeNext"`
  - `strict: true`
  - `noEmit: true`
  - `skipLibCheck: true`
  - `include: ["*.ts"]`
- Tests are package-local and run through `npx tsx ...` where present.
- Repeated package structure visible from manifests/readmes:
  - extension entrypoint at package root
  - optional `*-core.ts` helper file for heavier logic
  - `tests/` directory for `checkpoint/`, `lsp/`, and `permission/`
- `lsp/` is the only verified package exporting two extensions (`lsp.ts` and `lsp-tool.ts`); the others export one.

## Guardrails
- Do not casually rename or move files referenced by root `package.json` `pi.extensions` or per-package `pi.extensions`.
- When changing user-visible behavior, update the relevant package README and the root `README.md` if the change affects aggregated usage.
- Keep changes local to the target extension unless the root aggregator manifest or shared docs truly need updating.
- Avoid adding new tooling/config churn unless the task explicitly asks for it; this repo currently has very little build/lint/CI scaffolding.
- Be conservative in:
  - `checkpoint/` snapshot filtering, restore semantics, and Git ref handling
  - `permission/` allowed-operation rules, prompt/block behavior, and dangerous-command handling
  - `lsp/` server lifecycle, diagnostics timing, and supported-language detection

## Completion Criteria
- The touched extension still has valid manifest registration through `pi.extensions`.
- Relevant package-local tests pass for the changed area when a real test script exists.
- Docs and manifests match the implemented behavior.
- Changes are minimal and confined to the affected package unless cross-package updates are required.

## Organization
- `package.json` — root aggregator manifest for the multi-extension package
- `README.md` — repo overview, install flow, and cross-package testing notes
- `assets/` — screenshots used by docs
- `checkpoint/` — checkpoint extension, core logic, tests, and package README
- `lsp/` — LSP hook/tool package, tests, and package README
- `permission/` — permission extension, core logic, tests, and package README
- `ralph-loop/` — ralph loop extension package and README
- `repeat/` — repeat extension package and README
- `token-rate/` — token-rate extension package and README

## Sources of Truth
1. `README.md`
2. Package READMEs:
   - `checkpoint/README.md`
   - `lsp/README.md`
   - `permission/README.md`
   - `ralph-loop/README.md`
   - `repeat/README.md`
   - `token-rate/README.md`
3. Manifests:
   - `package.json`
   - `checkpoint/package.json`
   - `lsp/package.json`
   - `permission/package.json`
   - `ralph-loop/package.json`
   - `repeat/package.json`
   - `token-rate/package.json`
4. TypeScript config where present:
   - `checkpoint/tsconfig.json`
   - `lsp/tsconfig.json`
5. Verified absent before this file was created: repo-root `AGENTS.md`, `.cursor/`, `.github/`, `.cursorrules`, `CONTRIBUTING*`
