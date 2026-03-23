# ExecPlan: OpenCode-style LSP configuration for `pi-hooks` LSP

Status: Proposed
Owner: Sky
Date: 2026-03-21
Target area: `lsp/`

## Outcome

Add OpenCode-style LSP server configuration to the `pi-hooks` LSP extension while preserving the existing built-in language support, root detection, and spawn behavior.

The resulting system should:
- accept a collision-safe Pi settings shape under `lsp.servers`
- treat built-in server definitions as defaults
- allow config to override or disable built-ins
- allow new custom servers with explicit extensions
- use the same resolved server registry for both the auto-diagnostics hook and the LSP tool
- merge global and project Pi settings consistently

## Why this plan

The current implementation hardcodes the active registry in `lsp/lsp-core.ts` and then relies on that static registry from both `lsp.ts` and `lsp-tool.ts`. That is simple, but it makes config support fake unless the manager, hook, and tool all move to a resolved runtime registry.

The user wants OpenCode-like override behavior, not replacement of built-in logic. That means the right model is:

- built-ins remain the source of truth for known languages
- config overlays onto them
- only custom servers use generic fallback behavior

That is the least cursed path.

## Scope

In scope:
- new config shape under Pi settings: `lsp.servers`
- global + project settings merge for LSP server config
- override semantics for built-in servers
- disable semantics for built-in or custom servers
- custom server support with explicit extensions
- shared resolved registry across hook and tool paths
- test updates and docs updates for the `lsp/` package

Out of scope for this pass:
- UI editing for server definitions via `/lsp`
- arbitrary user-defined root-detection logic in settings
- arbitrary user-defined spawn functions in settings
- repo-wide config system churn outside `lsp/`

## Target config shape

Primary documented shape:

```json
{
  "lsp": {
    "hookMode": "agent_end",
    "servers": {
      "typescript": {
        "command": ["tsgo", "lsp", "--stdio"]
      },
      "eslint": {
        "disabled": true
      },
      "bash": {
        "command": ["bash-language-server", "start"],
        "extensions": [".sh", ".bash"],
        "env": {
          "SHELLCHECK_PATH": "~/.agents/bin/shellcheck-guard"
        }
      }
    }
  }
}
```

Server entry shape:

```json
{
  "command": ["binary", "arg1", "arg2"],
  "extensions": [".ext1", ".ext2"],
  "env": {
    "KEY": "value"
  },
  "initialization": {
    "any": "json-compatible object"
  },
  "disabled": true
}
```

Notes:
- `hookMode` remains a sibling of `servers`
- `lsp.servers` is the only documented server registry location in this plan
- built-in servers may omit `command` and/or `extensions` in config because those inherit from defaults
- custom servers must provide `command` and `extensions`

## Compatibility and override semantics

### Built-in server ids

If a configured server id matches a built-in server id:
- missing `command` inherits the built-in spawn behavior/command
- missing `extensions` inherits built-in extensions
- missing `env` means no extra env overlay
- missing `initialization` means no extra initialization override
- `disabled: true` disables that built-in server entirely

Examples:

```json
{
  "lsp": {
    "servers": {
      "typescript": {
        "command": ["tsgo", "lsp", "--stdio"]
      },
      "pyright": {
        "disabled": true
      }
    }
  }
}
```

This should:
- keep TypeScript’s built-in file extensions and root detection
- replace only the TypeScript server command
- disable built-in Pyright completely

### Custom server ids

If a configured server id does not match a built-in server id:
- `command` is required
- `extensions` is required
- `disabled` is optional
- root detection uses the generic fallback heuristic

Example:

```json
{
  "lsp": {
    "servers": {
      "yaml-ls": {
        "command": ["yaml-language-server", "--stdio"],
        "extensions": [".yaml", ".yml"]
      }
    }
  }
}
```

### Non-goals for override semantics in this pass

Config will not directly override:
- root detection functions for built-ins
- custom spawn logic beyond argv/env/initialization
- server priority ordering beyond the final resolved registry order we explicitly define in code

## Core invariants

These are the invariants the implementation must preserve.

1. Built-in language support keeps working with no settings changes.
2. Built-in root detection remains in place for known servers.
3. Built-in special spawn logic remains in place for known servers.
4. Hook and tool code use the same resolved server registry.
5. Global and project settings are merged, with project taking precedence.
6. Server config lives under `lsp.servers`, so `hookMode` cannot collide with a server id.
7. Invalid server config does not crash the extension runtime.
8. Custom servers cannot silently activate without declared extensions.
9. Manager lifecycle must reflect resolved config changes, not just cwd.

## Phase breakdown

---

## Phase 1: Model the config explicitly

### Step 1. Lock the target schema before touching internals

Create internal types for:
- hook settings
- raw configured server entry
- resolved runtime server definition
- merged LSP settings object

Recommended internal shapes:
- `HookMode`
- `RawConfiguredServerEntry`
- `ConfiguredServerMap`
- `ResolvedServerDefinition`
- `ResolvedLspConfig`

Deliverable:
- a single authoritative config model in code, not ad hoc object casts spread across files

### Step 2. Define exact override semantics in code comments and tests

Encode the rules above directly in type comments and helper function names.

Examples of helper names that make behavior obvious:
- `resolveBuiltinServerOverride(...)`
- `resolveCustomServer(...)`
- `mergeLspServerSettings(...)`

Deliverable:
- implementation helpers whose names reflect policy, not generic soup like `normalizeConfig`

### Step 3. Add a config parsing layer separate from runtime server resolution

The parse layer should:
- read JSON objects from merged Pi settings
- extract `lsp.hookMode`
- extract `lsp.servers`
- validate entry shapes at runtime
- return structured parse results including skipped/invalid entries if needed

Important:
- parsing raw settings and resolving runtime servers are different jobs and should stay separate

Deliverable:
- `parseLspSettings(...)` or equivalent

---

## Phase 2: Load and merge settings correctly

### Step 4. Load and merge both Pi settings scopes, not just global

Current hook code reads only `~/.pi/agent/settings.json`. That is insufficient.

Implementation work:
- add shared settings loading helper for:
  - global: `~/.pi/agent/settings.json`
  - project: `<cwd>/.pi/settings.json`
- merge nested objects with project overriding global
- isolate this logic so both hook and core can use it

Expected semantics:
- if global defines `lsp.servers.typescript.command`
- and project defines `lsp.servers.typescript.initialization`
- final resolved object includes both, with project values winning on overlap

Deliverable:
- `loadMergedLspSettings(cwd)` or equivalent

### Step 5. Keep hook-mode persistence behavior stable

The `/lsp` command currently persists only hook mode.

In this pass:
- preserve the current session/global hook-mode flow
- make the global hook-mode writer update the `lsp` namespace without disturbing `lsp.servers`

That means the writer must preserve sibling keys inside `settings.lsp`.

Deliverable:
- `setGlobalHookMode()` still works and no longer risks trampling future `servers` data

---

## Phase 3: Split defaults from resolved runtime config

### Step 6. Separate hardcoded built-ins from the resolved registry

Refactor the current `LSP_SERVERS` constant into a defaults registry, e.g.:
- `DEFAULT_LSP_SERVERS`

This registry remains authoritative for built-in languages and keeps:
- extensions
- root detection
- spawn behavior
- init wiring support

Known built-ins to preserve:
- dart
- typescript
- vue
- svelte
- pyright
- gopls
- kotlin
- swift
- rust-analyzer

Deliverable:
- defaults registry plus a resolver that produces the active runtime registry

### Step 7. Build the overlay resolver for `lsp.servers`

Add a resolver that:
1. starts from built-in defaults
2. applies overrides from `lsp.servers`
3. adds valid custom servers
4. removes disabled servers
5. returns the final ordered runtime registry

Resolution rules:
- built-ins inherit defaults where config omits fields
- custom servers require `command` and `extensions`
- invalid entries are skipped, not fatal

Deliverable:
- `resolveLspServerRegistry(settings, cwd)` or equivalent

### Step 8. Be explicit about overrideable fields vs built-in-only behavior

Overrideable via config:
- `command`
- `extensions`
- `env`
- `initialization`
- `disabled`

Built-in-only in this pass:
- specialized `findRoot`
- specialized spawn functions

This distinction must be documented in code comments and README.

Deliverable:
- no ambiguity about what a “TypeScript override” actually changes

---

## Phase 4: Generic behavior only where needed

### Step 9. Add generic root detection only for custom servers

Built-ins keep their current `findRoot` functions.

Custom servers use a generic root heuristic that checks upward for:
- `.git`
- `package.json`
- `pyproject.toml`
- `Cargo.toml`
- `go.mod`
- otherwise fall back to the file’s directory

Rationale:
- preserves current built-in quality for Kotlin/Swift/Go/Dart/TS
- makes unknown servers usable without pretending we know their domain-specific rules

Deliverable:
- `findGenericRoot(...)`

---

## Phase 5: Refactor manager lifecycle around resolved config

### Step 10. Refactor `LSPManager` to accept resolved server config

Current problem:
- manager implicitly consumes a module-global registry

Required change:
- constructor accepts the resolved server registry for the current cwd/settings state
- `getClientsForFile()` iterates the provided runtime registry, not a static global constant

Potential signature shape:
- `new LSPManager(cwd, servers)`

Deliverable:
- manager no longer depends on global `LSP_SERVERS`

### Step 11. Fix shared-manager lifecycle so config changes actually matter

Current singleton keying uses only `cwd`, which is not enough.

Implementation options:
- key the singleton by `(cwd, configFingerprint)`
- or rebuild when resolved config fingerprint changes on session start/tool use

Recommended:
- stable fingerprint of resolved registry + cwd

Why:
- otherwise config edits in `.pi/settings.json` or global settings won’t be picked up reliably

Deliverable:
- manager refreshes when active LSP config changes

### Step 12. Keep diagnostics cache and client reuse behavior intact

During the refactor, preserve:
- per-root client reuse
- idle file cleanup
- LRU eviction
- diagnostics caching
- shutdown behavior

Deliverable:
- no regression in resource usage and diagnostics flow

---

## Phase 6: Hook and tool must share the same world

### Step 13. Update the hook extension to consume the resolved registry

Refactor `lsp/lsp.ts` so that:
- server lookup uses resolved runtime config
- warmup uses resolved runtime config
- active client labels come from resolved runtime config
- hook mode reads from merged settings, not only the global file

Important behavior to preserve:
- session override via custom session entry for hook mode
- current UI command `/lsp` for hook mode selection
- touched file tracking and agent-end diagnostics

Deliverable:
- hook uses the same resolved config as the manager

### Step 14. Update the tool extension to consume the same resolved registry

Refactor `lsp/lsp-tool.ts` so that all actions use the same manager/config path as the hook.

Preserve current actions:
- definition
- references
- hover
- symbols
- diagnostics
- workspace-diagnostics
- signature
- rename
- codeAction

Deliverable:
- no hook/tool split-brain

### Step 15. Preserve initialization plumbing and map config directly onto it

Current core already sends init/config data through:
- `initialize.initializationOptions`
- `workspace/configuration`
- `workspace/didChangeConfiguration`

Keep that mechanism.

Implementation detail:
- resolved runtime server objects should carry normalized `env` and `initialization`
- spawn helpers should merge `env` into child process environment

Deliverable:
- OpenCode-style `initialization` works without redesigning LSP handshake behavior

---

## Phase 7: Testing strategy

### Step 16. Add config-focused unit tests before reshaping the old test surface

Add new tests that cover:
- parsing `lsp.servers`
- merging global and project settings
- built-in override inheriting extensions
- built-in disable
- custom server requires `extensions`
- `env` propagation in resolved config objects
- `initialization` propagation in resolved config objects
- config fingerprint / manager refresh behavior if testable at unit level

Deliverable:
- focused tests for the new behavior before rewriting the older ones

### Step 17. Migrate static-registry tests to the new API surface

Current tests assume a static exported `LSP_SERVERS` constant.

Refactor test organization into:
- default built-in server tests
- resolved registry tests
- manager behavior tests

Keep coverage for:
- root detection of built-ins
- extension mapping of built-ins
- presence of built-in ids

Likely updates:
- tests importing `LSP_SERVERS` directly
- tests constructing `new LSPManager(dir)`

Deliverable:
- old coverage preserved, but pointed at the new architecture

### Step 18. Add a couple of config-driven integration tests

At minimum:
1. built-in override:
   - override TypeScript command
   - inherited extensions still resolve `.ts` and `.tsx`
2. built-in disable:
   - disable Pyright
   - Python files become unsupported unless another Python server exists
3. initialization propagation:
   - config-sourced initialization arrives in client startup path

If external binaries make this awkward, use a tiny fake stdio LSP shim for at least one end-to-end resolver/manager test.

Deliverable:
- proof that the config layer affects real runtime behavior, not just static objects

---

## Phase 8: Docs and verification

### Step 19. Document the override model clearly and only once

Update `lsp/README.md` with:
- the new primary config shape under `lsp.servers`
- statement that built-ins remain defaults
- statement that config overrides built-ins rather than replacing built-in logic
- examples for:
  - override command only
  - disable built-in server
  - add `env`
  - add `initialization`
  - define a custom server
- explicit note that custom servers must declare `extensions`

Keep root `README.md` update short if the package summary needs one extra sentence.

Deliverable:
- user-facing docs match actual behavior

### Step 20. Validate with the package-local test flow already documented

Run:
- `cd lsp && npm test`
- `cd lsp && npm run test:tool`
- `cd lsp && npm run test:integration`

If anything is skipped or not runnable, report that plainly.

Deliverable:
- verification report tied to actual command output

### Step 21. Optional: expose a tiny resolved-config debug surface

Optional but useful:
- export a `resolveLspConfig(...)` helper for tests
- or add a minimal debug command later

This is not required for the feature to ship, but it will save time the next time config behavior gets weird.

Deliverable:
- easier diagnosis for future maintenance

## File-level implementation map

### `lsp/lsp-core.ts`

Primary refactor target.

Expected changes:
- extract built-in defaults registry
- add config types and resolver helpers
- add merged settings loader helpers or import them from a tiny helper module
- add generic root detection for custom servers
- refactor manager constructor to take resolved servers
- refactor singleton creation to incorporate config fingerprint
- preserve diagnostics, open-file, and shutdown behavior

### `lsp/lsp.ts`

Expected changes:
- stop reading only the global settings file for all LSP behavior
- keep hook-mode persistence logic
- use resolved runtime server registry for:
  - file-to-server lookup
  - warmup
  - footer status/active clients

### `lsp/lsp-tool.ts`

Expected changes:
- no action-level behavior changes required beyond using the resolved manager/config path
- ensure tool actions use the same runtime registry as hook and manager

### `lsp/tests/lsp.test.ts`

Expected changes:
- migrate static-registry assumptions
- keep built-in root-detection coverage
- add resolved-config assertions or move them to a new config test file

### `lsp/tests/lsp-integration.test.ts`

Expected changes:
- update manager construction if constructor changes
- add config-driven integration coverage

### `lsp/tests/index.test.ts`

Expected changes:
- likely minimal, unless exports/helpers move

### `lsp/README.md`

Expected changes:
- document config shape
- document override model
- document custom server requirements

## Risks and mitigations

### Risk 1: Config changes do not apply during a running session

Cause:
- shared manager keyed only by cwd

Mitigation:
- add config fingerprint to manager lifecycle keying

### Risk 2: Regressing built-in root detection behavior

Cause:
- accidentally replacing built-in findRoot with generic logic

Mitigation:
- built-ins keep their current findRoot implementations
- custom servers alone use generic root detection
- preserve root-detection test coverage

### Risk 3: Hook and tool diverge in behavior

Cause:
- each loads config differently or constructs managers differently

Mitigation:
- one shared resolved-config path and one shared manager creation path

### Risk 4: Invalid user config crashes the extension

Cause:
- direct unchecked object access and assumptions

Mitigation:
- parse and validate config before resolution
- skip invalid server entries with safe fallback to defaults

### Risk 5: Partial built-in override accidentally erases defaults

Cause:
- naive replacement merge instead of overlay merge

Mitigation:
- explicit built-in override helper with field inheritance semantics

## Acceptance criteria

The work is done when all of the following are true:

1. A user can override a built-in server command under `lsp.servers.<id>` without losing built-in root detection or extensions unless they explicitly override extensions.
2. A user can disable a built-in server via `disabled: true`.
3. A user can add a custom server with explicit `command` and `extensions`.
4. Global and project Pi settings merge correctly for `lsp` config.
5. The hook and tool both use the same resolved runtime server registry.
6. Existing built-in language behavior remains functional with no config present.
7. Relevant `lsp/` tests pass, or any skipped/failing verification is documented with evidence.
8. `lsp/README.md` documents the shipped behavior.

## Verification checklist

Before final handoff, verify:
- config parser behavior with unit tests
- built-in override inheritance with unit tests
- custom server validation with unit tests
- manager rebuild on config change, or clearly document if reload is required
- package-local tests run and results recorded
- docs examples match implemented JSON keys exactly

## Evidence base used for this plan

- Current static registry and manager coupling in `lsp/lsp-core.ts`
- Current hook-only global settings handling in `lsp/lsp.ts`
- Current package docs in `lsp/README.md`
- Pi settings merge semantics from Pi docs
- OpenCode LSP schema typing from local OpenCode SDK typings
- Real local OpenCode config example using the desired server-entry schema

## Recommended execution order

If implementing this plan, the safest order is:
1. config model + parser
2. merged settings loader
3. defaults vs resolved registry split
4. manager refactor
5. hook/tool wiring
6. tests
7. docs
8. verification

That sequence keeps the blast radius legible instead of turning the whole thing into a haunted forest.

## Implementation update (2026-03-21)

Status: Implemented

Progress:
- Added parsed `lsp.servers` settings, merged global + project settings loading, and resolved runtime registry generation in `lsp/lsp-core.ts`.
- Split built-in defaults from resolved runtime servers and made manager reuse depend on a config fingerprint instead of just `cwd`.
- Kept built-in root detection and special spawn behavior, while allowing command/env/initialization overrides and custom servers with explicit extensions.
- Updated `lsp/lsp.ts` to read merged settings, preserve `/lsp` hook-mode persistence, and use the resolved registry for active-client tracking and warmup.
- Expanded `lsp/tests/lsp.test.ts` and `lsp/tests/lsp-integration.test.ts` to cover config parsing, merge semantics, built-in override inheritance, disabling built-ins, custom server validation, and config-driven manager refresh/runtime behavior.
- Updated `lsp/README.md` and the root `README.md` to document the shipped `lsp.servers` shape and override semantics.

Surprises & discoveries:
- The existing tests exercised root detection well but did not touch settings loading at all, so config behavior needed fresh unit coverage rather than a tweak to the old surface.
- Package-local runtime verification of `lsp.ts` importability was blocked in this checkout because `@mariozechner/pi-tui` is not installed in `lsp/node_modules`; the documented package tests still passed.

Decision log:
- Decision: keep `LSP_SERVERS` exported as an alias of the built-in defaults registry for compatibility with existing tests and imports.
  Rationale: it preserves current consumers while the resolved runtime registry becomes the real execution path.
- Decision: use a config fingerprint derived from resolved runtime server settings to rebuild the shared manager.
  Rationale: it makes config edits in either `~/.pi/agent/settings.json` or `<cwd>/.pi/settings.json` actually take effect without changing cwd.

Outcomes & retrospective:
- The LSP extension now supports OpenCode-style config overlays without throwing away the built-in server knowledge that made the original extension useful.
- The biggest remaining verification gap is direct package import of `lsp.ts` in this local checkout, which is environment-blocked by missing package-local dev dependencies rather than by the feature work itself.

Revision note: updated after implementation to record what shipped, why the manager lifecycle changed, and what verification was actually run.
