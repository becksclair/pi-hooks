/**
 * Integration tests for LSP - spawns real language servers and detects errors
 *
 * Run with: npm run test:integration
 *
 * Skips tests if language server is not installed.
 */

// Suppress stream errors from vscode-jsonrpc when LSP process exits
process.on('uncaughtException', (err) => {
  if (err.message?.includes('write after end')) return;
  console.error('Uncaught:', err);
  process.exit(1);
});

import { mkdtemp, rm, writeFile, mkdir, readFile, chmod } from "fs/promises";
import { existsSync, statSync } from "fs";
import { spawn } from "node:child_process";
import { tmpdir } from "os";
import { join, delimiter, dirname } from "path";
import { fileURLToPath } from "url";
import { LSPManager, resolveLspConfig } from "../lsp-core.js";

// ============================================================================
// Test utilities
// ============================================================================

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
let skipped = 0;

function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

class SkipTest extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "SkipTest";
  }
}

function skip(reason: string): never {
  throw new SkipTest(reason);
}

// Search paths matching lsp-core.ts
const SEARCH_PATHS = [
  ...(process.env.PATH?.split(delimiter) || []),
  "/usr/local/bin",
  "/opt/homebrew/bin",
  `${process.env.HOME || ""}/.pub-cache/bin`,
  `${process.env.HOME || ""}/fvm/default/bin`,
  `${process.env.HOME || ""}/go/bin`,
  `${process.env.HOME || ""}/.cargo/bin`,
];

function commandExists(cmd: string): boolean {
  for (const dir of SEARCH_PATHS) {
    const full = join(dir, cmd);
    try {
      if (existsSync(full) && statSync(full).isFile()) return true;
    } catch {}
  }
  return false;
}

function commandPath(cmd: string): string | undefined {
  for (const dir of SEARCH_PATHS) {
    const full = join(dir, cmd);
    try {
      if (existsSync(full) && statSync(full).isFile()) return full;
    } catch {}
  }
  return undefined;
}

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const LSP_HOOK_EXTENSION = join(TESTS_DIR, "..", "lsp.ts");
const LSP_TOOL_EXTENSION = join(TESTS_DIR, "..", "lsp-tool.ts");

async function runPiPrintCommand(cwd: string, extensionPaths: string[], command: string, env?: Record<string, string>): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const piPath = commandPath("pi");
  if (!piPath) skip("pi not installed");

  return await new Promise((resolve, reject) => {
    const args = ["--no-session", "--no-extensions", "-p"];
    for (const extensionPath of extensionPaths) {
      args.push("--extension", extensionPath);
    }
    args.push(command);

    const proc = spawn(piPath, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf-8");
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf-8");
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}

// ============================================================================
// TypeScript
// ============================================================================

test("typescript: detects type errors", async () => {
  if (!commandExists("typescript-language-server")) {
    skip("typescript-language-server not installed");
  }

  const dir = await mkdtemp(join(tmpdir(), "lsp-ts-"));
  const manager = new LSPManager(dir);

  try {
    await writeFile(join(dir, "package.json"), "{}");
    await writeFile(join(dir, "tsconfig.json"), JSON.stringify({
      compilerOptions: { strict: true, noEmit: true }
    }));

    // Code with type error
    const file = join(dir, "index.ts");
    await writeFile(file, `const x: string = 123;`);

    const { diagnostics } = await manager.touchFileAndWait(file, 10000);

    assert(diagnostics.length > 0, `Expected errors, got ${diagnostics.length}`);
    assert(
      diagnostics.some(d => d.message.toLowerCase().includes("type") || d.severity === 1),
      `Expected type error, got: ${diagnostics.map(d => d.message).join(", ")}`
    );
  } finally {
    await manager.shutdown();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("typescript: valid code has no errors", async () => {
  if (!commandExists("typescript-language-server")) {
    skip("typescript-language-server not installed");
  }

  const dir = await mkdtemp(join(tmpdir(), "lsp-ts-"));
  const manager = new LSPManager(dir);

  try {
    await writeFile(join(dir, "package.json"), "{}");
    await writeFile(join(dir, "tsconfig.json"), JSON.stringify({
      compilerOptions: { strict: true, noEmit: true }
    }));

    const file = join(dir, "index.ts");
    await writeFile(file, `const x: string = "hello";`);

    const { diagnostics } = await manager.touchFileAndWait(file, 10000);
    const errors = diagnostics.filter(d => d.severity === 1);

    assert(errors.length === 0, `Expected no errors, got: ${errors.map(d => d.message).join(", ")}`);
  } finally {
    await manager.shutdown();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// ============================================================================
// Dart
// ============================================================================

test("dart: detects type errors", async () => {
  if (!commandExists("dart")) {
    skip("dart not installed");
  }

  const dir = await mkdtemp(join(tmpdir(), "lsp-dart-"));
  const manager = new LSPManager(dir);

  try {
    await writeFile(join(dir, "pubspec.yaml"), "name: test_app\nenvironment:\n  sdk: ^3.0.0");

    await mkdir(join(dir, "lib"));
    const file = join(dir, "lib/main.dart");
    // Type error: assigning int to String
    await writeFile(file, `
void main() {
  String x = 123;
  print(x);
}
`);

    const { diagnostics } = await manager.touchFileAndWait(file, 15000);

    assert(diagnostics.length > 0, `Expected errors, got ${diagnostics.length}`);
  } finally {
    await manager.shutdown();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("dart: valid code has no errors", async () => {
  if (!commandExists("dart")) {
    skip("dart not installed");
  }

  const dir = await mkdtemp(join(tmpdir(), "lsp-dart-"));
  const manager = new LSPManager(dir);

  try {
    await writeFile(join(dir, "pubspec.yaml"), "name: test_app\nenvironment:\n  sdk: ^3.0.0");

    await mkdir(join(dir, "lib"));
    const file = join(dir, "lib/main.dart");
    await writeFile(file, `
void main() {
  String x = "hello";
  print(x);
}
`);

    const { diagnostics } = await manager.touchFileAndWait(file, 15000);
    const errors = diagnostics.filter(d => d.severity === 1);

    assert(errors.length === 0, `Expected no errors, got: ${errors.map(d => d.message).join(", ")}`);
  } finally {
    await manager.shutdown();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// ============================================================================
// Rust
// ============================================================================

test("rust: detects type errors", async () => {
  if (!commandExists("rust-analyzer")) {
    skip("rust-analyzer not installed");
  }

  const dir = await mkdtemp(join(tmpdir(), "lsp-rust-"));
  const manager = new LSPManager(dir);

  try {
    await writeFile(join(dir, "Cargo.toml"), `[package]\nname = "test"\nversion = "0.1.0"\nedition = "2021"`);

    await mkdir(join(dir, "src"));
    const file = join(dir, "src/main.rs");
    await writeFile(file, `fn main() {\n    let x: i32 = "hello";\n}`);

    // rust-analyzer needs a LOT of time to initialize (compiles the project)
    const { diagnostics } = await manager.touchFileAndWait(file, 60000);

    assert(diagnostics.length > 0, `Expected errors, got ${diagnostics.length}`);
  } finally {
    await manager.shutdown();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("rust: valid code has no errors", async () => {
  if (!commandExists("rust-analyzer")) {
    skip("rust-analyzer not installed");
  }

  const dir = await mkdtemp(join(tmpdir(), "lsp-rust-"));
  const manager = new LSPManager(dir);

  try {
    await writeFile(join(dir, "Cargo.toml"), `[package]\nname = "test"\nversion = "0.1.0"\nedition = "2021"`);

    await mkdir(join(dir, "src"));
    const file = join(dir, "src/main.rs");
    await writeFile(file, `fn main() {\n    let x = "hello";\n    println!("{}", x);\n}`);

    const { diagnostics } = await manager.touchFileAndWait(file, 60000);
    const errors = diagnostics.filter(d => d.severity === 1);

    assert(errors.length === 0, `Expected no errors, got: ${errors.map(d => d.message).join(", ")}`);
  } finally {
    await manager.shutdown();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// ============================================================================
// Go
// ============================================================================

test("go: detects type errors", async () => {
  if (!commandExists("gopls")) {
    skip("gopls not installed");
  }

  const dir = await mkdtemp(join(tmpdir(), "lsp-go-"));
  const manager = new LSPManager(dir);

  try {
    await writeFile(join(dir, "go.mod"), "module test\n\ngo 1.21");

    const file = join(dir, "main.go");
    // Type error: cannot use int as string
    await writeFile(file, `package main

func main() {
	var x string = 123
	println(x)
}
`);

    const { diagnostics } = await manager.touchFileAndWait(file, 15000);

    assert(diagnostics.length > 0, `Expected errors, got ${diagnostics.length}`);
  } finally {
    await manager.shutdown();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("go: valid code has no errors", async () => {
  if (!commandExists("gopls")) {
    skip("gopls not installed");
  }

  const dir = await mkdtemp(join(tmpdir(), "lsp-go-"));
  const manager = new LSPManager(dir);

  try {
    await writeFile(join(dir, "go.mod"), "module test\n\ngo 1.21");

    const file = join(dir, "main.go");
    await writeFile(file, `package main

func main() {
	var x string = "hello"
	println(x)
}
`);

    const { diagnostics } = await manager.touchFileAndWait(file, 15000);
    const errors = diagnostics.filter(d => d.severity === 1);

    assert(errors.length === 0, `Expected no errors, got: ${errors.map(d => d.message).join(", ")}`);
  } finally {
    await manager.shutdown();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// ============================================================================
// Kotlin
// ============================================================================

test("kotlin: detects syntax errors", async () => {
  if (!commandExists("kotlin-language-server")) {
    skip("kotlin-language-server not installed");
  }

  const dir = await mkdtemp(join(tmpdir(), "lsp-kt-"));
  const manager = new LSPManager(dir);

  try {
    // Minimal Gradle markers so the LSP picks a root
    await writeFile(join(dir, "settings.gradle.kts"), "rootProject.name = \"test\"\n");
    await writeFile(join(dir, "build.gradle.kts"), "// empty\n");

    await mkdir(join(dir, "src/main/kotlin"), { recursive: true });
    const file = join(dir, "src/main/kotlin/Main.kt");

    // Syntax error
    await writeFile(file, "fun main() { val x = }\n");

    const { diagnostics, receivedResponse } = await manager.touchFileAndWait(file, 30000);

    assert(receivedResponse, "Expected Kotlin LSP to respond");
    assert(diagnostics.length > 0, `Expected errors, got ${diagnostics.length}`);
  } finally {
    await manager.shutdown();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("kotlin: valid code has no errors", async () => {
  if (!commandExists("kotlin-language-server")) {
    skip("kotlin-language-server not installed");
  }

  const dir = await mkdtemp(join(tmpdir(), "lsp-kt-"));
  const manager = new LSPManager(dir);

  try {
    await writeFile(join(dir, "settings.gradle.kts"), "rootProject.name = \"test\"\n");
    await writeFile(join(dir, "build.gradle.kts"), "// empty\n");

    await mkdir(join(dir, "src/main/kotlin"), { recursive: true });
    const file = join(dir, "src/main/kotlin/Main.kt");

    await writeFile(file, "fun main() { val x = 1; println(x) }\n");

    const { diagnostics, receivedResponse } = await manager.touchFileAndWait(file, 30000);

    assert(receivedResponse, "Expected Kotlin LSP to respond");
    const errors = diagnostics.filter(d => d.severity === 1);
    assert(errors.length === 0, `Expected no errors, got: ${errors.map(d => d.message).join(", ")}`);
  } finally {
    await manager.shutdown();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// ============================================================================
// Python
// ============================================================================

test("python: detects type errors", async () => {
  if (!commandExists("pyright-langserver")) {
    skip("pyright-langserver not installed");
  }

  const dir = await mkdtemp(join(tmpdir(), "lsp-py-"));
  const manager = new LSPManager(dir);

  try {
    await writeFile(join(dir, "pyproject.toml"), `[project]\nname = "test"`);

    const file = join(dir, "main.py");
    // Type error with type annotation
    await writeFile(file, `
def greet(name: str) -> str:
    return "Hello, " + name

x: str = 123  # Type error
result = greet(456)  # Type error
`);

    const { diagnostics } = await manager.touchFileAndWait(file, 10000);

    assert(diagnostics.length > 0, `Expected errors, got ${diagnostics.length}`);
  } finally {
    await manager.shutdown();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("python: valid code has no errors", async () => {
  if (!commandExists("pyright-langserver")) {
    skip("pyright-langserver not installed");
  }

  const dir = await mkdtemp(join(tmpdir(), "lsp-py-"));
  const manager = new LSPManager(dir);

  try {
    await writeFile(join(dir, "pyproject.toml"), `[project]\nname = "test"`);

    const file = join(dir, "main.py");
    await writeFile(file, `
def greet(name: str) -> str:
    return "Hello, " + name

x: str = "world"
result = greet(x)
`);

    const { diagnostics } = await manager.touchFileAndWait(file, 10000);
    const errors = diagnostics.filter(d => d.severity === 1);

    assert(errors.length === 0, `Expected no errors, got: ${errors.map(d => d.message).join(", ")}`);
  } finally {
    await manager.shutdown();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// ============================================================================
// Rename (TypeScript)
// ============================================================================

test("typescript: rename symbol", async () => {
  if (!commandExists("typescript-language-server")) {
    skip("typescript-language-server not installed");
  }

  const dir = await mkdtemp(join(tmpdir(), "lsp-ts-rename-"));
  const manager = new LSPManager(dir);

  try {
    await writeFile(join(dir, "package.json"), "{}");
    await writeFile(join(dir, "tsconfig.json"), JSON.stringify({
      compilerOptions: { strict: true, noEmit: true }
    }));

    const file = join(dir, "index.ts");
    await writeFile(file, `function greet(name: string) {
  return "Hello, " + name;
}
const result = greet("world");
`);

    // Touch file first to ensure it's loaded
    await manager.touchFileAndWait(file, 10000);

    // Rename 'greet' at line 1, col 10
    const edit = await manager.rename(file, 1, 10, "sayHello");

    if (!edit) throw new Error("Expected rename to return WorkspaceEdit");
    assert(
      edit.changes !== undefined || edit.documentChanges !== undefined,
      "Expected changes or documentChanges in WorkspaceEdit"
    );

    // Should have edits for both the function definition and the call
    const allEdits: any[] = [];
    if (edit.changes) {
      for (const edits of Object.values(edit.changes)) {
        allEdits.push(...(edits as any[]));
      }
    }
    if (edit.documentChanges) {
      for (const change of edit.documentChanges as any[]) {
        if (change.edits) allEdits.push(...change.edits);
      }
    }

    assert(allEdits.length >= 2, `Expected at least 2 edits (definition + usage), got ${allEdits.length}`);
  } finally {
    await manager.shutdown();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// ============================================================================
// Code Actions (TypeScript)
// ============================================================================

test("typescript: get code actions for error", async () => {
  if (!commandExists("typescript-language-server")) {
    skip("typescript-language-server not installed");
  }

  const dir = await mkdtemp(join(tmpdir(), "lsp-ts-actions-"));
  const manager = new LSPManager(dir);

  try {
    await writeFile(join(dir, "package.json"), "{}");
    await writeFile(join(dir, "tsconfig.json"), JSON.stringify({
      compilerOptions: { strict: true, noEmit: true }
    }));

    const file = join(dir, "index.ts");
    // Missing import - should offer "Add import" code action
    await writeFile(file, `const x: Promise<string> = Promise.resolve("hello");
console.log(x);
`);

    // Touch to get diagnostics first
    await manager.touchFileAndWait(file, 10000);

    // Get code actions at line 1
    const actions = await manager.getCodeActions(file, 1, 1, 1, 50);

    // May or may not have actions depending on the code, but shouldn't throw
    assert(Array.isArray(actions), "Expected array of code actions");
  } finally {
    await manager.shutdown();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("typescript: code actions for missing function", async () => {
  if (!commandExists("typescript-language-server")) {
    skip("typescript-language-server not installed");
  }

  const dir = await mkdtemp(join(tmpdir(), "lsp-ts-actions2-"));
  const manager = new LSPManager(dir);

  try {
    await writeFile(join(dir, "package.json"), "{}");
    await writeFile(join(dir, "tsconfig.json"), JSON.stringify({
      compilerOptions: { strict: true, noEmit: true }
    }));

    const file = join(dir, "index.ts");
    // Call undefined function - should offer quick fix
    await writeFile(file, `const result = undefinedFunction();
`);

    await manager.touchFileAndWait(file, 10000);

    // Get code actions where the error is
    const actions = await manager.getCodeActions(file, 1, 16, 1, 33);

    // TypeScript should offer to create the function
    assert(Array.isArray(actions), "Expected array of code actions");
    // Note: we don't assert on action count since it depends on TS version
  } finally {
    await manager.shutdown();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// ============================================================================
// Config-driven integration
// ============================================================================

test("config: built-in override keeps TypeScript extensions", async () => {
  if (!commandExists("typescript-language-server")) {
    skip("typescript-language-server not installed");
  }

  const originalHome = process.env.HOME;
  const dir = await mkdtemp(join(tmpdir(), "lsp-ts-config-"));

  try {
    process.env.HOME = dir;
    await mkdir(join(dir, ".pi", "agent"), { recursive: true });
    await writeFile(join(dir, ".pi", "agent", "settings.json"), JSON.stringify({
      lsp: {
        servers: {
          typescript: { command: ["typescript-language-server", "--stdio"] },
        },
      },
    }));

    await writeFile(join(dir, "package.json"), "{}");
    await writeFile(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }));
    const file = join(dir, "index.tsx");
    await writeFile(file, `const x: string = 123;`);

    const resolved = resolveLspConfig(dir);
    const manager = new LSPManager(dir, resolved.servers, resolved.fingerprint);

    try {
      const { diagnostics, receivedResponse } = await manager.touchFileAndWait(file, 10000);

      assert(receivedResponse, "Expected TypeScript LSP to respond with overridden command");
      assert(diagnostics.length > 0, "Expected diagnostics for TSX file using inherited built-in extensions");
    } finally {
      await manager.shutdown();
    }
  } finally {
    process.env.HOME = originalHome;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("config: built-in override preserves TypeScript findRoot behavior", async () => {
  if (!commandExists("typescript-language-server")) {
    skip("typescript-language-server not installed");
  }

  const originalHome = process.env.HOME;
  const dir = await mkdtemp(join(tmpdir(), "lsp-ts-deno-config-"));

  try {
    process.env.HOME = dir;
    await mkdir(join(dir, ".pi", "agent"), { recursive: true });
    await writeFile(join(dir, ".pi", "agent", "settings.json"), JSON.stringify({
      lsp: {
        servers: {
          typescript: { command: ["typescript-language-server", "--stdio"] },
        },
      },
    }));

    const projectRoot = join(dir, "nested", "ts-project");
    await mkdir(join(projectRoot, "src"), { recursive: true });
    await writeFile(join(projectRoot, "deno.json"), JSON.stringify({ tasks: {} }, null, 2));

    const file = join(projectRoot, "src", "index.ts");
    await writeFile(file, "const x: string = 123;");

    const resolved = resolveLspConfig(dir);
    const typescript = resolved.servers.find((server) => server.id === "typescript");
    assert(typescript !== undefined, "TypeScript server should resolve with builtin override");
    assert(typescript.findRoot(file, dir) === undefined, "Deno marker should disable builtin TypeScript root detection");

    const manager = new LSPManager(dir, resolved.servers, resolved.fingerprint);

    try {
      const result = await manager.touchFileAndWait(file, 4000);

      assert(result.unsupported === true, "Deno project should remain unsupported when builtin root detection is preserved");
    } finally {
      await manager.shutdown();
    }
  } finally {
    process.env.HOME = originalHome;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("config: built-in disable makes Python unsupported", async () => {
  const originalHome = process.env.HOME;
  const dir = await mkdtemp(join(tmpdir(), "lsp-py-disabled-"));

  try {
    process.env.HOME = dir;
    await mkdir(join(dir, ".pi", "agent"), { recursive: true });
    await writeFile(join(dir, ".pi", "agent", "settings.json"), JSON.stringify({
      lsp: {
        servers: {
          pyright: { disabled: true },
        },
      },
    }));

    await writeFile(join(dir, "pyproject.toml"), `[project]\nname = "test"`);
    const file = join(dir, "main.py");
    await writeFile(file, `x: str = 123`);

    const resolved = resolveLspConfig(dir);
    const manager = new LSPManager(dir, resolved.servers, resolved.fingerprint);

    try {
      const result = await manager.touchFileAndWait(file, 2000);

      assert(result.unsupported === true, "Disabled Pyright should leave Python unsupported");
    } finally {
      await manager.shutdown();
    }
  } finally {
    process.env.HOME = originalHome;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("config: initialization override is preserved in resolved server config", async () => {
  const originalHome = process.env.HOME;
  const dir = await mkdtemp(join(tmpdir(), "lsp-init-config-"));

  try {
    process.env.HOME = dir;
    await mkdir(join(dir, ".pi", "agent"), { recursive: true });
    await writeFile(join(dir, ".pi", "agent", "settings.json"), JSON.stringify({
      lsp: {
        servers: {
          typescript: {
            initialization: { preferences: { includeCompletionsForModuleExports: true } },
          },
        },
      },
    }));

    const resolved = resolveLspConfig(dir);
    const typescript = resolved.servers.find((server) => server.id === "typescript");
    assert(typescript !== undefined, "Expected TypeScript server to resolve");
    assert((typescript?.initialization as any)?.preferences?.includeCompletionsForModuleExports === true, "Initialization config should survive resolution");
  } finally {
    process.env.HOME = originalHome;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("config: custom server uses generic root and responds", async () => {
  if (!commandExists("typescript-language-server")) {
    skip("typescript-language-server not installed");
  }

  const originalHome = process.env.HOME;
  const dir = await mkdtemp(join(tmpdir(), "lsp-custom-config-"));

  try {
    process.env.HOME = dir;
    await mkdir(join(dir, ".pi", "agent"), { recursive: true });
    await writeFile(join(dir, ".pi", "agent", "settings.json"), JSON.stringify({
      lsp: {
        servers: {
          typescript: { disabled: true },
          "ts-custom": {
            command: ["typescript-language-server", "--stdio"],
            extensions: [".ts"],
            initialization: { preferences: { includeCompletionsForModuleExports: true } },
          },
        },
      },
    }));

    await mkdir(join(dir, "src"), { recursive: true });
    const file = join(dir, "src", "index.ts");
    await writeFile(file, `const x: string = 123;`);

    const resolved = resolveLspConfig(dir);
    const custom = resolved.servers.find((server) => server.id === "ts-custom");
    assert(custom !== undefined, "Custom server should resolve");
    assert(custom!.extensions.includes(".ts"), "Custom server should register .ts extension");
    assert(custom!.findRoot(file, dir) === join(dir, "src"), "Generic root fallback should point to file directory");

    const manager = new LSPManager(dir, resolved.servers, resolved.fingerprint);
    try {
      const result = await manager.touchFileAndWait(file, 12000);
      assert(result.receivedResponse, "Custom server should respond for .ts file");
      assert(result.unsupported !== true, "Custom server should support .ts in resolved config");
      assert(result.diagnostics.length > 0, "Custom server should emit diagnostics for invalid TypeScript");
    } finally {
      await manager.shutdown();
    }
  } finally {
    process.env.HOME = originalHome;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("pi process: configured TypeScript server override is used instead of builtin default", async () => {
  if (!commandExists("pi")) {
    skip("pi not installed");
  }

  const originalHome = process.env.HOME;
  const dir = await mkdtemp(join(tmpdir(), "pi-lsp-e2e-"));
  const binDir = join(dir, "bin");
  const markerFile = join(dir, "server-spawns.log");
  const resultFile = join(dir, "pi-result.json");
  const fakeServerPath = join(dir, "fake-lsp-server.mjs");
  const overrideServerPath = join(binDir, "ts-override-lsp");
  const builtinServerPath = join(binDir, "typescript-language-server");
  const testExtensionPath = join(dir, "pi-lsp-e2e-extension.ts");

  const fakeServerSource = `
import fs from "node:fs";
const label = process.argv[2] || "unknown";
const markerFile = process.argv[3];
if (markerFile) fs.appendFileSync(markerFile, label + "\\n");
let buffer = Buffer.alloc(0);
function send(message) {
  const json = JSON.stringify(message);
  process.stdout.write(\`Content-Length: \${Buffer.byteLength(json, "utf8")}\\r\\n\\r\\n\${json}\`);
}
function publish(uri) {
  send({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: {
      uri,
      diagnostics: [{
        severity: 2,
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 1 }
        },
        message: label + " diagnostic"
      }]
    }
  });
}
function handle(message) {
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { capabilities: { textDocumentSync: 1 } } });
    return;
  }
  if (message.method === "shutdown") {
    send({ jsonrpc: "2.0", id: message.id, result: null });
    return;
  }
  if (message.method === "exit") {
    process.exit(0);
  }
  if (message.method === "textDocument/didOpen") {
    publish(message.params.textDocument.uri);
    return;
  }
  if (message.method === "textDocument/didChange" || message.method === "textDocument/didSave") {
    publish(message.params.textDocument.uri);
  }
}
function pump() {
  while (true) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
    if (headerEnd === -1) return;
    const header = buffer.slice(0, headerEnd).toString("utf8");
    const match = /Content-Length: (\\d+)/i.exec(header);
    if (!match) {
      process.exit(1);
    }
    const length = Number(match[1]);
    const frameEnd = headerEnd + 4 + length;
    if (buffer.length < frameEnd) return;
    const body = buffer.slice(headerEnd + 4, frameEnd).toString("utf8");
    buffer = buffer.slice(frameEnd);
    handle(JSON.parse(body));
  }
}
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  pump();
});
`;

  const testExtensionSource = `
import fs from "node:fs";
import path from "node:path";
import { getOrCreateManager } from ${JSON.stringify(fileURLToPath(new URL("../lsp-core.ts", import.meta.url)))};
export default function (pi) {
  pi.registerCommand("lsp-e2e-check", {
    description: "Run Pi LSP end-to-end check",
    handler: async (_args, ctx) => {
      const file = path.join(ctx.cwd, "src", "index.ts");
      const manager = getOrCreateManager(ctx.cwd);
      const result = await manager.touchFileAndWait(file, 5000);
      fs.writeFileSync(process.env.PI_LSP_E2E_RESULT, JSON.stringify({
        receivedResponse: result.receivedResponse,
        unsupported: result.unsupported === true,
        diagnostics: result.diagnostics.map((d) => d.message),
      }, null, 2), "utf8");
    }
  });
}
`;

  try {
    process.env.HOME = dir;
    await mkdir(binDir, { recursive: true });
    await mkdir(join(dir, ".pi", "agent"), { recursive: true });
    await mkdir(join(dir, "src"), { recursive: true });

    await writeFile(fakeServerPath, fakeServerSource, "utf8");
    await writeFile(overrideServerPath, `#!/usr/bin/env bash\nexec node ${JSON.stringify(fakeServerPath)} override ${JSON.stringify(markerFile)}\n`, "utf8");
    await writeFile(builtinServerPath, `#!/usr/bin/env bash\nexec node ${JSON.stringify(fakeServerPath)} builtin ${JSON.stringify(markerFile)}\n`, "utf8");
    await chmod(overrideServerPath, 0o755);
    await chmod(builtinServerPath, 0o755);

    await writeFile(join(dir, ".pi", "agent", "settings.json"), JSON.stringify({
      lsp: {
        hookMode: "disabled",
        servers: {
          typescript: {
            command: ["ts-override-lsp"],
          },
        },
      },
    }, null, 2));

    await writeFile(join(dir, "package.json"), "{}", "utf8");
    await writeFile(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }, null, 2));
    await writeFile(join(dir, "src", "index.ts"), "const x: string = 123;\n", "utf8");
    await writeFile(testExtensionPath, testExtensionSource, "utf8");

    const run = await runPiPrintCommand(
      dir,
      [LSP_HOOK_EXTENSION, LSP_TOOL_EXTENSION, testExtensionPath],
      "/lsp-e2e-check",
      {
        PATH: `${binDir}${delimiter}${process.env.PATH || ""}`,
        PI_LSP_E2E_RESULT: resultFile,
      },
    );

    assert(run.exitCode === 0, `Expected pi command to succeed. stderr: ${run.stderr || "<empty>"}`);
    assert(existsSync(resultFile), `Expected Pi command to write ${resultFile}. stdout: ${run.stdout} stderr: ${run.stderr}`);

    const markers = (await readFile(markerFile, "utf8")).trim().split(/\r?\n/).filter(Boolean);
    const result = JSON.parse(await readFile(resultFile, "utf8")) as { receivedResponse: boolean; unsupported: boolean; diagnostics: string[] };

    assert(markers.includes("override"), `Expected configured override server to spawn. Markers: ${markers.join(", ")}`);
    assert(!markers.includes("builtin"), `Expected builtin default server to stay unused. Markers: ${markers.join(", ")}`);
    assert(result.receivedResponse, "Expected Pi-driven LSP request to receive a response");
    assert(!result.unsupported, "Expected TypeScript file to be supported through configured override");
    assert(result.diagnostics.some((message) => message.includes("override diagnostic")), `Expected diagnostics from override server, got: ${result.diagnostics.join(", ")}`);
  } finally {
    process.env.HOME = originalHome;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// ============================================================================
// Run tests
// ============================================================================

async function runTests(): Promise<void> {
  console.log("Running LSP integration tests...\n");
  console.log("Note: Tests are skipped if language server is not installed.\n");

  let passed = 0;
  let failed = 0;

  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ${name}... ✓`);
      passed++;
    } catch (error) {
      if (error instanceof SkipTest) {
        console.log(`  ${name}... ⊘ (${error.message})`);
        skipped++;
      } else {
        const msg = error instanceof Error ? error.message : String(error);
        console.log(`  ${name}... ✗`);
        console.log(`    Error: ${msg}\n`);
        failed++;
      }
    }
  }

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests();
