#!/usr/bin/env node
/**
 * MCP Config Manager — an MCP App for Claude Desktop that lets you
 * add, edit, and remove MCP server entries in claude_desktop_config.json
 * from an interactive panel inside the chat.
 *
 * Security model:
 *   - The model can only open the panel and see the config file path.
 *   - The actual server list, commands, args, and env vars are fetched
 *     by the UI directly via app-only tools — never sent to the model.
 *   - Every write is triggered by the user clicking Save in the panel;
 *     the model has no visibility on the write tool.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/server.js at runtime  ->  ../dist-ui/mcp-app.html
const UI_HTML_PATH = path.resolve(__dirname, "..", "dist-ui", "mcp-app.html");
const RESOURCE_URI = "ui://mcp-config-manager/mcp-app.html";

// ─── Config file helpers ────────────────────────────────────────────────
function claudeConfigPath(): string {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(
      home,
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json",
    );
  }
  if (process.platform === "win32") {
    // Microsoft Store installs virtualize AppData: Claude Desktop reads its
    // own copy under Packages\Claude_*\LocalCache\Roaming, so edits must land
    // there — the regular Roaming file is ignored once the copy exists.
    const packagesDir =
      process.env.LOCALAPPDATA != null
        ? path.join(process.env.LOCALAPPDATA, "Packages")
        : path.join(home, "AppData", "Local", "Packages");
    try {
      for (const entry of fsSync.readdirSync(packagesDir)) {
        if (!entry.startsWith("Claude_")) continue;
        // Prefer the virtualized location as soon as the Store package's
        // Claude dir exists, even before the first config file is written.
        const dir = path.join(packagesDir, entry, "LocalCache", "Roaming", "Claude");
        const candidate = path.join(dir, "claude_desktop_config.json");
        if (fsSync.existsSync(candidate) || fsSync.existsSync(dir)) {
          return candidate;
        }
      }
    } catch {
      // Packages dir unreadable or missing — fall through to the regular path.
    }
    const appData =
      process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
    return path.join(appData, "Claude", "claude_desktop_config.json");
  }
  // Linux (community builds): honor XDG_CONFIG_HOME, default ~/.config.
  const xdg = process.env.XDG_CONFIG_HOME;
  const configHome =
    xdg && xdg.trim() ? xdg : path.join(home, ".config");
  return path.join(configHome, "Claude", "claude_desktop_config.json");
}

type ServerEntry = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
};
type ConfigDoc = {
  mcpServers?: Record<string, ServerEntry>;
  [key: string]: unknown;
};

type ReadResult = {
  path: string;
  exists: boolean;
  raw: string;
  config: ConfigDoc;
  parseError: string | null;
};

async function readConfigFile(): Promise<ReadResult> {
  const p = claudeConfigPath();
  try {
    const raw = await fs.readFile(p, "utf-8");
    try {
      const config = JSON.parse(raw) as ConfigDoc;
      return { path: p, exists: true, raw, config, parseError: null };
    } catch (err) {
      return {
        path: p,
        exists: true,
        raw,
        config: {},
        parseError: (err as Error).message,
      };
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { path: p, exists: false, raw: "", config: {}, parseError: null };
    }
    throw err;
  }
}

async function writeConfigFile(
  config: ConfigDoc,
): Promise<{ path: string; backup: string | null }> {
  const p = claudeConfigPath();
  await fs.mkdir(path.dirname(p), { recursive: true });

  // Timestamped backup of whatever's currently there.
  let backup: string | null = null;
  try {
    const existing = await fs.readFile(p, "utf-8");
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    backup = `${p}.bak.${ts}`;
    await fs.writeFile(backup, existing, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  // Atomic write: tmp file + rename.
  const tmp = `${p}.tmp.${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(config, null, 2) + "\n", "utf-8");
  await fs.rename(tmp, p);

  return { path: p, backup };
}

// ─── Server health probe ────────────────────────────────────────────────
// A live process is NOT proof the server works: wrappers like mcp-remote
// keep running (and retrying) even when their endpoint is dead. The only
// honest health signal for a stdio server is an actual MCP handshake, so
// each check spawns the configured command, sends `initialize`, and
// requires a valid JSON-RPC response within the timeout. The probe's
// whole process tree is killed afterwards.
const PROBE_TIMEOUT_MS = 8000;

function probeServer(
  command: string,
  args: string[],
  env: Record<string, string>,
): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        stdio: ["pipe", "pipe", "ignore"],
        env: { ...process.env, ...env },
        // POSIX: own process group so the timeout can kill npx AND the
        // node child it spawned. Windows: shell resolves npx.cmd etc.
        detached: process.platform !== "win32",
        shell: process.platform === "win32",
        windowsHide: true,
      });
    } catch {
      resolve(false);
      return;
    }

    let settled = false;
    let timer: NodeJS.Timeout;
    const killTree = () => {
      try {
        if (child.pid == null) return;
        if (process.platform === "win32") {
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          }).on("error", () => {});
        } else {
          try {
            process.kill(-child.pid, "SIGKILL"); // whole process group
          } catch {
            child.kill("SIGKILL");
          }
        }
      } catch {
        // best effort
      }
    };
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killTree();
      resolve(ok);
    };

    child.on("error", () => done(false));
    child.on("exit", () => done(false)); // died before answering

    let buf = "";
    child.stdout!.on("data", (d) => {
      buf += String(d);
      if (buf.length > 1_000_000) return done(false);
      for (const line of buf.split("\n")) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as {
            id?: unknown;
            result?: unknown;
            error?: unknown;
          };
          if (msg.id !== 1) continue;
          done(msg.result != null && msg.error == null);
          return;
        } catch {
          // partial line or non-JSON noise — keep buffering
        }
      }
    });

    child.stdin!.on("error", () => {});
    try {
      child.stdin!.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "mcp-config-manager-probe", version: "1.0.0" },
          },
        }) + "\n",
      );
    } catch {
      done(false);
      return;
    }

    timer = setTimeout(() => done(false), PROBE_TIMEOUT_MS);
  });
}

// ─── Restart Claude Desktop ─────────────────────────────────────────────
// Quitting Claude Desktop also kills this MCP server (we're its child),
// so the whole quit-wait-relaunch sequence runs in a detached helper
// process that outlives us. The initial sleep gives the tool response
// time to reach the panel before the app goes down.
function restartClaudeDetached(): { method: string } {
  if (process.platform === "win32") {
    // NOTE: each array element must be a complete PowerShell statement —
    // they are joined with ";", and `}; else {` is a parse error in PS.
    const ps = [
      // Remember how the app can be relaunched BEFORE killing it:
      // the Start Menu alias covers both Store and installer builds,
      // and the running exe's path is a fallback for portable installs.
      "$app = (Get-StartApps -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'Claude' } | Select-Object -First 1).AppID",
      "$exe = (Get-Process claude -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1).Path",
      "Start-Sleep -Seconds 2",
      // Graceful close first, then force-kill whatever's left.
      "Get-Process claude -ErrorAction SilentlyContinue | ForEach-Object { $null = $_.CloseMainWindow() }",
      "Start-Sleep -Seconds 3",
      "Stop-Process -Name claude -Force -ErrorAction SilentlyContinue",
      "Start-Sleep -Seconds 1",
      "$done = $false",
      'if ($app) { explorer.exe "shell:AppsFolder\\$app"; $done = $true }',
      // Store exes under WindowsApps can't be started directly — skip those.
      "if (-not $done -and $exe -and (Test-Path $exe) -and $exe -notlike '*WindowsApps*') { Start-Process $exe; $done = $true }",
      "if (-not $done) { $fallback = Join-Path $env:LOCALAPPDATA 'AnthropicClaude\\claude.exe'; if (Test-Path $fallback) { Start-Process $fallback } }",
    ].join("; ");
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-WindowStyle", "Hidden", "-Command", ps],
      { detached: true, stdio: "ignore", windowsHide: true },
    );
    child.unref();
    return { method: "powershell" };
  }
  if (process.platform === "darwin") {
    const sh =
      "sleep 2; " +
      "osascript -e 'tell application \"Claude\" to quit' >/dev/null 2>&1; " +
      "sleep 3; " +
      "pkill -9 -x Claude >/dev/null 2>&1; " + // force-kill leftovers
      "sleep 1; " +
      "open -a Claude";
    const child = spawn("/bin/sh", ["-c", sh], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return { method: "sh" };
  }
  // Linux (community builds go by various names). Remember the running
  // binary's path before killing so we can relaunch exactly what ran;
  // fall back to well-known command names and the desktop entry.
  const sh = [
    "sleep 2",
    'PID=$(pgrep -x claude-desktop 2>/dev/null | head -n1)',
    '[ -z "$PID" ] && PID=$(pgrep -x claude 2>/dev/null | head -n1)',
    'EXE=""',
    '[ -n "$PID" ] && EXE=$(tr "\\0" "\\n" < /proc/$PID/cmdline 2>/dev/null | head -n1)',
    // A bare interpreter can't relaunch the app on its own — ignore it.
    'case "$(basename "$EXE" 2>/dev/null)" in electron*|node) EXE="" ;; esac',
    "pkill -x claude-desktop >/dev/null 2>&1",
    "pkill -x claude >/dev/null 2>&1",
    "sleep 3",
    "pkill -9 -x claude-desktop >/dev/null 2>&1",
    "pkill -9 -x claude >/dev/null 2>&1",
    "sleep 1",
    'if [ -n "$EXE" ] && [ -x "$EXE" ]; then ("$EXE" >/dev/null 2>&1 &)',
    "elif command -v claude-desktop >/dev/null 2>&1; then (claude-desktop >/dev/null 2>&1 &)",
    "elif command -v claude >/dev/null 2>&1; then (claude >/dev/null 2>&1 &)",
    "elif command -v gtk-launch >/dev/null 2>&1; then (gtk-launch claude-desktop >/dev/null 2>&1 || gtk-launch claude >/dev/null 2>&1 &)",
    "fi",
  ].join("\n");
  const child = spawn("/bin/sh", ["-c", sh], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return { method: "sh" };
}

// ─── Server ─────────────────────────────────────────────────────────────
const server = new McpServer({
  name: "MCP Config Manager",
  version: "1.0.0",
});

// Model-visible: opens the panel. Deliberately returns only the file
// path — no server list, no env vars — so nothing sensitive lands in
// the model's context.
registerAppTool(
  server,
  "open-mcp-config-manager",
  {
    title: "Open MCP Config Manager",
    description:
      "Open an interactive panel to view and edit Claude Desktop's MCP server configuration (add, remove, or update servers without editing claude_desktop_config.json by hand).",
    inputSchema: {},
    _meta: { ui: { resourceUri: RESOURCE_URI } },
  },
  async () => {
    const p = claudeConfigPath();
    return {
      content: [
        { type: "text", text: `MCP Config Manager opened. Config file: ${p}` },
      ],
      structuredContent: { configPath: p, platform: process.platform },
    };
  },
);

// App-only: full read, contents stay inside the UI.
registerAppTool(
  server,
  "read-mcp-config",
  {
    title: "Read MCP config",
    description: "Read Claude Desktop's MCP config from disk (UI use only).",
    inputSchema: {},
    _meta: { ui: { resourceUri: RESOURCE_URI, visibility: ["app"] } },
  },
  async () => {
    const info = await readConfigFile();
    return {
      content: [{ type: "text", text: `Read config from ${info.path}` }],
      // selfScript lets the UI recognize (and hide) this manager's own
      // entry in the table while still preserving it on save.
      structuredContent: {
        ...info,
        selfScript: path.resolve(__dirname, "server.js"),
      },
    };
  },
);

// App-only: write. The model can't call this — only the panel can.
const ServerEntrySchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
});
const ConfigSchema = z
  .object({
    mcpServers: z.record(ServerEntrySchema).optional(),
  })
  .passthrough();

registerAppTool(
  server,
  "write-mcp-config",
  {
    title: "Write MCP config",
    description:
      "Persist an MCP config to disk. Creates a timestamped backup of the previous file first.",
    inputSchema: { config: ConfigSchema },
    _meta: { ui: { resourceUri: RESOURCE_URI, visibility: ["app"] } },
  },
  async ({ config }) => {
    const result = await writeConfigFile(config as ConfigDoc);
    return {
      content: [
        {
          type: "text",
          text: `Wrote ${result.path}${
            result.backup ? ` (backup: ${result.backup})` : ""
          }`,
        },
      ],
      structuredContent: result,
    };
  },
);

// App-only: probe which configured servers actually work (respond to an
// MCP initialize handshake), not merely have a process alive.
registerAppTool(
  server,
  "check-server-status",
  {
    title: "Check MCP server status",
    description:
      "Probe each configured MCP server with an MCP initialize handshake to see which ones actually respond (UI use only).",
    inputSchema: {
      servers: z.array(
        z.object({
          key: z.string(),
          command: z.string(),
          args: z.array(z.string()).optional(),
          env: z.record(z.string()).optional(),
        }),
      ),
    },
    _meta: { ui: { resourceUri: RESOURCE_URI, visibility: ["app"] } },
  },
  async ({ servers }) => {
    const results = await Promise.all(
      servers.map((s) => probeServer(s.command, s.args ?? [], s.env ?? {})),
    );
    const statuses: Record<string, boolean> = {};
    servers.forEach((s, i) => (statuses[s.key] = results[i]!));
    return {
      content: [{ type: "text", text: "Probed MCP server health." }],
      structuredContent: { statuses },
    };
  },
);

// App-only: quit and relaunch Claude Desktop so a just-saved config
// takes effect. Only the panel can call this — the user has just
// clicked Save, so the restart is user-initiated.
registerAppTool(
  server,
  "restart-claude",
  {
    title: "Restart Claude Desktop",
    description:
      "Quit and relaunch Claude Desktop so config changes take effect (UI use only).",
    inputSchema: {},
    _meta: { ui: { resourceUri: RESOURCE_URI, visibility: ["app"] } },
  },
  async () => {
    const result = restartClaudeDetached();
    return {
      content: [
        {
          type: "text",
          text: "Restarting Claude Desktop — it will close and reopen in a few seconds.",
        },
      ],
      structuredContent: result,
    };
  },
);

registerAppResource(
  server,
  "MCP Config Manager UI",
  RESOURCE_URI,
  {
    description: "UI panel for managing claude_desktop_config.json",
    _meta: { ui: { prefersBorder: false } },
  },
  async () => {
    const html = await fs.readFile(UI_HTML_PATH, "utf-8");
    return {
      contents: [
        {
          uri: RESOURCE_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: html,
          _meta: { ui: { prefersBorder: false } },
        },
      ],
    };
  },
);

// ─── Startup version sync ───────────────────────────────────────────────
// Keep the package version ahead of what's on the registry so a later
// publish never hits a conflict. Best-effort and only in a source
// checkout (the npm tarball doesn't ship scripts/), capped at 5s so an
// offline start isn't delayed. The child's output is rerouted to stderr
// because stdout is the MCP JSON-RPC channel.
async function syncPackageVersion(): Promise<void> {
  const script = path.resolve(__dirname, "..", "scripts", "auto-version.mjs");
  if (!fsSync.existsSync(script)) return;
  await new Promise<void>((resolve) => {
    const child = spawn(process.execPath, [script], {
      cwd: path.resolve(__dirname, ".."),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout.on("data", (d) => process.stderr.write(d));
    child.stderr.on("data", (d) => process.stderr.write(d));
    const timer = setTimeout(() => {
      child.kill();
      resolve();
    }, 5000);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

await syncPackageVersion();
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[mcp-config-manager] listening on stdio");
