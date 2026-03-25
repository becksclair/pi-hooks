/**
 * LSP Core - Language Server Protocol client management
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
  InitializeRequest,
  InitializedNotification,
  DidOpenTextDocumentNotification,
  DidChangeTextDocumentNotification,
  DidCloseTextDocumentNotification,
  DidSaveTextDocumentNotification,
  DefinitionRequest,
  ReferencesRequest,
  HoverRequest,
  SignatureHelpRequest,
  DocumentSymbolRequest,
  RenameRequest,
  CodeActionRequest,
  DocumentDiagnosticRequest,
  WorkspaceDiagnosticRequest,
} from "vscode-languageserver-protocol/node.js";
import {
  type Diagnostic,
  type Location,
  type LocationLink,
  type DocumentSymbol,
  type SymbolInformation,
  type Hover,
  type SignatureHelp,
  type WorkspaceEdit,
  type CodeAction,
  type Command,
  DiagnosticSeverity,
  CodeActionKind,
  DocumentDiagnosticReportKind,
} from "vscode-languageserver-protocol";

const INIT_TIMEOUT_MS = 30000;
const MAX_OPEN_FILES = 30;
const IDLE_TIMEOUT_MS = 60_000;
const CLEANUP_INTERVAL_MS = 30_000;
const SETTINGS_NAMESPACE = "lsp";
const DEFAULT_HOOK_MODE = "agent_end";

export type HookMode = "edit_write" | "agent_end" | "disabled";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Raw server entry parsed from Pi settings under `lsp.servers.<id>`.
 *
 * Built-in server ids may omit `command` and/or `extensions`, inheriting the
 * defaults from `DEFAULT_LSP_SERVERS`.
 *
 * Custom server ids must provide both `command` and `extensions`.
 */
export interface RawConfiguredServerEntry {
  command?: string[];
  extensions?: string[];
  env?: Record<string, string>;
  initialization?: JsonValue;
  disabled?: boolean;
}

export type ConfiguredServerMap = Record<string, RawConfiguredServerEntry>;

export interface ParsedLspSettings {
  hookMode?: HookMode;
  servers: ConfiguredServerMap;
  invalidServerEntries: Array<{ id: string; reason: string }>;
}

interface SpawnOptions {
  command?: string[];
  env?: Record<string, string>;
  initialization?: JsonValue;
}

interface SpawnResult {
  process: ChildProcessWithoutNullStreams;
  initOptions?: JsonValue;
}

interface BuiltinServerDefinition {
  id: string;
  extensions: string[];
  findRoot: (file: string, cwd: string) => string | undefined;
  spawn: (root: string, options: SpawnOptions) => Promise<SpawnResult | undefined>;
}

export interface ResolvedServerDefinition {
  id: string;
  extensions: string[];
  findRoot: (file: string, cwd: string) => string | undefined;
  spawn: (root: string) => Promise<SpawnResult | undefined>;
  env?: Record<string, string>;
  initialization?: JsonValue;
  command?: string[];
  source: "builtin" | "custom";
}

export interface ResolvedLspConfig {
  hookMode: HookMode;
  servers: ResolvedServerDefinition[];
  fingerprint: string;
  invalidServerEntries: Array<{ id: string; reason: string }>;
}

interface OpenFile {
  version: number;
  lastAccess: number;
}

interface LSPClient {
  connection: MessageConnection;
  process: ChildProcessWithoutNullStreams;
  diagnostics: Map<string, Diagnostic[]>;
  openFiles: Map<string, OpenFile>;
  listeners: Map<string, Array<() => void>>;
  stderr: string[];
  capabilities?: unknown;
  root: string;
  closed: boolean;
}

export interface FileDiagnosticItem {
  file: string;
  diagnostics: Diagnostic[];
  status: "ok" | "timeout" | "error" | "unsupported";
  error?: string;
}

export interface FileDiagnosticsResult {
  items: FileDiagnosticItem[];
}

export const LANGUAGE_IDS: Record<string, string> = {
  // Built-in server languages
  ".dart": "dart",
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".vue": "vue",
  ".svelte": "svelte",
  ".astro": "astro",
  ".py": "python",
  ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".swift": "swift",
  // Custom server languages
  ".sh": "shellscript",
  ".bash": "shellscript",
  ".fish": "fish",
  ".nu": "nushell",
  ".nim": "nim",
  ".nimble": "nim",
  ".nims": "nim",
  ".json": "json",
  ".jsonc": "jsonc",
  ".md": "markdown",
  ".markdown": "markdown",
  ".mdown": "markdown",
  ".mkdn": "markdown",
  ".mkd": "markdown",
  ".mdwn": "markdown",
  ".mkdown": "markdown",
  ".mdx": "mdx",
  ".yaml": "yaml",
  ".yml": "yaml",
};

const SEARCH_PATHS = [
  ...(process.env.PATH?.split(path.delimiter) || []),
  "/usr/local/bin",
  "/opt/homebrew/bin",
  `${process.env.HOME}/.pub-cache/bin`,
  `${process.env.HOME}/fvm/default/bin`,
  `${process.env.HOME}/go/bin`,
  `${process.env.HOME}/.cargo/bin`,
];

function which(cmd: string): string | undefined {
  const ext = process.platform === "win32" ? ".exe" : "";
  for (const dir of SEARCH_PATHS) {
    const full = path.join(dir, cmd + ext);
    try {
      if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
    } catch {}
  }
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function normalizeEnv(env?: Record<string, string>): Record<string, string> | undefined {
  if (!env) return undefined;
  const entries = Object.entries(env).map(([key, value]) => [key, expandHome(value)]);
  return Object.fromEntries(entries);
}

function normalizeFsPath(p: string): string {
  try {
    const fn: ((p: string) => string) | undefined = (fs as typeof fs & { realpathSync?: typeof fs.realpathSync & { native?: (p: string) => string } }).realpathSync?.native || fs.realpathSync;
    return fn(p);
  } catch {
    return p;
  }
}

function findNearestFile(startDir: string, targets: string[], stopDir: string): string | undefined {
  let current = path.resolve(startDir);
  const stop = path.resolve(stopDir);
  while (current.length >= stop.length) {
    for (const t of targets) {
      const candidate = path.join(current, t);
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function findRoot(file: string, cwd: string, markers: string[]): string | undefined {
  const found = findNearestFile(path.dirname(file), markers, cwd);
  return found ? path.dirname(found) : undefined;
}

export function findGenericRoot(file: string, cwd: string): string {
  return (
    findRoot(file, cwd, [".git", "package.json", "pyproject.toml", "Cargo.toml", "go.mod"]) ||
    path.dirname(file)
  );
}

function timeout<T>(promise: Promise<T>, ms: number, name: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name} timed out`)), ms);
    promise.then(
      (r) => {
        clearTimeout(timer);
        resolve(r);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function resolveCommandPath(bin: string): string | undefined {
  if (path.isAbsolute(bin) || bin.includes(path.sep)) return expandHome(bin);
  return which(bin) || expandHome(bin);
}

function spawnCommand(root: string, command: string[], env?: Record<string, string>, initialization?: JsonValue): SpawnResult | undefined {
  const [bin, ...args] = command;
  if (!bin) return undefined;
  const resolvedBin = resolveCommandPath(bin);
  if (!resolvedBin) return undefined;
  return {
    process: spawn(resolvedBin, args, {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(normalizeEnv(env) || {}) },
    }),
    initOptions: initialization,
  };
}

function simpleSpawn(bin: string, args: string[] = ["--stdio"]) {
  return async (root: string, options: SpawnOptions) => {
    if (options.command) return spawnCommand(root, options.command, options.env, options.initialization);
    return spawnCommand(root, [bin, ...args], options.env, options.initialization);
  };
}

async function spawnChecked(cmd: string, args: string[], cwd: string, env?: Record<string, string>): Promise<ChildProcessWithoutNullStreams | undefined> {
  try {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(normalizeEnv(env) || {}) },
    });

    return await new Promise((resolve) => {
      let settled = false;

      const cleanup = () => {
        child.removeListener("exit", onExit);
        child.removeListener("error", onError);
      };

      let timer: NodeJS.Timeout | null = null;

      const finish = (value: ChildProcessWithoutNullStreams | undefined) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        cleanup();
        resolve(value);
      };

      const onExit = () => finish(undefined);
      const onError = () => finish(undefined);

      child.once("exit", onExit);
      child.once("error", onError);

      timer = setTimeout(() => finish(child), 200);
      (timer as { unref?: () => void }).unref?.();
    });
  } catch {
    return undefined;
  }
}

async function spawnWithFallback(cmd: string, argsVariants: string[][], cwd: string, env?: Record<string, string>): Promise<ChildProcessWithoutNullStreams | undefined> {
  for (const args of argsVariants) {
    const child = await spawnChecked(cmd, args, cwd, env);
    if (child) return child;
  }
  return undefined;
}

function findRootKotlin(file: string, cwd: string): string | undefined {
  const gradleRoot = findRoot(file, cwd, ["settings.gradle.kts", "settings.gradle"]);
  if (gradleRoot) return gradleRoot;

  return findRoot(file, cwd, [
    "build.gradle.kts",
    "build.gradle",
    "gradlew",
    "gradlew.bat",
    "gradle.properties",
    "pom.xml",
  ]);
}

function dirContainsNestedProjectFile(dir: string, dirSuffix: string, markerFile: string): boolean {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.endsWith(dirSuffix)) continue;
      if (fs.existsSync(path.join(dir, entry.name, markerFile))) return true;
    }
  } catch {}
  return false;
}

function findRootSwift(file: string, cwd: string): string | undefined {
  let current = path.resolve(path.dirname(file));
  const stop = path.resolve(cwd);

  while (current.length >= stop.length) {
    if (fs.existsSync(path.join(current, "Package.swift"))) return current;
    if (dirContainsNestedProjectFile(current, ".xcodeproj", "project.pbxproj")) return current;
    if (dirContainsNestedProjectFile(current, ".xcworkspace", "contents.xcworkspacedata")) return current;

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return undefined;
}

async function runCommand(cmd: string, args: string[], cwd: string): Promise<boolean> {
  return await new Promise((resolve) => {
    try {
      const p = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
      p.on("error", () => resolve(false));
      p.on("exit", (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

async function ensureJetBrainsKotlinLspInstalled(): Promise<string | undefined> {
  const allowDownload = process.env.PI_LSP_AUTO_DOWNLOAD_KOTLIN_LSP === "1" || process.env.PI_LSP_AUTO_DOWNLOAD_KOTLIN_LSP === "true";
  const installDir = path.join(os.homedir(), ".pi", "agent", "lsp", "kotlin-ls");
  const launcher = process.platform === "win32"
    ? path.join(installDir, "kotlin-lsp.cmd")
    : path.join(installDir, "kotlin-lsp.sh");

  if (fs.existsSync(launcher)) return launcher;
  if (!allowDownload) return undefined;

  const curl = which("curl");
  const unzip = which("unzip");
  if (!curl || !unzip) return undefined;

  try {
    const res = await fetch("https://api.github.com/repos/Kotlin/kotlin-lsp/releases/latest", {
      headers: { "User-Agent": "pi-lsp" },
    });
    if (!res.ok) return undefined;
    const release = await res.json() as { name?: string; tag_name?: string };
    const versionRaw = (release.name || release.tag_name || "").toString();
    const version = versionRaw.replace(/^v/, "");
    if (!version) return undefined;

    const platform = process.platform;
    const arch = process.arch;

    let kotlinArch = arch;
    if (arch === "arm64") kotlinArch = "aarch64";
    else if (arch === "x64") kotlinArch = "x64";

    let kotlinPlatform = platform;
    if (platform === "darwin") kotlinPlatform = "mac";
    else if (platform === "linux") kotlinPlatform = "linux";
    else if (platform === "win32") kotlinPlatform = "win";

    const supportedCombos = new Set(["mac-x64", "mac-aarch64", "linux-x64", "linux-aarch64", "win-x64", "win-aarch64"]);
    const combo = `${kotlinPlatform}-${kotlinArch}`;
    if (!supportedCombos.has(combo)) return undefined;

    const assetName = `kotlin-lsp-${version}-${kotlinPlatform}-${kotlinArch}.zip`;
    const url = `https://download-cdn.jetbrains.com/kotlin-lsp/${version}/${assetName}`;

    fs.mkdirSync(installDir, { recursive: true });
    const zipPath = path.join(installDir, "kotlin-lsp.zip");

    const okDownload = await runCommand(curl, ["-L", "-o", zipPath, url], installDir);
    if (!okDownload || !fs.existsSync(zipPath)) return undefined;

    const okUnzip = await runCommand(unzip, ["-o", zipPath, "-d", installDir], installDir);
    try {
      fs.rmSync(zipPath, { force: true });
    } catch {}
    if (!okUnzip) return undefined;

    if (process.platform !== "win32") {
      try {
        fs.chmodSync(launcher, 0o755);
      } catch {}
    }

    return fs.existsSync(launcher) ? launcher : undefined;
  } catch {
    return undefined;
  }
}

async function spawnKotlinLanguageServer(root: string, options: SpawnOptions): Promise<SpawnResult | undefined> {
  if (options.command) return spawnCommand(root, options.command, options.env, options.initialization);

  const explicit = process.env.PI_LSP_KOTLIN_LSP_PATH;
  if (explicit && fs.existsSync(explicit)) {
    const proc = await spawnWithFallback(explicit, [["--stdio"]], root, options.env);
    return proc ? { process: proc, initOptions: options.initialization } : undefined;
  }

  const jetbrains = which("kotlin-lsp") || which("kotlin-lsp.sh") || which("kotlin-lsp.cmd") || await ensureJetBrainsKotlinLspInstalled();
  if (jetbrains) {
    const proc = await spawnWithFallback(jetbrains, [["--stdio"]], root, options.env);
    return proc ? { process: proc, initOptions: options.initialization } : undefined;
  }

  const kls = which("kotlin-language-server");
  if (!kls) return undefined;
  const proc = await spawnWithFallback(kls, [[]], root, options.env);
  return proc ? { process: proc, initOptions: options.initialization } : undefined;
}

async function spawnSourcekitLsp(root: string, options: SpawnOptions): Promise<SpawnResult | undefined> {
  if (options.command) return spawnCommand(root, options.command, options.env, options.initialization);

  const direct = which("sourcekit-lsp");
  if (direct) {
    const proc = await spawnWithFallback(direct, [[], ["--stdio"]], root, options.env);
    return proc ? { process: proc, initOptions: options.initialization } : undefined;
  }

  const xcrun = which("xcrun");
  if (!xcrun) return undefined;
  const proc = await spawnWithFallback(xcrun, [["sourcekit-lsp"], ["sourcekit-lsp", "--stdio"]], root, options.env);
  return proc ? { process: proc, initOptions: options.initialization } : undefined;
}

async function spawnDartLanguageServer(root: string, options: SpawnOptions): Promise<SpawnResult | undefined> {
  if (options.command) return spawnCommand(root, options.command, options.env, options.initialization);

  let dart = which("dart");
  const pubspec = path.join(root, "pubspec.yaml");
  if (fs.existsSync(pubspec)) {
    try {
      const content = fs.readFileSync(pubspec, "utf-8");
      if (content.includes("flutter:") || content.includes("sdk: flutter")) {
        const flutter = which("flutter");
        if (flutter) {
          const dir = path.dirname(fs.realpathSync(flutter));
          for (const candidate of ["cache/dart-sdk/bin/dart", "../cache/dart-sdk/bin/dart"]) {
            const resolved = path.join(dir, candidate);
            if (fs.existsSync(resolved)) {
              dart = resolved;
              break;
            }
          }
        }
      }
    } catch {}
  }

  if (!dart) return undefined;
  return {
    process: spawn(dart, ["language-server", "--protocol=lsp"], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(normalizeEnv(options.env) || {}) },
    }),
    initOptions: options.initialization,
  };
}

async function spawnTypeScriptLanguageServer(root: string, options: SpawnOptions): Promise<SpawnResult | undefined> {
  if (options.command) return spawnCommand(root, options.command, options.env, options.initialization);

  const local = path.join(root, "node_modules/.bin/typescript-language-server");
  const cmd = fs.existsSync(local) ? local : which("typescript-language-server");
  if (!cmd) return undefined;
  return {
    process: spawn(cmd, ["--stdio"], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(normalizeEnv(options.env) || {}) },
    }),
    initOptions: options.initialization,
  };
}

export const DEFAULT_LSP_SERVERS: BuiltinServerDefinition[] = [
  {
    id: "dart",
    extensions: [".dart"],
    findRoot: (file, cwd) => findRoot(file, cwd, ["pubspec.yaml", "analysis_options.yaml"]),
    spawn: spawnDartLanguageServer,
  },
  {
    id: "typescript",
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
    findRoot: (file, cwd) => {
      if (findNearestFile(path.dirname(file), ["deno.json", "deno.jsonc"], cwd)) return undefined;
      return findRoot(file, cwd, ["package.json", "tsconfig.json", "jsconfig.json"]);
    },
    spawn: spawnTypeScriptLanguageServer,
  },
  {
    id: "vue",
    extensions: [".vue"],
    findRoot: (file, cwd) => findRoot(file, cwd, ["package.json", "vite.config.ts", "vite.config.js"]),
    spawn: simpleSpawn("vue-language-server"),
  },
  {
    id: "svelte",
    extensions: [".svelte"],
    findRoot: (file, cwd) => findRoot(file, cwd, ["package.json", "svelte.config.js"]),
    spawn: simpleSpawn("svelteserver"),
  },
  {
    id: "pyright",
    extensions: [".py", ".pyi"],
    findRoot: (file, cwd) => findRoot(file, cwd, ["pyproject.toml", "setup.py", "requirements.txt", "pyrightconfig.json"]),
    spawn: simpleSpawn("pyright-langserver"),
  },
  {
    id: "gopls",
    extensions: [".go"],
    findRoot: (file, cwd) => findRoot(file, cwd, ["go.work"]) || findRoot(file, cwd, ["go.mod"]),
    spawn: simpleSpawn("gopls", []),
  },
  {
    id: "kotlin",
    extensions: [".kt", ".kts"],
    findRoot: (file, cwd) => findRootKotlin(file, cwd),
    spawn: spawnKotlinLanguageServer,
  },
  {
    id: "swift",
    extensions: [".swift"],
    findRoot: (file, cwd) => findRootSwift(file, cwd),
    spawn: spawnSourcekitLsp,
  },
  {
    id: "rust-analyzer",
    extensions: [".rs"],
    findRoot: (file, cwd) => findRoot(file, cwd, ["Cargo.toml"]),
    spawn: simpleSpawn("rust-analyzer", []),
  },
];

export const LSP_SERVERS = DEFAULT_LSP_SERVERS;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepMergeObjects(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = merged[key];
    if (isPlainObject(existing) && isPlainObject(value)) merged[key] = deepMergeObjects(existing, value);
    else merged[key] = cloneJson(value);
  }
  return merged;
}

function readSettingsFile(filePath: string): Record<string, unknown> {
  try {
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function normalizeHookMode(value: unknown): HookMode | undefined {
  if (value === "edit_write" || value === "agent_end" || value === "disabled") return value;
  if (value === "turn_end") return "agent_end";
  return undefined;
}

function parseCommand(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  if (!value.every((item) => typeof item === "string" && item.length > 0)) return undefined;
  return [...value];
}

function parseExtensions(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const extensions = value.filter((item): item is string => typeof item === "string" && item.startsWith("."));
  return extensions.length === value.length ? [...extensions] : undefined;
}

function parseEnv(value: unknown): Record<string, string> | undefined {
  if (!isPlainObject(value)) return undefined;
  const entries: Array<[string, string]> = [];
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") return undefined;
    entries.push([key, item]);
  }
  return Object.fromEntries(entries);
}

function parseServerEntry(id: string, value: unknown): { entry?: RawConfiguredServerEntry; reason?: string } {
  if (!isPlainObject(value)) return { reason: `Server "${id}" must be an object` };

  const raw = value as Record<string, unknown>;
  const entry: RawConfiguredServerEntry = {};

  if ("disabled" in raw) {
    if (typeof raw.disabled !== "boolean") return { reason: `Server "${id}" has non-boolean disabled` };
    entry.disabled = raw.disabled;
  }

  if ("command" in raw) {
    const command = parseCommand(raw.command);
    if (!command) return { reason: `Server "${id}" command must be a non-empty string array` };
    entry.command = command;
  }

  if ("extensions" in raw) {
    const extensions = parseExtensions(raw.extensions);
    if (!extensions) return { reason: `Server "${id}" extensions must be a non-empty array of dot-prefixed strings` };
    entry.extensions = extensions;
  }

  if ("env" in raw) {
    const env = parseEnv(raw.env);
    if (!env) return { reason: `Server "${id}" env must be an object of strings` };
    entry.env = env;
  }

  if ("initialization" in raw) entry.initialization = cloneJson(raw.initialization as JsonValue);

  return { entry };
}

export function parseLspSettings(settings: Record<string, unknown>): ParsedLspSettings {
  const parsed: ParsedLspSettings = {
    hookMode: undefined,
    servers: {},
    invalidServerEntries: [],
  };

  const namespace = settings[SETTINGS_NAMESPACE];
  if (!isPlainObject(namespace)) return parsed;

  const hookMode = normalizeHookMode(namespace.hookMode);
  if (hookMode) parsed.hookMode = hookMode;
  else if (typeof namespace.hookEnabled === "boolean") parsed.hookMode = namespace.hookEnabled ? "edit_write" : "disabled";

  const rawServers = namespace.servers;
  if (!isPlainObject(rawServers)) return parsed;

  for (const [id, value] of Object.entries(rawServers)) {
    const { entry, reason } = parseServerEntry(id, value);
    if (entry) parsed.servers[id] = entry;
    else if (reason) parsed.invalidServerEntries.push({ id, reason });
  }

  return parsed;
}

export function loadMergedPiSettings(cwd: string): Record<string, unknown> {
  const globalSettingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
  const projectSettingsPath = path.join(cwd, ".pi", "settings.json");
  return deepMergeObjects(readSettingsFile(globalSettingsPath), readSettingsFile(projectSettingsPath));
}

function mergeParsedLspSettings(
  base: ParsedLspSettings,
  override: ParsedLspSettings,
): ParsedLspSettings {
  const servers: ConfiguredServerMap = {};
  for (const [id, entry] of Object.entries(base.servers)) {
    servers[id] = cloneJson(entry);
  }

  for (const [id, entry] of Object.entries(override.servers)) {
    const existing = servers[id];
    servers[id] = existing ? deepMergeObjects(existing, entry) : cloneJson(entry);
  }

  return {
    hookMode: override.hookMode ?? base.hookMode,
    servers,
    invalidServerEntries: [...base.invalidServerEntries, ...override.invalidServerEntries],
  };
}

export function loadMergedLspSettings(cwd: string): ParsedLspSettings {
  const globalSettingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
  const projectSettingsPath = path.join(cwd, ".pi", "settings.json");
  const globalParsed = parseLspSettings(readSettingsFile(globalSettingsPath));
  const projectParsed = parseLspSettings(readSettingsFile(projectSettingsPath));
  return mergeParsedLspSettings(globalParsed, projectParsed);
}

function resolveBuiltinServerOverride(
  builtin: BuiltinServerDefinition,
  configured: RawConfiguredServerEntry | undefined,
): ResolvedServerDefinition | undefined {
  if (configured?.disabled) return undefined;

  const extensions = configured?.extensions ? [...configured.extensions] : [...builtin.extensions];
  const command = configured?.command ? [...configured.command] : undefined;
  const env = configured?.env ? { ...configured.env } : undefined;
  const initialization = configured?.initialization !== undefined ? cloneJson(configured.initialization) : undefined;

  return {
    id: builtin.id,
    extensions,
    findRoot: builtin.findRoot,
    spawn: (root: string) => builtin.spawn(root, { command, env, initialization }),
    env,
    initialization,
    command,
    source: "builtin",
  };
}

function resolveCustomServer(id: string, configured: RawConfiguredServerEntry): ResolvedServerDefinition | undefined {
  if (configured.disabled) return undefined;
  if (!configured.command || !configured.extensions) return undefined;

  const command = [...configured.command];
  const extensions = [...configured.extensions];
  const env = configured.env ? { ...configured.env } : undefined;
  const initialization = configured.initialization !== undefined ? cloneJson(configured.initialization) : undefined;

  return {
    id,
    extensions,
    findRoot: (file: string, cwd: string) => findGenericRoot(file, cwd),
    spawn: async (root: string) => spawnCommand(root, command, env, initialization),
    env,
    initialization,
    command,
    source: "custom",
  };
}

function fingerprintServers(servers: ResolvedServerDefinition[]): string {
  const serializable = servers.map((server) => ({
    id: server.id,
    extensions: [...server.extensions],
    command: server.command ?? null,
    env: server.env ?? null,
    initialization: server.initialization ?? null,
    source: server.source,
  }));
  return JSON.stringify(serializable);
}

export function resolveLspConfig(cwd: string): ResolvedLspConfig {
  const parsed = loadMergedLspSettings(cwd);
  const builtinById = new Map(DEFAULT_LSP_SERVERS.map((server) => [server.id, server]));
  const servers: ResolvedServerDefinition[] = [];
  const invalidServerEntries = [...parsed.invalidServerEntries];

  for (const builtin of DEFAULT_LSP_SERVERS) {
    const resolved = resolveBuiltinServerOverride(builtin, parsed.servers[builtin.id]);
    if (resolved) servers.push(resolved);
  }

  for (const [id, configured] of Object.entries(parsed.servers)) {
    if (builtinById.has(id)) continue;
    const resolved = resolveCustomServer(id, configured);
    if (resolved) servers.push(resolved);
    else if (!configured.disabled) {
      invalidServerEntries.push({ id, reason: `Custom server "${id}" requires both command and extensions` });
    }
  }

  return {
    hookMode: parsed.hookMode ?? DEFAULT_HOOK_MODE,
    servers,
    fingerprint: fingerprintServers(servers),
    invalidServerEntries,
  };
}

export function getResolvedServerForFile(filePath: string, cwd: string, config: ResolvedLspConfig): ResolvedServerDefinition[] {
  const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
  const ext = path.extname(absPath);
  return config.servers.filter((server) => server.extensions.includes(ext) && !!server.findRoot(absPath, cwd));
}

let sharedManager: LSPManager | null = null;
let managerCwd: string | null = null;
let managerFingerprint: string | null = null;

/**
 * Module-level tracking of all spawned LSP child process PIDs.
 *
 * The graceful `shutdownManager()` path (via session_shutdown) sends LSP
 * shutdown/exit and removes PIDs from this set.  The `process.on('exit')`
 * handler below is the safety net for ungraceful exits — crashes, signals
 * that skip session_shutdown, etc.  It fires synchronously so only SIGKILL
 * is useful here (no event loop tick for the child to handle SIGTERM).
 */
const trackedChildPids = new Set<number>();

process.on("exit", () => {
  for (const pid of trackedChildPids) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  trackedChildPids.clear();
});

export function getOrCreateManager(cwd: string): LSPManager {
  const resolvedConfig = resolveLspConfig(cwd);
  if (!sharedManager || managerCwd !== cwd || managerFingerprint !== resolvedConfig.fingerprint) {
    sharedManager?.shutdown().catch(() => {});
    sharedManager = new LSPManager(cwd, resolvedConfig.servers, resolvedConfig.fingerprint);
    managerCwd = cwd;
    managerFingerprint = resolvedConfig.fingerprint;
  }
  return sharedManager;
}

export function getManager(): LSPManager | null {
  return sharedManager;
}

export async function shutdownManager(): Promise<void> {
  const manager = sharedManager;
  if (!manager) return;
  sharedManager = null;
  managerCwd = null;
  managerFingerprint = null;
  await manager.shutdown();
}

const MAX_CRASH_RESTARTS = 3;
const RESTART_BACKOFF_MS = 1000;

export class LSPManager {
  private clients = new Map<string, LSPClient>();
  private spawning = new Map<string, Promise<LSPClient | undefined>>();
  private broken = new Set<string>();
  private crashCounts = new Map<string, number>();
  private cleanupTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;

  constructor(
    private cwd: string,
    private servers: ResolvedServerDefinition[] = DEFAULT_LSP_SERVERS.map((server) => resolveBuiltinServerOverride(server, undefined)!),
    readonly configFingerprint = fingerprintServers(servers),
  ) {
    this.cleanupTimer = setInterval(() => this.cleanupIdleFiles(), CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
  }

  getServerRegistry(): ResolvedServerDefinition[] {
    return this.servers;
  }

  private cleanupIdleFiles() {
    const now = Date.now();
    for (const client of this.clients.values()) {
      for (const [fp, state] of client.openFiles) {
        if (now - state.lastAccess > IDLE_TIMEOUT_MS) this.closeFile(client, fp);
      }
    }
  }

  private closeFile(client: LSPClient, absPath: string) {
    if (!client.openFiles.has(absPath)) return;
    client.openFiles.delete(absPath);
    if (client.closed) return;
    try {
      void client.connection.sendNotification(DidCloseTextDocumentNotification.type, {
        textDocument: { uri: pathToFileURL(absPath).href },
      }).catch(() => {});
    } catch {}
  }

  private evictLRU(client: LSPClient) {
    if (client.openFiles.size <= MAX_OPEN_FILES) return;
    let oldest: { path: string; time: number } | null = null;
    for (const [fp, state] of client.openFiles) {
      if (!oldest || state.lastAccess < oldest.time) oldest = { path: fp, time: state.lastAccess };
    }
    if (oldest) this.closeFile(client, oldest.path);
  }

  private scheduleRestart(config: ResolvedServerDefinition, root: string, k: string) {
    const count = (this.crashCounts.get(k) ?? 0) + 1;
    this.crashCounts.set(k, count);
    if (count > MAX_CRASH_RESTARTS) {
      this.broken.add(k);
      return;
    }
    const delay = RESTART_BACKOFF_MS * count;
    setTimeout(() => {
      if (this.shuttingDown || this.broken.has(k) || this.clients.has(k) || this.spawning.has(k)) return;
      const pending = this.initClient(config, root).then((client) => {
        if (client) this.clients.set(k, client);
        return client;
      });
      this.spawning.set(k, pending);
      pending.finally(() => this.spawning.delete(k));
    }, delay);
  }

  private key(id: string, root: string) {
    return `${id}:${root}`;
  }

  private async initClient(config: ResolvedServerDefinition, root: string): Promise<LSPClient | undefined> {
    const k = this.key(config.id, root);
    try {
      const handle = await config.spawn(root);
      if (!handle) {
        this.broken.add(k);
        return undefined;
      }

      // Track the child PID for cleanup on unexpected parent exit.
      if (handle.process.pid != null) trackedChildPids.add(handle.process.pid);

      const reader = new StreamMessageReader(handle.process.stdout);
      const writer = new StreamMessageWriter(handle.process.stdin);
      const conn = createMessageConnection(reader, writer);

      handle.process.stdin?.on("error", () => {});
      handle.process.stdout?.on("error", () => {});

      const stderr: string[] = [];
      const MAX_STDERR_LINES = 200;
      handle.process.stderr?.on("data", (chunk: Buffer) => {
        try {
          const text = chunk.toString("utf-8");
          for (const line of text.split(/\r?\n/)) {
            if (!line.trim()) continue;
            stderr.push(line);
            if (stderr.length > MAX_STDERR_LINES) stderr.splice(0, stderr.length - MAX_STDERR_LINES);
          }
        } catch {}
      });
      handle.process.stderr?.on("error", () => {});

      const client: LSPClient = {
        connection: conn,
        process: handle.process,
        diagnostics: new Map(),
        openFiles: new Map(),
        listeners: new Map(),
        stderr,
        root,
        closed: false,
      };

      conn.onNotification("textDocument/publishDiagnostics", (params: { uri: string; diagnostics: Diagnostic[] }) => {
        const fpRaw = decodeURIComponent(new URL(params.uri).pathname);
        const fp = normalizeFsPath(fpRaw);

        client.diagnostics.set(fp, params.diagnostics);
        const listeners1 = client.listeners.get(fp);
        const listeners2 = fp !== fpRaw ? client.listeners.get(fpRaw) : undefined;

        listeners1?.slice().forEach((fn) => {
          try {
            fn();
          } catch {}
        });
        listeners2?.slice().forEach((fn) => {
          try {
            fn();
          } catch {}
        });
      });

      conn.onError(() => {});
      conn.onClose(() => {
        client.closed = true;
        this.clients.delete(k);
      });

      conn.onRequest("workspace/configuration", () => [handle.initOptions ?? {}]);
      conn.onRequest("window/workDoneProgress/create", () => null);
      conn.onRequest("client/registerCapability", () => {});
      conn.onRequest("client/unregisterCapability", () => {});
      conn.onRequest("workspace/workspaceFolders", () => [{ name: "workspace", uri: pathToFileURL(root).href }]);

      handle.process.on("exit", () => {
        if (handle.process.pid != null) trackedChildPids.delete(handle.process.pid);
        client.closed = true;
        this.clients.delete(k);
        this.scheduleRestart(config, root, k);
      });
      handle.process.on("error", () => {
        if (handle.process.pid != null) trackedChildPids.delete(handle.process.pid);
        client.closed = true;
        this.clients.delete(k);
        this.scheduleRestart(config, root, k);
      });

      conn.listen();

      const initResult = await timeout(conn.sendRequest(InitializeRequest.method, {
        rootUri: pathToFileURL(root).href,
        rootPath: root,
        processId: process.pid,
        workspaceFolders: [{ name: "workspace", uri: pathToFileURL(root).href }],
        initializationOptions: handle.initOptions ?? {},
        capabilities: {
          window: { workDoneProgress: true },
          workspace: { configuration: true },
          textDocument: {
            synchronization: { didSave: true, didOpen: true, didChange: true, didClose: true },
            publishDiagnostics: { versionSupport: true },
            diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
          },
        },
      }), INIT_TIMEOUT_MS, `${config.id} init`);

      client.capabilities = (initResult as { capabilities?: unknown } | undefined)?.capabilities;

      conn.sendNotification(InitializedNotification.type, {}).catch(() => {});
      if (handle.initOptions) {
        conn.sendNotification("workspace/didChangeConfiguration", { settings: handle.initOptions }).catch(() => {});
      }
      this.crashCounts.delete(k);
      return client;
    } catch {
      this.broken.add(k);
      return undefined;
    }
  }

  async getClientsForFile(filePath: string): Promise<LSPClient[]> {
    const ext = path.extname(filePath);
    const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(this.cwd, filePath);
    const clients: LSPClient[] = [];

    for (const config of this.servers) {
      if (!config.extensions.includes(ext)) continue;
      const root = config.findRoot(absPath, this.cwd);
      if (!root) continue;
      const k = this.key(config.id, root);
      if (this.broken.has(k)) continue;

      const existing = this.clients.get(k);
      if (existing) {
        clients.push(existing);
        continue;
      }

      if (!this.spawning.has(k)) {
        const pending = this.initClient(config, root);
        this.spawning.set(k, pending);
        pending.finally(() => this.spawning.delete(k));
      }
      const client = await this.spawning.get(k);
      if (client) {
        this.clients.set(k, client);
        clients.push(client);
      }
    }
    return clients;
  }

  private resolve(fp: string) {
    const abs = path.isAbsolute(fp) ? fp : path.resolve(this.cwd, fp);
    return normalizeFsPath(abs);
  }

  private langId(fp: string) {
    return LANGUAGE_IDS[path.extname(fp)] || "plaintext";
  }

  private readFile(fp: string): string | null {
    try {
      return fs.readFileSync(fp, "utf-8");
    } catch {
      return null;
    }
  }

  private explainNoLsp(absPath: string): string {
    const ext = path.extname(absPath);
    const candidates = this.servers.filter((server) => server.extensions.includes(ext));
    if (candidates.length === 0) return `No LSP for ${ext}`;

    if (ext === ".kt" || ext === ".kts") {
      const root = findRootKotlin(absPath, this.cwd);
      if (!root) return "No Kotlin project root detected (looked for settings.gradle(.kts), build.gradle(.kts), gradlew, pom.xml under cwd)";

      const hasJetbrains = !!(which("kotlin-lsp") || which("kotlin-lsp.sh") || which("kotlin-lsp.cmd") || process.env.PI_LSP_KOTLIN_LSP_PATH);
      const hasKls = !!which("kotlin-language-server");

      if (!hasJetbrains && !hasKls) {
        return "No Kotlin LSP binary found. Install Kotlin/kotlin-lsp (recommended) or org.javacs/kotlin-language-server.";
      }

      const k = this.key("kotlin", root);
      if (this.broken.has(k)) return `Kotlin LSP failed to initialize for root: ${root}`;
      if (!hasJetbrains && hasKls) {
        return "Kotlin LSP is running via kotlin-language-server, but that server often does not produce diagnostics for Gradle/Android projects. Prefer Kotlin/kotlin-lsp.";
      }
      return `Kotlin LSP unavailable for root: ${root}`;
    }

    if (ext === ".swift") {
      const root = findRootSwift(absPath, this.cwd);
      if (!root) return "No Swift project root detected (looked for Package.swift, *.xcodeproj, *.xcworkspace under cwd)";
      if (!which("sourcekit-lsp") && !which("xcrun")) return "sourcekit-lsp not found (and xcrun missing)";
      const k = this.key("swift", root);
      if (this.broken.has(k)) return `sourcekit-lsp failed to initialize for root: ${root}`;
      return `Swift LSP unavailable for root: ${root}`;
    }

    const supporting = candidates.map((candidate) => candidate.id).join(", ");
    return `No active LSP for ${ext} (candidate servers: ${supporting})`;
  }

  private toPos(line: number, col: number) {
    return { line: Math.max(0, line - 1), character: Math.max(0, col - 1) };
  }

  private normalizeLocs(result: Location | Location[] | LocationLink[] | null | undefined): Location[] {
    if (!result) return [];
    const items = Array.isArray(result) ? result : [result];
    if (!items.length) return [];
    if ("uri" in items[0] && "range" in items[0]) return items as Location[];
    return (items as LocationLink[]).map((item) => ({ uri: item.targetUri, range: item.targetSelectionRange ?? item.targetRange }));
  }

  private normalizeSymbols(result: DocumentSymbol[] | SymbolInformation[] | null | undefined): DocumentSymbol[] {
    if (!result?.length) return [];
    const first = result[0];
    if ("location" in first) {
      return (result as SymbolInformation[]).map((symbol) => ({
        name: symbol.name,
        kind: symbol.kind,
        range: symbol.location.range,
        selectionRange: symbol.location.range,
        detail: symbol.containerName,
        tags: symbol.tags,
        deprecated: symbol.deprecated,
        children: [],
      }));
    }
    return result as DocumentSymbol[];
  }

  private async openOrUpdate(clients: LSPClient[], absPath: string, uri: string, langId: string, content: string, evict = true) {
    const now = Date.now();
    for (const client of clients) {
      if (client.closed) continue;
      const state = client.openFiles.get(absPath);
      try {
        if (state) {
          const version = state.version + 1;
          client.openFiles.set(absPath, { version, lastAccess: now });
          void client.connection.sendNotification(DidChangeTextDocumentNotification.type, {
            textDocument: { uri, version },
            contentChanges: [{ text: content }],
          }).catch(() => {});
        } else {
          client.openFiles.set(absPath, { version: 1, lastAccess: now });
          void client.connection.sendNotification(DidOpenTextDocumentNotification.type, {
            textDocument: { uri, languageId: langId, version: 0, text: content },
          }).catch(() => {});
          void client.connection.sendNotification(DidChangeTextDocumentNotification.type, {
            textDocument: { uri, version: 1 },
            contentChanges: [{ text: content }],
          }).catch(() => {});
          if (evict) this.evictLRU(client);
        }
        void client.connection.sendNotification(DidSaveTextDocumentNotification.type, {
          textDocument: { uri },
          text: content,
        }).catch(() => {});
      } catch {}
    }
  }

  private async loadFile(filePath: string) {
    const absPath = this.resolve(filePath);
    const clients = await this.getClientsForFile(absPath);
    if (!clients.length) return null;
    const content = this.readFile(absPath);
    if (content === null) return null;
    return { clients, absPath, uri: pathToFileURL(absPath).href, langId: this.langId(absPath), content };
  }

  private waitForDiagnostics(client: LSPClient, absPath: string, timeoutMs: number, isNew: boolean): Promise<boolean> {
    return new Promise((resolve) => {
      if (client.closed) return resolve(false);

      let resolved = false;
      let settleTimer: NodeJS.Timeout | null = null;
      let listener: () => void = () => {};

      const cleanupListener = () => {
        const listeners = client.listeners.get(absPath);
        if (!listeners) return;
        const index = listeners.indexOf(listener);
        if (index !== -1) listeners.splice(index, 1);
        if (listeners.length === 0) client.listeners.delete(absPath);
      };

      const finish = (value: boolean) => {
        if (resolved) return;
        resolved = true;
        if (settleTimer) clearTimeout(settleTimer);
        clearTimeout(timer);
        cleanupListener();
        resolve(value);
      };

      listener = () => {
        if (resolved) return;

        const current = client.diagnostics.get(absPath);
        if (current && current.length > 0) return finish(true);
        if (!isNew) return finish(true);

        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(() => finish(true), 2500);
        (settleTimer as { unref?: () => void }).unref?.();
      };

      const timer = setTimeout(() => finish(false), timeoutMs);
      (timer as { unref?: () => void }).unref?.();

      const listeners = client.listeners.get(absPath) || [];
      listeners.push(listener);
      client.listeners.set(absPath, listeners);
    });
  }

  private async pullDiagnostics(client: LSPClient, absPath: string, uri: string): Promise<{ diagnostics: Diagnostic[]; responded: boolean }> {
    if (client.closed) return { diagnostics: [], responded: false };
    const capabilities = client.capabilities as { diagnosticProvider?: unknown } | undefined;
    if (!capabilities?.diagnosticProvider) return { diagnostics: [], responded: false };

    try {
      const res = await client.connection.sendRequest(DocumentDiagnosticRequest.method, {
        textDocument: { uri },
      }) as { kind?: string; items?: Diagnostic[] } | undefined;

      if (res?.kind === DocumentDiagnosticReportKind.Full) return { diagnostics: Array.isArray(res.items) ? res.items : [], responded: true };
      if (res?.kind === DocumentDiagnosticReportKind.Unchanged) return { diagnostics: client.diagnostics.get(absPath) || [], responded: true };
      if (Array.isArray(res?.items)) return { diagnostics: res.items, responded: true };
      return { diagnostics: [], responded: true };
    } catch {}

    try {
      const res = await client.connection.sendRequest(WorkspaceDiagnosticRequest.method, {
        previousResultIds: [],
      }) as { items?: Array<{ uri?: string; kind?: string; items?: Diagnostic[] }> } | undefined;

      const items = res?.items || [];
      const match = items.find((item) => item?.uri === uri);
      if (match?.kind === DocumentDiagnosticReportKind.Full) return { diagnostics: Array.isArray(match.items) ? match.items : [], responded: true };
      if (Array.isArray(match?.items)) return { diagnostics: match.items, responded: true };
      return { diagnostics: [], responded: true };
    } catch {
      return { diagnostics: [], responded: false };
    }
  }

  async touchFileAndWait(filePath: string, timeoutMs: number): Promise<{ diagnostics: Diagnostic[]; receivedResponse: boolean; unsupported?: boolean; error?: string }> {
    const absPath = this.resolve(filePath);

    if (!fs.existsSync(absPath)) return { diagnostics: [], receivedResponse: false, unsupported: true, error: "File not found" };

    const clients = await this.getClientsForFile(absPath);
    if (!clients.length) return { diagnostics: [], receivedResponse: false, unsupported: true, error: this.explainNoLsp(absPath) };

    const content = this.readFile(absPath);
    if (content === null) return { diagnostics: [], receivedResponse: false, unsupported: true, error: "Could not read file" };

    const uri = pathToFileURL(absPath).href;
    const langId = this.langId(absPath);
    const isNew = clients.some((client) => !client.openFiles.has(absPath));

    const waits = clients.map((client) => this.waitForDiagnostics(client, absPath, timeoutMs, isNew));
    await this.openOrUpdate(clients, absPath, uri, langId, content);
    const results = await Promise.all(waits);

    let responded = results.some(Boolean);
    const diagnostics: Diagnostic[] = [];
    for (const client of clients) {
      const current = client.diagnostics.get(absPath);
      if (current) diagnostics.push(...current);
    }
    if (!responded && clients.some((client) => client.diagnostics.has(absPath))) responded = true;

    if (!responded || diagnostics.length === 0) {
      const pulled = await Promise.all(clients.map((client) => this.pullDiagnostics(client, absPath, uri)));
      for (let i = 0; i < clients.length; i++) {
        const result = pulled[i];
        if (result.responded) responded = true;
        if (result.diagnostics.length) {
          clients[i].diagnostics.set(absPath, result.diagnostics);
          diagnostics.push(...result.diagnostics);
        }
      }
    }

    return { diagnostics, receivedResponse: responded };
  }

  async getDiagnosticsForFiles(files: string[], timeoutMs: number): Promise<FileDiagnosticsResult> {
    const unique = [...new Set(files.map((file) => this.resolve(file)))];
    const results: FileDiagnosticItem[] = [];
    const toClose = new Map<LSPClient, string[]>();

    for (const absPath of unique) {
      if (!fs.existsSync(absPath)) {
        results.push({ file: absPath, diagnostics: [], status: "error", error: "File not found" });
        continue;
      }

      let clients: LSPClient[];
      try {
        clients = await this.getClientsForFile(absPath);
      } catch (error) {
        results.push({ file: absPath, diagnostics: [], status: "error", error: String(error) });
        continue;
      }

      if (!clients.length) {
        results.push({ file: absPath, diagnostics: [], status: "unsupported", error: this.explainNoLsp(absPath) });
        continue;
      }

      const content = this.readFile(absPath);
      if (!content) {
        results.push({ file: absPath, diagnostics: [], status: "error", error: "Could not read file" });
        continue;
      }

      const uri = pathToFileURL(absPath).href;
      const langId = this.langId(absPath);
      const isNew = clients.some((client) => !client.openFiles.has(absPath));

      for (const client of clients) {
        if (!client.openFiles.has(absPath)) {
          if (!toClose.has(client)) toClose.set(client, []);
          toClose.get(client)?.push(absPath);
        }
      }

      const waits = clients.map((client) => this.waitForDiagnostics(client, absPath, timeoutMs, isNew));
      await this.openOrUpdate(clients, absPath, uri, langId, content, false);
      const waitResults = await Promise.all(waits);

      const diagnostics: Diagnostic[] = [];
      for (const client of clients) {
        const current = client.diagnostics.get(absPath);
        if (current) diagnostics.push(...current);
      }

      let responded = waitResults.some(Boolean) || diagnostics.length > 0;

      if (!responded || diagnostics.length === 0) {
        const pulled = await Promise.all(clients.map((client) => this.pullDiagnostics(client, absPath, uri)));
        for (let i = 0; i < clients.length; i++) {
          const result = pulled[i];
          if (result.responded) responded = true;
          if (result.diagnostics.length) {
            clients[i].diagnostics.set(absPath, result.diagnostics);
            diagnostics.push(...result.diagnostics);
          }
        }
      }

      if (!responded && !diagnostics.length) results.push({ file: absPath, diagnostics: [], status: "timeout", error: "LSP did not respond" });
      else results.push({ file: absPath, diagnostics, status: "ok" });
    }

    for (const [client, filePaths] of toClose) {
      for (const filePath of filePaths) this.closeFile(client, filePath);
    }
    for (const client of this.clients.values()) {
      while (client.openFiles.size > MAX_OPEN_FILES) this.evictLRU(client);
    }

    return { items: results };
  }

  async getDefinition(fp: string, line: number, col: number): Promise<Location[]> {
    const loaded = await this.loadFile(fp);
    if (!loaded) return [];
    await this.openOrUpdate(loaded.clients, loaded.absPath, loaded.uri, loaded.langId, loaded.content);
    const pos = this.toPos(line, col);
    const results = await Promise.all(loaded.clients.map(async (client) => {
      if (client.closed) return [];
      try {
        return this.normalizeLocs(await client.connection.sendRequest(DefinitionRequest.type, { textDocument: { uri: loaded.uri }, position: pos }));
      } catch {
        return [];
      }
    }));
    return results.flat();
  }

  async getReferences(fp: string, line: number, col: number): Promise<Location[]> {
    const loaded = await this.loadFile(fp);
    if (!loaded) return [];
    await this.openOrUpdate(loaded.clients, loaded.absPath, loaded.uri, loaded.langId, loaded.content);
    const pos = this.toPos(line, col);
    const results = await Promise.all(loaded.clients.map(async (client) => {
      if (client.closed) return [];
      try {
        return this.normalizeLocs(await client.connection.sendRequest(ReferencesRequest.type, {
          textDocument: { uri: loaded.uri },
          position: pos,
          context: { includeDeclaration: true },
        }));
      } catch {
        return [];
      }
    }));
    return results.flat();
  }

  async getHover(fp: string, line: number, col: number): Promise<Hover | null> {
    const loaded = await this.loadFile(fp);
    if (!loaded) return null;
    await this.openOrUpdate(loaded.clients, loaded.absPath, loaded.uri, loaded.langId, loaded.content);
    const pos = this.toPos(line, col);
    for (const client of loaded.clients) {
      if (client.closed) continue;
      try {
        const result = await client.connection.sendRequest(HoverRequest.type, { textDocument: { uri: loaded.uri }, position: pos });
        if (result) return result;
      } catch {}
    }
    return null;
  }

  async getSignatureHelp(fp: string, line: number, col: number): Promise<SignatureHelp | null> {
    const loaded = await this.loadFile(fp);
    if (!loaded) return null;
    await this.openOrUpdate(loaded.clients, loaded.absPath, loaded.uri, loaded.langId, loaded.content);
    const pos = this.toPos(line, col);
    for (const client of loaded.clients) {
      if (client.closed) continue;
      try {
        const result = await client.connection.sendRequest(SignatureHelpRequest.type, { textDocument: { uri: loaded.uri }, position: pos });
        if (result) return result;
      } catch {}
    }
    return null;
  }

  async getDocumentSymbols(fp: string): Promise<DocumentSymbol[]> {
    const loaded = await this.loadFile(fp);
    if (!loaded) return [];
    await this.openOrUpdate(loaded.clients, loaded.absPath, loaded.uri, loaded.langId, loaded.content);
    const results = await Promise.all(loaded.clients.map(async (client) => {
      if (client.closed) return [];
      try {
        return this.normalizeSymbols(await client.connection.sendRequest(DocumentSymbolRequest.type, { textDocument: { uri: loaded.uri } }));
      } catch {
        return [];
      }
    }));
    return results.flat();
  }

  async rename(fp: string, line: number, col: number, newName: string): Promise<WorkspaceEdit | null> {
    const loaded = await this.loadFile(fp);
    if (!loaded) return null;
    await this.openOrUpdate(loaded.clients, loaded.absPath, loaded.uri, loaded.langId, loaded.content);
    const pos = this.toPos(line, col);
    for (const client of loaded.clients) {
      if (client.closed) continue;
      try {
        const result = await client.connection.sendRequest(RenameRequest.type, {
          textDocument: { uri: loaded.uri },
          position: pos,
          newName,
        });
        if (result) return result;
      } catch {}
    }
    return null;
  }

  async getCodeActions(fp: string, startLine: number, startCol: number, endLine?: number, endCol?: number): Promise<(CodeAction | Command)[]> {
    const loaded = await this.loadFile(fp);
    if (!loaded) return [];
    await this.openOrUpdate(loaded.clients, loaded.absPath, loaded.uri, loaded.langId, loaded.content);

    const start = this.toPos(startLine, startCol);
    const end = this.toPos(endLine ?? startLine, endCol ?? startCol);
    const range = { start, end };

    const diagnostics: Diagnostic[] = [];
    for (const client of loaded.clients) {
      const fileDiagnostics = client.diagnostics.get(loaded.absPath) || [];
      for (const diagnostic of fileDiagnostics) {
        if (this.rangesOverlap(diagnostic.range, range)) diagnostics.push(diagnostic);
      }
    }

    const results = await Promise.all(loaded.clients.map(async (client) => {
      if (client.closed) return [];
      try {
        return await client.connection.sendRequest(CodeActionRequest.type, {
          textDocument: { uri: loaded.uri },
          range,
          context: { diagnostics, only: [CodeActionKind.QuickFix, CodeActionKind.Refactor, CodeActionKind.Source] },
        }) || [];
      } catch {
        return [];
      }
    }));

    return results.flat();
  }

  private rangesOverlap(
    a: { start: { line: number; character: number }; end: { line: number; character: number } },
    b: { start: { line: number; character: number }; end: { line: number; character: number } },
  ): boolean {
    if (a.end.line < b.start.line || b.end.line < a.start.line) return false;
    if (a.end.line === b.start.line && a.end.character < b.start.character) return false;
    if (b.end.line === a.start.line && b.end.character < a.start.character) return false;
    return true;
  }

  async shutdown() {
    this.shuttingDown = true;
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    // Drain any in-flight spawns so they don't re-add to this.clients after we clear it.
    const inFlight = Array.from(this.spawning.values());
    this.spawning.clear();
    await Promise.allSettled(inFlight);
    const clients = Array.from(this.clients.values());
    this.clients.clear();
    for (const client of clients) {
      const wasClosed = client.closed;
      client.closed = true;
      if (!wasClosed) {
        try {
          await Promise.race([client.connection.sendRequest("shutdown"), new Promise((resolve) => setTimeout(resolve, 1000))]);
        } catch {}
        try {
          // Await the exit notification (with a short timeout) so that
          // vscode-jsonrpc's internal write queue can flush before we destroy
          // the underlying stream via connection.end().  Firing-and-forgetting
          // here races with the synchronous connection.end() call below and
          // produces an ERR_STREAM_DESTROYED unhandled rejection.
          await Promise.race([
            client.connection.sendNotification("exit"),
            new Promise<void>((resolve) => setTimeout(resolve, 200)),
          ]);
        } catch {}
      }
      try {
        client.connection.end();
      } catch {}
      try {
        client.process.kill();
      } catch {}
      if (client.process.pid != null) trackedChildPids.delete(client.process.pid);
    }
  }
}

export { DiagnosticSeverity };
export type SeverityFilter = "all" | "error" | "warning" | "info" | "hint";

export function formatDiagnostic(diagnostic: Diagnostic): string {
  const severity = ["", "ERROR", "WARN", "INFO", "HINT"][diagnostic.severity || 1];
  return `${severity} [${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1}] ${diagnostic.message}`;
}

export function filterDiagnosticsBySeverity(diagnostics: Diagnostic[], filter: SeverityFilter): Diagnostic[] {
  if (filter === "all") return diagnostics;
  const max = { error: 1, warning: 2, info: 3, hint: 4 }[filter];
  return diagnostics.filter((diagnostic) => (diagnostic.severity || 1) <= max);
}

export function uriToPath(uri: string): string {
  if (uri.startsWith("file://")) {
    try {
      return fileURLToPath(uri);
    } catch {}
  }
  return uri;
}

export function findSymbolPosition(symbols: DocumentSymbol[], query: string): { line: number; character: number } | null {
  const q = query.toLowerCase();
  let exact: { line: number; character: number } | null = null;
  let partial: { line: number; character: number } | null = null;

  const visit = (items: DocumentSymbol[]) => {
    for (const symbol of items) {
      const name = String(symbol?.name ?? "").toLowerCase();
      const pos = symbol?.selectionRange?.start ?? symbol?.range?.start;
      if (pos && typeof pos.line === "number" && typeof pos.character === "number") {
        if (!exact && name === q) exact = pos;
        if (!partial && name.includes(q)) partial = pos;
      }
      if (symbol?.children?.length) visit(symbol.children);
    }
  };

  visit(symbols);
  return exact ?? partial;
}

export async function resolvePosition(manager: LSPManager, file: string, query: string): Promise<{ line: number; column: number } | null> {
  const symbols = await manager.getDocumentSymbols(file);
  const pos = findSymbolPosition(symbols, query);
  return pos ? { line: pos.line + 1, column: pos.character + 1 } : null;
}

export function collectSymbols(symbols: DocumentSymbol[], depth = 0, lines: string[] = [], query?: string): string[] {
  for (const symbol of symbols) {
    const name = symbol.name ?? "<unknown>";
    if (query && !name.toLowerCase().includes(query.toLowerCase())) {
      if (symbol.children?.length) collectSymbols(symbol.children, depth + 1, lines, query);
      continue;
    }
    const startPos = symbol.selectionRange?.start ?? symbol.range?.start;
    const location = startPos ? `${startPos.line + 1}:${startPos.character + 1}` : "";
    lines.push(`${"  ".repeat(depth)}${name}${location ? ` (${location})` : ""}`);
    if (symbol.children?.length) collectSymbols(symbol.children, depth + 1, lines, query);
  }
  return lines;
}
