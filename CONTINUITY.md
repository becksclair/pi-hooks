Last updated: 2026-03-21
- Goal (success criteria): Ship OpenCode-style LSP server configuration in `lsp/` while preserving built-in root detection, built-in spawn behavior, shared hook/tool registry usage, merged global+project settings, tests, and docs.
- Constraints/Assumptions: Built-ins remain defaults; config lives under `lsp.servers`; custom servers must declare `command` and `extensions`; hook-mode persistence via `/lsp` must keep sibling keys intact.
- Key decisions: Keep `LSP_SERVERS` as a compatibility alias for built-in defaults; derive manager reuse from `(cwd, resolved-config fingerprint)`; use generic root detection only for custom servers; keep built-in specialized spawn/root logic unless `command` is explicitly overridden.
- Now: Implementation is complete in `lsp/lsp-core.ts`, `lsp/lsp.ts`, tests, and docs; verification commands have been run.
- Next: If Bex wants follow-up, smoke-test the extension in a real Pi session and/or add a debug surface for resolved config inspection.
- Open questions: None blocking. Direct package import verification for `lsp.ts` is environment-blocked here because `@mariozechner/pi-tui` is missing from `lsp/node_modules`.
- Working set: `lsp/lsp-core.ts`, `lsp/lsp.ts`, `lsp/tests/lsp.test.ts`, `lsp/tests/lsp-integration.test.ts`, `lsp/README.md`, `README.md`, `plans/lsp-opencode-config-execplan.md`.
