import { App } from "@modelcontextprotocol/ext-apps";

// ─── Types ──────────────────────────────────────────────────────────────
type ServerEntry = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
};
type ConfigDoc = {
  mcpServers?: Record<string, ServerEntry>;
  [key: string]: unknown;
};

type Row = {
  key: string;        // stable UI id, not the server name
  name: string;
  command: string;
  argsText: string;   // one arg per line
  envText: string;    // KEY=value per line
};

type Status = { kind: "info" | "error" | "success"; msg: string } | null;

type State = {
  loading: boolean;
  configPath: string;
  fileExists: boolean;
  parseError: string | null;
  otherKeys: Record<string, unknown>; // non-mcpServers keys, preserved verbatim
  rows: Row[];
  selfScript: string; // this manager's own server script path (for hiding its row)
  editingKey: string | null; // row currently expanded in the inline editor
  // Per-row process status, keyed by row.key. Missing = still checking.
  statuses: Record<string, boolean>;
  statusesChecked: boolean;
  dirty: boolean;
  status: Status;
};

const state: State = {
  loading: true,
  configPath: "",
  fileExists: false,
  parseError: null,
  otherKeys: {},
  rows: [],
  selfScript: "",
  editingKey: null,
  statuses: {},
  statusesChecked: false,
  dirty: false,
  status: null,
};

// ─── Templates for common MCP servers ───────────────────────────────────
const TEMPLATES: Record<string, { name: string; entry: ServerEntry }> = {
  filesystem: {
    name: "filesystem",
    entry: {
      command: "npx",
      args: [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/absolute/path/to/dir",
      ],
    },
  },
  github: {
    name: "github",
    entry: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_..." },
    },
  },
  sqlite: {
    name: "sqlite",
    entry: {
      command: "npx",
      args: [
        "-y",
        "@modelcontextprotocol/server-sqlite",
        "--db-path",
        "/absolute/path/to.db",
      ],
    },
  },
  postgres: {
    name: "postgres",
    entry: {
      command: "npx",
      args: [
        "-y",
        "@modelcontextprotocol/server-postgres",
        "postgresql://user:pass@host:5432/db",
      ],
    },
  },
  memory: {
    name: "memory",
    entry: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-memory"],
    },
  },
};

// ─── Row <-> ServerEntry conversions ────────────────────────────────────
function toRow(name: string, entry: ServerEntry): Row {
  return {
    key: randKey(),
    name,
    command: entry.command,
    argsText: (entry.args ?? []).join("\n"),
    envText: Object.entries(entry.env ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
  };
}

function fromRow(row: Row): { name: string; entry: ServerEntry } | null {
  const name = row.name.trim();
  const command = row.command.trim();
  if (!name || !command) return null;

  const args = row.argsText
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const env: Record<string, string> = {};
  for (const line of row.envText
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const i = line.indexOf("=");
    if (i <= 0) continue;
    env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }

  const entry: ServerEntry = { command };
  if (args.length) entry.args = args;
  if (Object.keys(env).length) entry.env = env;
  return { name, entry };
}

function buildConfig(): ConfigDoc {
  const mcpServers: Record<string, ServerEntry> = {};
  for (const row of state.rows) {
    const converted = fromRow(row);
    if (!converted) continue;
    mcpServers[converted.name] = converted.entry;
  }
  return { ...state.otherKeys, mcpServers };
}

// The manager's own entry can't be deleted from the panel — removing it
// would make the panel itself unavailable on the next launch. Matches by
// this package's name or by the running server's own script path.
function isSelfRow(row: Row): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\\/g, "/");
  const hay = norm(`${row.command} ${row.argsText}`);
  if (hay.includes("claude-mcp-config-manager")) return true;
  const self = norm(state.selfScript);
  return self.length > 0 && hay.includes(self);
}

function randKey(): string {
  return Math.random().toString(36).slice(2, 10);
}

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c]!,
  );
}

// ─── App bridge ─────────────────────────────────────────────────────────
const app = new App({ name: "MCP Config Manager UI", version: "1.0.0" });

// Set handlers BEFORE connect() so we don't miss the initial tool result.
app.ontoolresult = (result) => {
  const sc = (result.structuredContent ?? {}) as { configPath?: string };
  if (sc.configPath) state.configPath = sc.configPath;
  // Fetch the actual config via an app-only tool so its contents
  // (paths, tokens, etc.) never leave the UI sandbox.
  void loadConfig();
};

async function loadConfig(): Promise<void> {
  try {
    const r = await app.callServerTool({
      name: "read-mcp-config",
      arguments: {},
    });
    const info = (r.structuredContent ?? {}) as {
      path: string;
      exists: boolean;
      config: ConfigDoc;
      parseError: string | null;
      selfScript?: string;
    };
    state.selfScript = info.selfScript ?? "";
    state.configPath = info.path;
    state.fileExists = info.exists;
    state.parseError = info.parseError;

    const { mcpServers = {}, ...rest } = info.config;
    state.otherKeys = rest;
    state.rows = Object.entries(mcpServers).map(([name, entry]) =>
      toRow(name, entry),
    );

    state.dirty = false;
    state.status = null;
    state.loading = false;
    render();
    void refreshStatuses();
  } catch (err) {
    state.loading = false;
    state.status = {
      kind: "error",
      msg: `Failed to read config: ${(err as Error).message ?? String(err)}`,
    };
    render();
  }
}

async function refreshStatuses(): Promise<void> {
  const servers = state.rows
    .map((row) => {
      const converted = fromRow(row);
      if (!converted) return null;
      return {
        key: row.key,
        command: converted.entry.command,
        args: converted.entry.args ?? [],
      };
    })
    .filter((s): s is NonNullable<typeof s> => s !== null);

  try {
    const r = await app.callServerTool({
      name: "check-server-status",
      arguments: { servers },
    });
    const sc = (r.structuredContent ?? {}) as {
      statuses?: Record<string, boolean>;
    };
    state.statuses = sc.statuses ?? {};
  } catch {
    state.statuses = {};
  }
  state.statusesChecked = true;

  // Patch the status cells in place — a full render would blow away
  // focus if the user is typing in the inline editor.
  for (const row of state.rows) {
    const cell = document.querySelector<HTMLElement>(
      `[data-status-for="${row.key}"]`,
    );
    if (cell) cell.innerHTML = statusBadge(row);
  }
}

function statusBadge(row: Row): string {
  if (!fromRow(row)) return `<span class="muted">—</span>`;
  if (!state.statusesChecked) return `<span class="muted">checking…</span>`;
  return state.statuses[row.key]
    ? `<span class="st running"><span class="dot"></span>Running</span>`
    : `<span class="st stopped"><span class="dot"></span>Stopped</span>`;
}

async function saveConfig(): Promise<void> {
  // Validate uniqueness of names client-side before sending.
  const names = new Map<string, number>();
  for (const row of state.rows) {
    const name = row.name.trim();
    if (!name) continue;
    names.set(name, (names.get(name) ?? 0) + 1);
  }
  const dup = [...names.entries()].find(([, n]) => n > 1);
  if (dup) {
    state.status = {
      kind: "error",
      msg: `Duplicate server name "${dup[0]}". Each server must have a unique name.`,
    };
    render();
    return;
  }

  try {
    const config = buildConfig();
    const r = await app.callServerTool({
      name: "write-mcp-config",
      arguments: { config },
    });
    const info = (r.structuredContent ?? {}) as {
      path: string;
      backup: string | null;
    };
    state.dirty = false;
    const backupName = info.backup?.split(/[/\\]/).pop();
    state.status = {
      kind: "success",
      msg: backupName
        ? `Saved (backup: ${backupName}). Restarting Claude Desktop…`
        : `Saved. Restarting Claude Desktop…`,
    };
    render();
    await restartClaude();
  } catch (err) {
    state.status = {
      kind: "error",
      msg: `Save failed: ${(err as Error).message ?? String(err)}`,
    };
    render();
  }
}

async function restartClaude(): Promise<void> {
  try {
    await app.callServerTool({ name: "restart-claude", arguments: {} });
    // Claude Desktop closes a couple of seconds after this returns;
    // the panel disappears with it and the new config loads on relaunch.
  } catch (err) {
    state.status = {
      kind: "error",
      msg: `Saved, but restart failed: ${(err as Error).message ?? String(err)}. Restart Claude Desktop manually to load the changes.`,
    };
    render();
  }
}

// ─── Rendering ──────────────────────────────────────────────────────────
const root = document.getElementById("root")!;

function render(): void {
  if (state.loading) {
    root.innerHTML = `<div class="loading">Loading MCP config…</div>`;
    return;
  }

  const parseWarning = state.parseError
    ? `<div class="alert error">The existing config file has invalid JSON:
         <code>${esc(state.parseError)}</code>.
         Saving from this panel will overwrite it (a backup is kept).</div>`
    : "";

  root.innerHTML = `
    <div class="app">
      <header>
        ${state.fileExists ? "" : `<div class="alert info">No config file yet — it will be created on first save.</div>`}
        ${parseWarning}
      </header>

      <section class="servers">
        <div class="toolbar">
          <span class="title">Servers <span class="count">${state.rows.length}</span></span>
          <span class="spacer"></span>
          <select id="template" title="Add a preconfigured server">
            <option value="">from template…</option>
            ${Object.keys(TEMPLATES)
              .map(
                (k) => `<option value="${k}">${esc(TEMPLATES[k]!.name)}</option>`,
              )
              .join("")}
          </select>
          <button id="add" class="primary">＋ New server</button>
        </div>
        ${
          state.rows.length
            ? renderTable()
            : `<div class="empty">No MCP servers configured yet — click <b>＋ New server</b> or pick a template.</div>`
        }
      </section>

      ${state.status ? `<div class="alert ${state.status.kind}">${esc(state.status.msg)}</div>` : ""}

      <footer>
        <button id="reload" title="Discard changes and reload from disk">Reload</button>
        <button id="save" class="primary" ${state.dirty ? "" : "disabled"}
                title="Save the config and restart Claude Desktop to load it">
          ${state.dirty ? "Save &amp; restart Claude" : "No changes"}
        </button>
      </footer>
    </div>
  `;

  // Wire up controls
  document
    .getElementById("template")!
    .addEventListener("change", onTemplateChange);
  document
    .getElementById("add")!
    .addEventListener("click", () => addServer());
  document
    .getElementById("reload")!
    .addEventListener("click", () => void loadConfig());
  document
    .getElementById("save")!
    .addEventListener("click", () => void saveConfig());

  for (const btn of Array.from(
    document.querySelectorAll<HTMLButtonElement>("button.edit"),
  )) {
    btn.addEventListener("click", () => toggleEdit(btn.dataset.key!));
  }
  for (const btn of Array.from(
    document.querySelectorAll<HTMLButtonElement>("button.delete"),
  )) {
    btn.addEventListener("click", () => removeRow(btn.dataset.key!));
  }

  const editing = state.rows.find((r) => r.key === state.editingKey);
  if (editing) {
    const el = document.querySelector<HTMLElement>(
      `[data-row="${editing.key}"]`,
    );
    if (el) {
      bindInput(el, ".name", "name", editing.key);
      bindInput(el, ".command", "command", editing.key);
      bindInput(el, ".args", "argsText", editing.key);
      bindInput(el, ".env", "envText", editing.key);
      el.querySelector<HTMLInputElement>(".name")?.focus();
    }
  }
}

function bindInput(
  container: HTMLElement,
  selector: string,
  field: keyof Row,
  key: string,
): void {
  const el = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    selector,
  );
  if (!el) return;
  el.addEventListener("input", () => updateRow(key, field, el.value));
}

function renderTable(): string {
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Name</th><th>Status</th><th>Command</th><th>Args</th><th>Env</th>
            <th class="cell-actions"></th>
          </tr>
        </thead>
        <tbody>${state.rows.map(renderRow).join("")}</tbody>
      </table>
    </div>
  `;
}

function renderRow(row: Row): string {
  const args = row.argsText
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const envCount = row.envText
    .split("\n")
    .map((s) => s.trim())
    .filter((l) => l.indexOf("=") > 0).length;
  const editing = state.editingKey === row.key;
  const self = isSelfRow(row);

  const main = `
    <tr class="server${editing ? " editing" : ""}">
      <td class="cell-name">${row.name ? esc(row.name) : `<span class="unnamed">(unnamed)</span>`}${self ? ` <span class="badge">this app</span>` : ""}</td>
      <td class="cell-status" data-status-for="${row.key}">${statusBadge(row)}</td>
      <td class="cell-cmd"><code>${esc(row.command) || `<span class="muted">—</span>`}</code></td>
      <td class="cell-args" title="${esc(args.join(" "))}">${esc(args.join(" ")) || `<span class="muted">—</span>`}</td>
      <td class="cell-env">${envCount ? `${envCount} var${envCount > 1 ? "s" : ""}` : `<span class="muted">—</span>`}</td>
      <td class="cell-actions">
        <button class="edit small${editing ? " primary" : ""}" data-key="${row.key}">${editing ? "Done" : "Edit"}</button>
        <button class="delete small danger" data-key="${row.key}" ${self ? "disabled" : ""}
                title="${self ? "The config manager can't remove its own entry — the panel would disappear on next launch" : "Remove this server"}">Delete</button>
      </td>
    </tr>
  `;
  if (!editing) return main;

  return (
    main +
    `
    <tr class="editor-row"><td colspan="6">
      <div class="editor" data-row="${row.key}">
        <div class="editor-grid">
          <label>Name
            <input class="name" placeholder="server name" value="${esc(row.name)}" spellcheck="false" />
          </label>
          <label>Command
            <input class="command" placeholder="npx, node, python, dotnet, …"
                   value="${esc(row.command)}" spellcheck="false" />
          </label>
        </div>
        <label>Args (one per line)
          <textarea class="args" rows="6" spellcheck="false"
                    placeholder="-y&#10;@modelcontextprotocol/server-filesystem&#10;/path">${esc(row.argsText)}</textarea>
        </label>
        <label>Env (KEY=value per line, optional)
          <textarea class="env" rows="2" spellcheck="false"
                    placeholder="GITHUB_PERSONAL_ACCESS_TOKEN=ghp_...">${esc(row.envText)}</textarea>
        </label>
      </div>
    </td></tr>
  `
  );
}

function toggleEdit(key: string): void {
  state.editingKey = state.editingKey === key ? null : key;
  render();
}

function addServer(tpl?: { name: string; entry: ServerEntry }): void {
  let row: Row;
  if (tpl) {
    // Ensure a unique name if the template default already exists.
    const existing = new Set(state.rows.map((r) => r.name));
    let name = tpl.name;
    let i = 2;
    while (existing.has(name)) name = `${tpl.name}-${i++}`;
    row = toRow(name, tpl.entry);
  } else {
    row = toRow("", { command: "" });
  }
  state.rows.push(row);
  state.editingKey = row.key;
  state.dirty = true;
  state.status = null;
  render();
}

function updateRow(key: string, field: keyof Row, value: string): void {
  const row = state.rows.find((r) => r.key === key);
  if (!row) return;
  (row as unknown as Record<string, string>)[field as string] = value;
  if (!state.dirty) {
    state.dirty = true;
    state.status = null;
    // Cheap partial refresh: just re-enable Save without rerendering
    // the whole tree (which would blow away focus on the input).
    const save = document.getElementById("save") as HTMLButtonElement | null;
    if (save) {
      save.disabled = false;
      save.textContent = "Save & restart Claude";
    }
  }
}

function removeRow(key: string): void {
  const row = state.rows.find((r) => r.key === key);
  if (!row || isSelfRow(row)) return;
  state.rows = state.rows.filter((r) => r.key !== key);
  if (state.editingKey === key) state.editingKey = null;
  state.dirty = true;
  state.status = null;
  render();
}

function onTemplateChange(e: Event): void {
  const sel = e.target as HTMLSelectElement;
  const tpl = TEMPLATES[sel.value];
  sel.value = "";
  if (tpl) addServer(tpl);
}

// ─── Boot ───────────────────────────────────────────────────────────────
app.connect();
