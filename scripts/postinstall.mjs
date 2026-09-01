#!/usr/bin/env node
/**
 * postinstall: auto-register this app in Claude Desktop's
 * claude_desktop_config.json so `npm install -g claude-mcp-config-manager`
 * (or the first `npx -y claude-mcp-config-manager` run) is all it takes.
 *
 * Safety rules:
 *   - Runs only from a real install (node_modules / npx cache), never
 *     from a source checkout.
 *   - Never touches a config file with invalid JSON.
 *   - Idempotent: if any entry already runs this package, it is left
 *     exactly as it is.
 *   - Preserves all other config keys, keeps a timestamped backup, and
 *     writes atomically — same guarantees as the panel's own Save.
 *   - Opt out with MCP_CONFIG_MANAGER_NO_AUTOCONFIG=1.
 *
 * Note: Claude Desktop's tool permission prompt is the host's own
 * user-consent step and cannot (and should not) be pre-granted here.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const PKG_NAME = "claude-mcp-config-manager";
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

function main() {
  if (process.env.MCP_CONFIG_MANAGER_NO_AUTOCONFIG === "1") {
    log("auto-configure disabled (MCP_CONFIG_MANAGER_NO_AUTOCONFIG=1)");
    return;
  }

  // Only auto-configure from a real install, not the source checkout.
  const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const parts = pkgDir.split(path.sep);
  if (!parts.includes("node_modules") && !parts.includes("_npx")) {
    log("source checkout — skipping auto-configure");
    return;
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
        return;
      }
    }
  }
  if (typeof doc.mcpServers !== "object" || doc.mcpServers === null) {
    doc.mcpServers = {};
  }

  // Already registered under any name? Leave the user's entry alone.
  const already = Object.values(doc.mcpServers).some((entry) =>
    JSON.stringify(entry ?? {}).includes(PKG_NAME),
  );
  if (already) {
    log("already registered in Claude Desktop's config — nothing to do");
    return;
  }

  let name = "config-manager";
  let i = 2;
  while (Object.prototype.hasOwnProperty.call(doc.mcpServers, name)) {
    name = `config-manager-${i++}`;
  }
  doc.mcpServers[name] = {
    command: process.platform === "win32" ? "npx.cmd" : "npx",
    args: ["-y", PKG_NAME],
  };

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
}

try {
  main();
} catch (err) {
  // Never fail the npm install over this — the manual README path remains.
  log(`auto-configure skipped: ${err?.message ?? err}`);
}
