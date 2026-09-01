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
    const packagesDir = path.join(home, "AppData", "Local", "Packages");
    try {
      for (const entry of fsSync.readdirSync(packagesDir)) {
        if (!entry.startsWith("Claude_")) continue;
        const candidate = path.join(
          packagesDir,
          entry,
          "LocalCache",
          "Roaming",
          "Claude",
          "claude_desktop_config.json",
        );
        if (fsSync.existsSync(candidate)) return candidate;
      }
    } catch {
      // Packages dir unreadable or missing — fall through to the regular path.
    }
    const appData =
      process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
    return path.join(appData, "Claude", "claude_desktop_config.json");
  }
  return path.join(home, ".config", "Claude", "claude_desktop_config.json");
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

// ─── Server process status ──────────────────────────────────────────────
function listProcessCommandLines(): Promise<string[]> {
  return new Promise((resolve) => {
    const child =
      process.platform === "win32"
        ? spawn(
            "powershell.exe",
            [
              "-NoProfile",
              "-Command",
              "Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }",
            ],
            { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
          )
        : spawn("ps", ["-axo", "command="], {
            stdio: ["ignore", "pipe", "ignore"],
          });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", () => resolve(out.split("\n").filter(Boolean)));
    child.on("error", () => resolve([]));
    setTimeout(() => child.kill(), 8000).unref();
  });
}

// The most distinctive token of a server entry — usually the package
// name or script path — so we can spot its process in the list even
// when npx/node wrappers reshape the command line.
function statusNeedle(command: string, args: string[] | undefined): string {
  const candidates = (args ?? []).filter(
    (a) => a.length >= 5 && !a.startsWith("-"),
  );
  candidates.push(command);
  return candidates.sort((a, b) => b.length - a.length)[0] ?? command;
}

// ─── Restart Claude Desktop ─────────────────────────────────────────────
// Quitting Claude Desktop also kills this MCP server (we're its child),
// so the whole quit-wait-relaunch sequence runs in a detached helper
// process that outlives us. The initial sleep gives the tool response
// time to reach the panel before the app goes down.
function restartClaudeDetached(): { method: string } {
  if (process.platform === "win32") {
    const ps = [
      "Start-Sleep -Seconds 2",
      // Graceful close first, then force-kill whatever's left.
      "Get-Process claude -ErrorAction SilentlyContinue | ForEach-Object { $null = $_.CloseMainWindow() }",
      "Start-Sleep -Seconds 3",
      "Stop-Process -Name claude -Force -ErrorAction SilentlyContinue",
      "Start-Sleep -Seconds 1",
      // Store install: relaunch via the shell app alias; installer
      // build: via the exe under %LOCALAPPDATA%.
      "$app = (Get-StartApps | Where-Object { $_.Name -eq 'Claude' } | Select-Object -First 1).AppID",
      'if ($app) { explorer.exe "shell:AppsFolder\\$app" }',
      "else { $exe = Join-Path $env:LOCALAPPDATA 'AnthropicClaude\\claude.exe'; if (Test-Path $exe) { Start-Process $exe } }",
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
      "sleep 2; osascript -e 'tell application \"Claude\" to quit' >/dev/null 2>&1; sleep 3; open -a Claude";
    const child = spawn("/bin/sh", ["-c", sh], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return { method: "sh" };
  }
  const sh =
    "sleep 2; pkill -x claude-desktop >/dev/null 2>&1 || pkill -x claude >/dev/null 2>&1; sleep 3; " +
    "(claude-desktop >/dev/null 2>&1 &) || (claude >/dev/null 2>&1 &)";
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

// App-only: check which configured servers have a live process.
registerAppTool(
  server,
  "check-server-status",
  {
    title: "Check MCP server status",
    description:
      "Check which configured MCP servers currently have a running process (UI use only).",
    inputSchema: {
      servers: z.array(
        z.object({
          key: z.string(),
          command: z.string(),
          args: z.array(z.string()).optional(),
        }),
      ),
    },
    _meta: { ui: { resourceUri: RESOURCE_URI, visibility: ["app"] } },
  },
  async ({ servers }) => {
    const lines = (await listProcessCommandLines()).map((l) =>
      l.toLowerCase(),
    );
    const statuses: Record<string, boolean> = {};
    for (const s of servers) {
      const needle = statusNeedle(s.command, s.args).toLowerCase();
      statuses[s.key] =
        needle.length >= 3 && lines.some((l) => l.includes(needle));
    }
    return {
      content: [{ type: "text", text: "Checked MCP server process status." }],
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
  { description: "UI panel for managing claude_desktop_config.json" },
  async () => {
    const html = await fs.readFile(UI_HTML_PATH, "utf-8");
    return {
      contents: [
        { uri: RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: html },
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
