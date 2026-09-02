#!/usr/bin/env node
/**
 * Register this app in Claude Desktop's claude_desktop_config.json.
 *
 * Two ways to get here:
 *   - As npm's `postinstall` hook, so `npm install -g claude-mcp-config-manager`
 *     is all it takes. npx runs the hook too, but only the first time it
 *     fills its cache — and it hides the output — so for npx the explicit
 *     form is the reliable one:
 *   - `claude-mcp-config-manager install` (also works as
 *     `npx -y claude-mcp-config-manager install`), which registers on every
 *     run and re-adds the app after an `uninstall`.
 *
 * Safety rules:
 *   - Never touches a config file with invalid JSON.
 *   - Idempotent: if an entry already runs this app (same test as the
 *     panel's "this app" badge), it is left exactly as it is.
 *   - Preserves all other config keys, keeps a timestamped backup, and
 *     writes atomically — same guarantees as the panel's own Save.
 *   - Hook mode never fails the npm install, honors
 *     MCP_CONFIG_MANAGER_NO_AUTOCONFIG=1, and skips source checkouts.
 *     Explicit mode always tries and exits non-zero on failure; from a
 *     source checkout it registers that checkout's dist/server.js.
 *
 * Note: Claude Desktop's tool permission prompt is the host's own
 * user-consent step and cannot (and should not) be pre-granted here.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const PKG_NAME = "claude-mcp-config-manager";
const HOOK_MODE = process.env.npm_lifecycle_event === "postinstall";
const log = (msg) => console.log(`[${PKG_NAME}] ${msg}`);

function claudeConfigPath() {
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
    const packagesDir =
      process.env.LOCALAPPDATA != null
        ? path.join(process.env.LOCALAPPDATA, "Packages")
        : path.join(home, "AppData", "Local", "Packages");
    try {
      for (const entry of fs.readdirSync(packagesDir)) {
        if (!entry.startsWith("Claude_")) continue;
        const dir = path.join(packagesDir, entry, "LocalCache", "Roaming", "Claude");
        const candidate = path.join(dir, "claude_desktop_config.json");
        if (fs.existsSync(candidate) || fs.existsSync(dir)) return candidate;
      }
    } catch {
      // Packages dir unreadable or missing — fall through.
    }
    const appData = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
    return path.join(appData, "Claude", "claude_desktop_config.json");
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  const configHome = xdg && xdg.trim() ? xdg : path.join(home, ".config");
  return path.join(configHome, "Claude", "claude_desktop_config.json");
}

// Same test the panel uses for its "this app" badge (isSelf in mcp-app.ts).
function isThisApp(entry, selfScript) {
  const norm = (s) => String(s).toLowerCase().replace(/\\/g, "/");
  const args = Array.isArray(entry?.args) ? entry.args : [];
  const hay = norm([entry?.command ?? "", ...args].join(" "));
  return hay.includes(PKG_NAME) || hay.includes(norm(selfScript));
}

function main() {
  const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const parts = pkgDir.split(path.sep);
  const installed = parts.includes("node_modules") || parts.includes("_npx");
  const selfScript = path.join(pkgDir, "dist", "server.js");

  if (HOOK_MODE) {
    if (process.env.MCP_CONFIG_MANAGER_NO_AUTOCONFIG === "1") {
      log("auto-configure disabled (MCP_CONFIG_MANAGER_NO_AUTOCONFIG=1)");
      return 0;
    }
    // Only auto-configure from a real install, not the source checkout.
    if (!installed) {
      log("source checkout — skipping auto-configure");
      return 0;
    }
  } else if (!installed && !fs.existsSync(selfScript)) {
    log(`${selfScript} not found — run \`npm run build\` first`);
    return 1;
  }

  const configPath = claudeConfigPath();
  let doc = {};
  let existed = false;
  if (fs.existsSync(configPath)) {
    existed = true;
    const raw = fs.readFileSync(configPath, "utf-8");
    if (raw.trim()) {
      try {
        doc = JSON.parse(raw);
      } catch {
        log(`existing config at ${configPath} has invalid JSON — not touching it.`);
        log("Fix the file, then add the entry by hand (see README).");
        return 1;
      }
    }
  }
  if (typeof doc.mcpServers !== "object" || doc.mcpServers === null) {
    doc.mcpServers = {};
  }

  // Already registered under any name? Leave the user's entry alone.
  const already = Object.keys(doc.mcpServers).find((name) =>
    isThisApp(doc.mcpServers[name], selfScript),
  );
  if (already) {
    log(`already registered as "${already}" in ${configPath} — nothing to do`);
    return 0;
  }

  let name = "config-manager";
  let i = 2;
  while (Object.prototype.hasOwnProperty.call(doc.mcpServers, name)) {
    name = `config-manager-${i++}`;
  }
  // An installed copy (global or npx cache) is run through npx so the
  // entry keeps working however the package was fetched; a source
  // checkout is run directly.
  doc.mcpServers[name] = installed
    ? {
        command: process.platform === "win32" ? "npx.cmd" : "npx",
        args: ["-y", PKG_NAME],
      }
    : { command: "node", args: [selfScript] };

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  if (existed) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    fs.copyFileSync(configPath, `${configPath}.bak.${ts}`);
  }
  const tmp = `${configPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, configPath);

  log(`registered as "${name}" in ${configPath}`);
  log("restart Claude Desktop, then say: Open the MCP config manager");
  log("(Claude Desktop will ask once to allow the app's tools — that prompt is the host's own consent step and can't be pre-approved.)");
  return 0;
}

let code = 0;
try {
  code = main();
} catch (err) {
  log(`${HOOK_MODE ? "auto-configure skipped" : "register failed"}: ${err?.message ?? err}`);
  code = 1;
}
// Never fail the npm install over this — the manual README path remains.
process.exit(HOOK_MODE ? 0 : code);
