# claude-mcp-config-manager

An **MCP App** you install into Claude Desktop that gives you an inline
UI for editing `claude_desktop_config.json` — add, remove, and update
MCP server entries without opening the file in a text editor.

## What it does

- One model-visible tool: **`open-mcp-config-manager`** — opens the panel.
- The panel then:
  - reads the current config (path resolved per-OS)
  - shows each server as an editable card (name, command, args, env)
  - lets you add servers from templates (filesystem, github, sqlite, postgres, memory) or blank
  - saves back with an atomic write and a timestamped backup of the previous file
  - **Save & restart Claude** — after a successful save it automatically
    quits and relaunches Claude Desktop so the new config takes effect
- Non-`mcpServers` keys in the JSON are preserved verbatim.

## Security notes

- The model **cannot** see your existing server list, args, or env vars —
  the read/write/restart tools are marked `visibility: ["app"]`, so only
  the UI (which you, the user, drive) can call them.
- Every write is triggered by clicking **Save & restart Claude** in the
  panel. The model has no way to add a rogue MCP server behind your
  back, and no way to restart the app on its own.
- Every save writes a `claude_desktop_config.json.bak.<timestamp>`
  next to the file first, so you can always roll back.

## OS support

Works on **macOS**, **Windows** (installer and Microsoft Store builds), and
**Linux** (community Claude Desktop builds; `XDG_CONFIG_HOME` is honored
when set). The config path, the running-status check, and the
save-and-restart flow each have per-OS implementations:

- **macOS** — graceful `osascript` quit, force-kill of leftovers, relaunch
  via `open -a Claude`.
- **Windows** — graceful window close then `Stop-Process`; relaunch via the
  Start Menu app alias (covers Store and installer builds), falling back to
  the exe that was running, then `%LOCALAPPDATA%\AnthropicClaude\claude.exe`.
- **Linux** — remembers the running binary's path before killing so it can
  relaunch exactly what ran; falls back to `claude-desktop` / `claude` on
  PATH, then the desktop entry via `gtk-launch`.

## Install into Claude Desktop

Requires Node.js 18+.

**Automatic (recommended):**

```bash
npm install -g claude-mcp-config-manager
```

The install registers the app in `claude_desktop_config.json` by itself
(idempotent; existing servers and settings are preserved, a timestamped
backup is kept, and a config file with invalid JSON is never touched).
Restart Claude Desktop and say **"Open the MCP config manager"**. On
first use Claude Desktop asks once to allow the app's tools — that
prompt is the host's own consent step and can't be pre-approved by an
installer. Set `MCP_CONFIG_MANAGER_NO_AUTOCONFIG=1` to install without
touching the config.

**Manual (alternative):**

Add this to your `claude_desktop_config.json` yourself:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Linux:** `~/.config/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
**Windows (Microsoft Store install):** `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "config-manager": {
      "command": "npx",
      "args": ["-y", "claude-mcp-config-manager"]
    }
  }
}
```

(On Windows, use `"command": "npx.cmd"` if plain `npx` fails to spawn.)

## Build from source

```bash
npm install
npm run build
```

Produces:

- `dist-ui/mcp-app.html` — the bundled single-file UI
- `dist/server.js` — the compiled MCP server (stdio transport)

Point your config at it with `"command": "node", "args": ["/absolute/path/to/dist/server.js"]`, or run `npm install -g .` and use the `claude-mcp-config-manager` command.

Restart Claude Desktop. Then, in a chat:

> Open the MCP config manager.

Claude will call `open-mcp-config-manager`, the panel appears, edit,
click **Save & restart Claude**. The config is written, then Claude
Desktop quits and relaunches itself with the new servers loaded. Done.

## The one caveat

Claude Desktop reads `claude_desktop_config.json` on startup, which is
why the Save button restarts the app for you: a detached helper process
(which survives the quit) closes Claude Desktop gracefully, force-kills
any leftovers, and relaunches it — via the Store app alias or the
installer exe on Windows, `osascript`/`open -a` on macOS. Your current
chat reopens when the app comes back; unsaved panel edits do not.

The panel marks its own entry with a **this app** badge and disables
its Delete button — removing it and saving would make the panel
unavailable on the next launch. If you really want it gone, edit the
config file by hand; timestamped backups cover accidents either way.

## Files

| Path                    | What it does                                                    |
| ----------------------- | --------------------------------------------------------------- |
| `server.ts`             | MCP server: opens panel + read/write tools                      |
| `mcp-app.html`          | UI shell + styles (theme via host CSS variables)                |
| `mcp-app.ts`            | UI logic (uses `App` from `@modelcontextprotocol/ext-apps`)     |
| `vite.config.ts`        | Bundles the UI into one HTML file with inlined JS/CSS           |
| `tsconfig.json`         | Vite/UI TS config                                               |
| `tsconfig.server.json`  | Server TS config (compiles `server.ts` → `dist/server.js`)      |
