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
npx -y claude-mcp-config-manager install
```

or, if you prefer a global install, `npm install -g claude-mcp-config-manager`
— its postinstall hook registers the app the same way.

Either way the app lands in `claude_desktop_config.json` as an `npx -y`
entry (idempotent; existing servers and settings are preserved, a
timestamped backup is kept, and a config file with invalid JSON is never
touched). Restart Claude Desktop and say **"Open the MCP config
manager"**. On first use Claude Desktop asks once to allow the app's
tools — that prompt is the host's own consent step and can't be
pre-approved by an installer. `install` can be run again at any time,
e.g. to re-add the app after an `uninstall`. Set
`MCP_CONFIG_MANAGER_NO_AUTOCONFIG=1` to `npm install` without touching
the config.

A bare `npx -y claude-mcp-config-manager` (no `install`) is not a
reliable way to register: npx runs the postinstall hook only the first
time it fills its cache, shows none of its output, and on every later run
just starts the server and waits on stdin.

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

## Uninstall

```bash
npx -y claude-mcp-config-manager uninstall
npm uninstall -g claude-mcp-config-manager
```

The first command removes the app's entry from
`claude_desktop_config.json` (every other server and setting is kept, a
timestamped backup is written first, and a file with invalid JSON is
never touched); restart Claude Desktop afterwards. The second removes
the package (skip it if you never installed globally). The order doesn't
matter — `npx -y` fetches the package again if it's already gone, which
is also why removing the config entry is the step that actually matters:
the `npx -y` entry keeps working without the global install. To put the
app back later, run `npx -y claude-mcp-config-manager install`.

`npm uninstall` alone can't do this. npm 7 and later don't run a
package's `preuninstall`/`postuninstall` scripts at all (by design —
see "A Note on a lack of npm uninstall scripts" in npm's docs). On npm 6
the package's `preuninstall` hook runs the same cleanup automatically;
`MCP_CONFIG_MANAGER_NO_AUTOCONFIG=1` skips it there too.

Installed from source? `node dist/server.js uninstall` in the checkout
also removes entries that point at that checkout's `dist/server.js`.

## Build from source

```bash
npm install
npm run build
```

Produces:

- `dist-ui/mcp-app.html` — the bundled single-file UI
- `dist/server.js` — the compiled MCP server (stdio transport)

Point your config at it with `"command": "node", "args": ["/absolute/path/to/dist/server.js"]` — `node dist/server.js install` writes exactly that entry for you — or run `npm install -g .` and use the `claude-mcp-config-manager` command.

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
unavailable on the next launch. If you really want it gone, run
`claude-mcp-config-manager uninstall` (see [Uninstall](#uninstall));
timestamped backups cover accidents either way.

## Files

| Path                    | What it does                                                    |
| ----------------------- | --------------------------------------------------------------- |
| `server.ts`             | MCP server: opens panel + read/write tools                      |
| `mcp-app.html`          | UI shell + styles (theme via host CSS variables)                |
| `mcp-app.ts`            | UI logic (uses `App` from `@modelcontextprotocol/ext-apps`)     |
| `vite.config.ts`        | Bundles the UI into one HTML file with inlined JS/CSS           |
| `tsconfig.json`         | Vite/UI TS config                                               |
| `tsconfig.server.json`  | Server TS config (compiles `server.ts` → `dist/server.js`)      |
| `scripts/postinstall.mjs` | Registers the app in `claude_desktop_config.json` (`install` subcommand; npm `postinstall`) |
| `scripts/uninstall.mjs` | Removes it again (`uninstall` subcommand; npm 6 `preuninstall`) |
