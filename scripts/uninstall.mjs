#!/usr/bin/env node
/**
 * Unregister this app from Claude Desktop's claude_desktop_config.json —
 * the reverse of postinstall.mjs.
 *
 * Two ways to get here:
 *   - `claude-mcp-config-manager uninstall` (also works as
 *     `npx -y claude-mcp-config-manager uninstall`, even after the global
 *     package is gone). This is the supported path: npm 7+ never runs a
 *     package's uninstall lifecycle scripts (see "A Note on a lack of npm
 *     uninstall scripts" in npm's docs), so `npm uninstall -g` alone can't
 *     clean up — and the `npx -y` entry would keep re-fetching the package.
 *   - As the `preuninstall` hook, which only npm 6 still honors.
 *
 * Which entries count as "this app" follows the panel's own "this app"
 * badge: command/args mention the package name or this install's
 * dist/server.js. Same guarantees as postinstall: other servers and
 * non-mcpServers keys preserved, timestamped backup, atomic write, a
 * config with invalid JSON is never touched.
 *
 * Hook mode is quiet and never fails the npm uninstall; it honors
 * MCP_CONFIG_MANAGER_NO_AUTOCONFIG=1 and skips source checkouts, like
 * postinstall. Explicit mode always tries and exits non-zero on failure,
 * so it can be chained with `&& npm uninstall -g ...`.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const PKG_NAME = "claude-mcp-config-manager";
const HOOK_MODE = process.env.npm_lifecycle_event === "preuninstall";
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

  if (HOOK_MODE) {
    if (process.env.MCP_CONFIG_MANAGER_NO_AUTOCONFIG === "1") {
      log("auto-configure disabled (MCP_CONFIG_MANAGER_NO_AUTOCONFIG=1) — leaving the config alone");
      return 0;
    }
    // Only auto-unregister from a real install, not the source checkout.
    const parts = pkgDir.split(path.sep);
    if (!parts.includes("node_modules") && !parts.includes("_npx")) {
      log("source checkout — skipping auto-unregister");
      return 0;
    }
  }

  const configPath = claudeConfigPath();
  if (!fs.existsSync(configPath)) {
    log(`no config at ${configPath} — nothing to remove`);
    return 0;
  }
  const raw = fs.readFileSync(configPath, "utf-8");
  let doc = {};
  if (raw.trim()) {
    try {
      doc = JSON.parse(raw);
    } catch {
      log(`config at ${configPath} has invalid JSON — not touching it.`);
      log("Fix the file, then remove the entry by hand.");
      return 1;
    }
  }
  const servers =
    typeof doc.mcpServers === "object" && doc.mcpServers !== null ? doc.mcpServers : {};

  const selfScript = path.join(pkgDir, "dist", "server.js");
  const removed = Object.keys(servers).filter((name) => isThisApp(servers[name], selfScript));
  if (removed.length === 0) {
    log(`not registered in ${configPath} — nothing to remove`);
    return 0;
  }
  for (const name of removed) delete servers[name];

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${configPath}.bak.${ts}`;
  fs.copyFileSync(configPath, backup);
  const tmp = `${configPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, configPath);

  log(`removed ${removed.map((n) => `"${n}"`).join(", ")} from ${configPath}`);
  log(`(backup: ${backup})`);
  log("restart Claude Desktop for the change to take effect");
  return 0;
}

let code = 0;
try {
  code = main();
} catch (err) {
  log(`unregister failed: ${err?.message ?? err}`);
  code = 1;
}
// Never fail the npm uninstall over this.
process.exit(HOOK_MODE ? 0 : code);
