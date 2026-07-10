import React, { useEffect, useState } from "react";
import type {
  ConnectorInfo, ConnectorEvent, DeviceCodePrompt, CustomMcpInput, McpToolInfo,
  ModelSettings, AccountList, Permissions, PermEdit, SkillInfo, UsageSummary, ModelUsage, Theme,
} from "../../../electron/ipc";
import {
  ACCENT_PRESETS, applyAccent, DEFAULT_ACCENT,
  applyMode, applyFont, applyReduceMotion, DEFAULT_MODE, DEFAULT_FONT,
} from "../theme";
import { Icon, MicrosoftMark } from "./Icon";

type Section = "general" | "theme" | "account" | "models" | "permissions" | "connectors" | "skills" | "usage" | "plugins";
type Tab = "all" | "connected" | "not";

export function Settings({ onClose }: { onClose: () => void }): React.ReactElement {
  const [section, setSection] = useState<Section>("general");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="settings" onClick={(e) => e.stopPropagation()}>
        <button className="settings-close" onClick={onClose} title="Close (Esc)"><Icon name="close" size={16} /></button>
        <nav className="settings-nav">
          <div className="nav-group-label">Settings</div>
          <NavItem label="General" on={section === "general"} onClick={() => setSection("general")} />
          <NavItem label="Theme" on={section === "theme"} onClick={() => setSection("theme")} />
          <NavItem label="Account" on={section === "account"} onClick={() => setSection("account")} />
          <NavItem label="Models & Providers" on={section === "models"} onClick={() => setSection("models")} />
          <NavItem label="Permissions" on={section === "permissions"} onClick={() => setSection("permissions")} />
          <NavItem label="Usage" on={section === "usage"} onClick={() => setSection("usage")} />
          <div className="nav-group-label">Customize</div>
          <NavItem label="Connectors" on={section === "connectors"} onClick={() => setSection("connectors")} />
          <NavItem label="Skills" on={section === "skills"} onClick={() => setSection("skills")} />
          <NavItem label="Plugins" on={section === "plugins"} onClick={() => setSection("plugins")} />
        </nav>
        <div className="settings-body">
          {section === "connectors" && <Connectors />}
          {section === "theme" && <ThemePanel />}
          {section === "models" && <ModelsPanel />}
          {section === "account" && <AccountPanel />}
          {section === "permissions" && <PermissionsPanel />}
          {section === "skills" && <SkillsPanel />}
          {section === "usage" && <UsagePanel />}
          {section === "general" && <GeneralPanel />}
          {section === "plugins" && <Stub name="plugins" />}
        </div>
      </div>
    </div>
  );
}

function NavItem({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }): React.ReactElement {
  return (
    <button className={`nav-item ${on ? "active" : ""}`} onClick={onClick}>
      {label}
    </button>
  );
}

function Stub({ name }: { name: string }): React.ReactElement {
  return (
    <div className="settings-panel">
      <h2 className="panel-title">{name[0].toUpperCase() + name.slice(1)}</h2>
      <p className="stub">Nothing here yet.</p>
    </div>
  );
}

function Connectors(): React.ReactElement {
  const [list, setList] = useState<ConnectorInfo[]>([]);
  const [tab, setTab] = useState<Tab>("all");
  const [prompt, setPrompt] = useState<DeviceCodePrompt | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const refresh = () => void window.mycode.listConnectors().then(setList).catch(() => {});
  useEffect(refresh, []);

  useEffect(() => {
    return window.mycode.onConnectorEvent((ev: ConnectorEvent) => {
      if (ev.type === "device_code") {
        setPrompt(ev.prompt);
      } else if (ev.type === "connected") {
        setPrompt(null);
        setBusyId(null);
        setNotice(`Connected${ev.account ? ` as ${ev.account}` : ""}.`);
        refresh();
      } else if (ev.type === "error") {
        setPrompt(null);
        setBusyId(null);
        setNotice(`Error: ${ev.message}`);
      }
    });
  }, []);

  const connect = (id: string) => {
    setBusyId(id);
    setNotice(null);
    void window.mycode.connectConnector(id);
  };
  const disconnect = (id: string) => {
    void window.mycode.disconnectConnector(id).then(refresh);
  };

  const filtered = list.filter((c) =>
    tab === "all" ? true : tab === "connected" ? c.connected : !c.connected
  );

  return (
    <div className="settings-panel">
      <div className="panel-head">
        <h2 className="panel-title">Connectors</h2>
        <button className="add-btn" onClick={() => setShowAdd((s) => !s)}>Add <Icon name="chevronDown" size={13} /></button>
      </div>

      <div className="tabs">
        <button className={tab === "all" ? "tab on" : "tab"} onClick={() => setTab("all")}>All</button>
        <button className={tab === "connected" ? "tab on" : "tab"} onClick={() => setTab("connected")}>Connected</button>
        <button className={tab === "not" ? "tab on" : "tab"} onClick={() => setTab("not")}>Not connected</button>
      </div>

      {notice && <div className="conn-notice">{notice}</div>}
      {showAdd && <AddCustom onDone={() => { setShowAdd(false); refresh(); }} />}
      {prompt && <DeviceCode prompt={prompt} />}

      <div className="conn-table">
        <div className="conn-row conn-header">
          <span>Connector</span><span>Type</span><span>Status</span>
        </div>
        {filtered.map((c) => (
          <ConnectorRow
            key={c.id}
            c={c}
            busy={busyId === c.id}
            onConnect={() => connect(c.id)}
            onDisconnect={() => disconnect(c.id)}
          />
        ))}
        {filtered.length === 0 && <div className="stub">No connectors in this view.</div>}
      </div>
    </div>
  );
}

function ConnectorRow({
  c,
  busy,
  onConnect,
  onDisconnect,
}: {
  c: ConnectorInfo;
  busy: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [tools, setTools] = useState<McpToolInfo[] | null>(null);
  const [loading, setLoading] = useState(false);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && tools === null && !loading) {
      setLoading(true);
      window.mycode
        .connectorTools(c.id)
        .then((t) => setTools(t))
        .catch(() => setTools([]))
        .finally(() => setLoading(false));
    }
  };

  return (
    <div className={`conn-block ${open ? "open" : ""}`}>
      <div className="conn-row" onClick={toggle} role="button">
        <span className="conn-name">
          <span className="chev"><Icon name={open ? "chevronUp" : "chevronRight"} size={14} /></span>
          <span className="conn-icon">{c.id === "microsoft" ? <MicrosoftMark size={16} /> : <Icon name={c.custom ? "puzzle" : "plug"} size={16} />}</span>
          {c.label}
          {c.account && <span className="conn-account">{c.account}</span>}
        </span>
        <span className="conn-type">{c.type}{c.custom ? " · Custom" : ""}</span>
        <span className="conn-status" onClick={(e) => e.stopPropagation()}>
          {c.connected ? (
            <>
              <span className="ok"><Icon name="circleCheck" size={15} /></span>
              <button className="link-btn" onClick={onDisconnect}>Disconnect</button>
            </>
          ) : (
            <button className="connect-btn" disabled={busy} onClick={onConnect}>
              {busy ? "…" : "Connect"}
            </button>
          )}
        </span>
      </div>
      {open && (
        <div className="conn-tools">
          {loading && <div className="tools-loading"><span className="mini-spinner" /> loading tools…</div>}
          {!loading && tools && tools.length === 0 && (
            <div className="stub">No tools discovered (server offline or unreachable).</div>
          )}
          {!loading &&
            tools?.map((t) => (
              <div className="tool-line" key={t.name}>
                <code className="tool-line-name">{t.name}</code>
                <span className="tool-line-desc">{t.description}</span>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────── General ──────────────────────────────────
function GeneralPanel(): React.ReactElement {
  const [t, setT] = useState<Theme | null>(null);
  const [name, setName] = useState("");
  const [instr, setInstr] = useState("");
  const [instrReady, setInstrReady] = useState(false);
  const [savingInstr, setSavingInstr] = useState(false);
  const [savedInstr, setSavedInstr] = useState(false);

  useEffect(() => {
    void window.mycode.getTheme().then((th) => { setT(th); setName(th.preferredName ?? ""); });
    void window.mycode.getInstructions().then((s) => { setInstr(s); setInstrReady(true); });
  }, []);

  if (!t) return <Panel title="General"><div className="stub">Loading…</div></Panel>;

  // Persist a partial patch (main.ts merges) and apply it live to the DOM.
  const patch = (p: Partial<Theme>) => {
    setT({ ...t, ...p });
    void window.mycode.setTheme(p);
    if (p.mode !== undefined) applyMode(p.mode ?? DEFAULT_MODE);
    if (p.font !== undefined) applyFont(p.font ?? DEFAULT_FONT);
    if (p.reduceMotion !== undefined) applyReduceMotion(p.reduceMotion);
  };
  const saveName = () => { if ((t.preferredName ?? "") !== name.trim()) patch({ preferredName: name.trim() }); };
  const saveInstr = async () => {
    setSavingInstr(true); setSavedInstr(false);
    await window.mycode.setInstructions(instr);
    setSavingInstr(false); setSavedInstr(true);
    setTimeout(() => setSavedInstr(false), 1800);
  };

  const mode = t.mode ?? DEFAULT_MODE;
  const font = t.font ?? DEFAULT_FONT;

  return (
    <Panel title="General">
      <Field label="What should we call you?">
        <input
          className="fld"
          placeholder="e.g. Rengaraj"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={saveName}
          onKeyDown={(e) => { if (e.key === "Enter") saveName(); }}
        />
        <div className="hint">Used to greet you on the home screen.</div>
      </Field>

      <Field label="Instructions for the agent">
        <textarea
          className="skill-editor gen-instr"
          placeholder="e.g. Respond concisely. Prefer TypeScript. I work at Synergech on internal tooling."
          value={instr}
          onChange={(e) => setInstr(e.target.value)}
          spellCheck={false}
          disabled={!instrReady}
        />
        <div className="row-inline" style={{ marginTop: 8 }}>
          <button className="btn primary" onClick={saveInstr} disabled={savingInstr || !instrReady}>
            {savingInstr ? "Saving…" : savedInstr ? "Saved ✓" : "Save instructions"}
          </button>
          <span className="hint">Stored in <code>~/.my-code/my-code.md</code> and added to the agent's system prompt on your next new chat.</span>
        </div>
      </Field>

      <div className="panel-subhead">Preferences</div>

      <Field label="Appearance">
        <div className="seg">
          <button className={mode === "system" ? "on" : ""} onClick={() => patch({ mode: "system" })}>System</button>
          <button className={mode === "light" ? "on" : ""} onClick={() => patch({ mode: "light" })}>Light</button>
          <button className={mode === "dark" ? "on" : ""} onClick={() => patch({ mode: "dark" })}>Dark</button>
        </div>
      </Field>

      <Field label="Chat font">
        <div className="seg">
          <button className={font === "sans" ? "on" : ""} onClick={() => patch({ font: "sans" })}>Sans</button>
          <button className={font === "serif" ? "on" : ""} onClick={() => patch({ font: "serif" })}>Serif</button>
          <button className={font === "mono" ? "on" : ""} onClick={() => patch({ font: "mono" })}>Mono</button>
        </div>
        <div className="hint">Applies to message text. Code always stays monospace.</div>
      </Field>

      <label className="toggle-row" style={{ marginTop: 14 }}>
        <input type="checkbox" checked={!!t.reduceMotion} onChange={(e) => patch({ reduceMotion: e.target.checked })} />
        <span>Reduce motion — minimise streaming, spinner and loading animations (your OS setting is always honoured)</span>
      </label>

      <div className="hint" style={{ marginTop: 12 }}>Accent colour lives under <b>Theme</b>.</div>
    </Panel>
  );
}

// ──────────────────────────────── Theme ───────────────────────────────────
function ThemePanel(): React.ReactElement {
  const [accent, setAccent] = useState<string>(DEFAULT_ACCENT);
  const [custom, setCustom] = useState("");

  useEffect(() => {
    void window.mycode.getTheme().then((t) => setAccent(t.accent ?? DEFAULT_ACCENT));
  }, []);

  const pick = (a: string, hover: string) => {
    setAccent(a);
    applyAccent(a, hover);
    void window.mycode.setTheme({ accent: a, accentHover: hover });
  };

  return (
    <Panel title="Theme">
      <Field label="Accent color">
        <div className="swatch-grid">
          {ACCENT_PRESETS.map((p) => (
            <button
              key={p.name}
              className={`swatch-btn ${accent.toLowerCase() === p.accent.toLowerCase() ? "on" : ""}`}
              title={p.name}
              onClick={() => pick(p.accent, p.hover)}
            >
              <span className="swatch-dot" style={{ background: p.accent }} />
              <span className="swatch-name">{p.name}</span>
            </button>
          ))}
        </div>
      </Field>
      <Field label="Custom color">
        <div className="row-inline">
          <input
            type="color"
            className="color-input"
            value={/^#[0-9a-fA-F]{6}$/.test(accent) ? accent : "#c96442"}
            onChange={(e) => pick(e.target.value, e.target.value)}
          />
          <input
            className="fld"
            placeholder="#rrggbb"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && /^#[0-9a-fA-F]{6}$/.test(custom)) pick(custom, custom); }}
          />
          <button className="btn" disabled={!/^#[0-9a-fA-F]{6}$/.test(custom)} onClick={() => pick(custom, custom)}>Apply</button>
        </div>
      </Field>
      <div className="hint">Applies instantly across buttons, links, active items and highlights. The logo keeps its own identity.</div>
    </Panel>
  );
}

// ─────────────────────────── Models & Providers ───────────────────────────
function ModelsPanel(): React.ReactElement {
  const [s, setS] = useState<ModelSettings | null>(null);
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const load = () => void window.mycode.getModelSettings().then(setS);
  useEffect(load, []);

  if (!s) return <Panel title="Models & Providers"><div className="stub">Loading…</div></Panel>;

  // Azure Foundry is configured per-account (endpoint/key/deployment), not via the
  // Ollama-style controls below — show a read-only summary and point to Account.
  if (s.provider === "azure-foundry") {
    return (
      <Panel title="Models & Providers">
        <div className="panel-note">Using the active <b>Azure Foundry</b> account. Manage its endpoint, key, deployment and api-version under <b>Account</b>.</div>
        <Field label="Endpoint"><div className="stub">{s.host ?? "—"}</div></Field>
        <Field label="Deployment / model"><div className="stub">{s.models[0] ?? "—"} · running: {s.currentModel ?? "—"}</div></Field>
      </Panel>
    );
  }

  const save = async (patch: Parameters<typeof window.mycode.saveModelSettings>[0]) => {
    setSaving(true); setSaved(false);
    await window.mycode.saveModelSettings(patch);
    setKey(""); setSaving(false); setSaved(true);
    load();
    setTimeout(() => setSaved(false), 1800);
  };

  return (
    <Panel title="Models & Providers" note={saving ? "applying… (backend restarting)" : saved ? "saved ✓" : undefined}>
      <Field label="Provider">
        <select className="fld" value={s.provider} onChange={(e) => save({ provider: e.target.value })}>
          <option value="ollama">Ollama</option>
          <option value="openai" disabled>OpenAI (not wired)</option>
          <option value="gemini" disabled>Gemini (not wired)</option>
        </select>
      </Field>
      <Field label="Location">
        <div className="seg">
          <button className={!s.cloud ? "on" : ""} onClick={() => save({ cloud: false, host: "http://localhost:11434" })}>Local</button>
          <button className={s.cloud ? "on" : ""} onClick={() => save({ cloud: true })}>Cloud (ollama.com)</button>
        </div>
      </Field>
      {!s.cloud && (
        <Field label="Host">
          <input className="fld" defaultValue={s.host} onBlur={(e) => e.target.value !== s.host && save({ host: e.target.value })} />
        </Field>
      )}
      <Field label={`API key ${s.hasKey ? `(current ${s.apiKeyMask})` : "(none)"}`}>
        <div className="row-inline">
          <input className="fld" type="password" placeholder="paste key to update" value={key} onChange={(e) => setKey(e.target.value)} />
          <button className="btn" disabled={!key} onClick={() => save({ apiKey: key })}>Set</button>
        </div>
      </Field>
      <Field label="Default model">
        <select className="fld" value={s.defaultModel ?? ""} onChange={(e) => save({ defaultModel: e.target.value })}>
          <option value="">(auto)</option>
          {s.models.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <div className="hint">{s.models.length ? `${s.models.length} models detected` : "no models found at host"} · running: {s.currentModel ?? "—"}</div>
      </Field>
    </Panel>
  );
}

// ─────────────────────────────── Accounts ─────────────────────────────────
const emptyForm = { provider: "ollama", name: "", apiKey: "", host: "", deployment: "", apiVersion: "", model: "" };

/** Human label for a provider id. */
function providerLabel(p: string): string {
  switch (p) {
    case "azure-foundry": return "Azure Foundry";
    case "ollama": return "Ollama";
    case "openai": return "OpenAI";
    case "gemini": return "Gemini";
    default: return p || "Provider";
  }
}

/** Order providers for display; known ones first, unknown appended. */
function orderProviders(providers: string[]): string[] {
  const order = ["azure-foundry", "ollama", "openai", "gemini"];
  const rank = (p: string) => { const i = order.indexOf(p); return i < 0 ? order.length : i; };
  return [...providers].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

function AccountPanel(): React.ReactElement {
  const [list, setList] = useState<AccountList | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [f, setF] = useState(emptyForm);
  const [msg, setMsg] = useState<string>("");
  /** Account id currently being switched to (backend restart in flight). */
  const [switching, setSwitching] = useState<string | null>(null);
  const load = () => void window.mycode.getAccounts().then(setList);
  useEffect(load, []);

  const makeActive = async (a: { id: string; name: string }) => {
    if (switching) return; // one switch at a time
    setSwitching(a.id);
    setMsg(`Switching to ${a.name} — restarting backend…`);
    try {
      const b = await window.mycode.setActiveAccount(a.id);
      setMsg(b.model !== "—"
        ? `Now using ${a.name} (${b.model}).`
        : `Switched to ${a.name}, but the backend failed to start — check the endpoint/key.`);
    } catch (e) {
      setMsg(`Couldn't switch account: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSwitching(null);
      load();
    }
  };

  const isAzure = f.provider === "azure-foundry";

  const add = async () => {
    if (isAzure) {
      // Only the essentials to reach a deployment. The deployment name doubles as
      // the account label; api-version/model come from .env import or defaults.
      if (!f.host.trim() || !f.apiKey.trim() || !f.deployment.trim()) {
        setMsg("Endpoint, API key, and deployment are required.");
        return;
      }
      await window.mycode.addAccount({
        provider: "azure-foundry",
        name: f.deployment.trim(),
        apiKey: f.apiKey,
        host: f.host.trim(),
        meta: {
          deployment: f.deployment.trim(),
          apiVersion: f.apiVersion.trim() || "2024-10-21",
          model: f.model.trim() || f.deployment.trim(),
        },
      });
    } else {
      if (!f.name.trim()) { setMsg("A label is required."); return; }
      await window.mycode.addAccount({
        provider: f.provider,
        name: f.name.trim(),
        apiKey: f.apiKey || undefined,
        host: f.host || undefined,
      });
    }
    setShowAdd(false); setF(emptyForm); setMsg(""); load();
  };

  // Pull Azure fields from synfra's .env and pre-fill the form (nothing is saved yet).
  const importEnv = async () => {
    const d = await window.mycode.readEnvDefaults();
    if (!d || (!d.host && !d.apiKey && !d.deployment)) {
      setMsg("Couldn't read Azure fields from synfra/.env (set MC_SYNFRA_ENV if it's elsewhere).");
      return;
    }
    setShowAdd(true);
    setMsg("Pre-filled from synfra/.env — review and click Add.");
    setF((cur) => ({
      ...cur,
      provider: "azure-foundry",
      name: cur.name || "foundry",
      apiKey: d.apiKey ?? cur.apiKey,
      host: d.host ?? cur.host,
      deployment: d.deployment ?? cur.deployment,
      apiVersion: d.apiVersion ?? cur.apiVersion,
      model: d.model ?? cur.model,
    }));
  };

  return (
    <Panel title="Account" action={
      <div className="row-inline">
        <button className="add-btn" onClick={importEnv}>Import .env</button>
        <button className="add-btn" onClick={() => { setShowAdd((v) => !v); setMsg(""); }}>Add account</button>
      </div>
    }>
      {msg && <div className="panel-note">{msg}</div>}
      {showAdd && (
        <div className="add-custom">
          <div className="dc-title">Add provider account</div>
          <select className="fld" value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value })}>
            <option value="ollama">Ollama</option>
            <option value="azure-foundry">Azure Foundry</option>
            <option value="openai" disabled>OpenAI (not wired)</option>
            <option value="gemini" disabled>Gemini (not wired)</option>
          </select>
          {isAzure ? (
            <>
              <input className="fld" placeholder="endpoint (https://<res>.openai.azure.com)" value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })} />
              <input className="fld" type="password" placeholder="Azure API key" value={f.apiKey} onChange={(e) => setF({ ...f, apiKey: e.target.value })} />
              <input className="fld" placeholder="deployment name" value={f.deployment} onChange={(e) => setF({ ...f, deployment: e.target.value })} />
            </>
          ) : (
            <>
              <input className="fld" placeholder="label (e.g. work)" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
              <input className="fld" type="password" placeholder="API key (optional)" value={f.apiKey} onChange={(e) => setF({ ...f, apiKey: e.target.value })} />
              <input className="fld" placeholder="host (optional)" value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })} />
            </>
          )}
          <div className="add-actions"><button className="btn primary" onClick={add}>Add</button><button className="btn" onClick={() => { setShowAdd(false); setMsg(""); }}>Cancel</button></div>
        </div>
      )}
      <div className="conn-table">
        {(!list || list.accounts.length === 0) && <div className="stub">No provider accounts yet. Ollama works without one; add keys here to switch between credentials.</div>}
        {orderProviders([...new Set((list?.accounts ?? []).map((a) => a.provider))]).map((prov) => (
          <div className="acct-group" key={prov}>
            <div className="acct-group-label">{providerLabel(prov)}</div>
            {(list?.accounts ?? []).filter((a) => a.provider === prov).map((a) => (
              <div className="conn-row" key={a.id}>
                <span className="conn-name">{a.name}{(a.meta?.deployment || a.host) && <span className="conn-account">{a.meta?.deployment ?? a.host}</span>}</span>
                <span className="conn-type">{a.hasKey ? "key set" : "no key"}</span>
                <span className="conn-status">
                  {list?.activeId === a.id
                    ? <span className="ok"><Icon name="circleCheck" size={14} /> active</span>
                    : switching === a.id
                      ? <span className="conn-type">switching…</span>
                      : <button className="link-btn" disabled={!!switching} onClick={() => void makeActive(a)}>Make active</button>}
                  <button className="link-btn danger" disabled={!!switching} onClick={async () => { await window.mycode.removeAccount(a.id); load(); }}>Remove</button>
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Panel>
  );
}

// ────────────────────────────── Permissions ───────────────────────────────
function PermissionsPanel(): React.ReactElement {
  const [p, setP] = useState<Permissions | null>(null);
  const [scope, setScope] = useState<"global" | "project">("global");
  const [rule, setRule] = useState("");
  const [kind, setKind] = useState<"allow" | "deny">("allow");
  const load = () => void window.mycode.getPermissions().then(setP);
  useEffect(load, []);

  const edit = async (e: PermEdit) => { await window.mycode.editPermission(e); load(); };
  if (!p) return <Panel title="Permissions"><div className="stub">Loading…</div></Panel>;
  const cur = p[scope];

  return (
    <Panel title="Permissions" note={p.yolo ? "⚠ skipping all permission checks" : undefined}>
      <label className="toggle-row">
        <input type="checkbox" checked={p.yolo} onChange={(e) => window.mycode.setYolo(e.target.checked).then(load)} />
        <span>Skip all permission prompts (YOLO) — auto-approve every tool</span>
      </label>

      <div className="seg" style={{ marginTop: 14 }}>
        <button className={scope === "global" ? "on" : ""} onClick={() => setScope("global")}>Global</button>
        <button className={scope === "project" ? "on" : ""} onClick={() => setScope("project")}>Project</button>
      </div>

      <div className="perm-cols">
        <PermList title="Allow" rules={cur.allow} onRemove={(r) => edit({ scope, kind: "allow", rule: r, op: "remove" })} />
        <PermList title="Deny" rules={cur.deny} onRemove={(r) => edit({ scope, kind: "deny", rule: r, op: "remove" })} />
      </div>

      <div className="row-inline" style={{ marginTop: 12 }}>
        <select className="fld" style={{ maxWidth: 100 }} value={kind} onChange={(e) => setKind(e.target.value as "allow" | "deny")}>
          <option value="allow">Allow</option><option value="deny">Deny</option>
        </select>
        <input className="fld" placeholder="rule, e.g. Bash(git*)  ·  Edit  ·  WebFetch" value={rule} onChange={(e) => setRule(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && rule.trim()) { edit({ scope, kind, rule: rule.trim(), op: "add" }); setRule(""); } }} />
        <button className="btn" disabled={!rule.trim()} onClick={() => { edit({ scope, kind, rule: rule.trim(), op: "add" }); setRule(""); }}>Add</button>
      </div>
      <div className="hint">Rules match a tool by name, optionally with a glob: <code>Bash(npm*)</code>, <code>Edit</code>, <code>mcp__microsoft__*</code>. Changes restart the backend.</div>
    </Panel>
  );
}
function PermList({ title, rules, onRemove }: { title: string; rules: string[]; onRemove: (r: string) => void }): React.ReactElement {
  return (
    <div className="perm-col">
      <div className="perm-col-title">{title} <span className="perm-count">{rules.length}</span></div>
      {rules.length === 0 && <div className="stub small">none</div>}
      {rules.map((r) => (
        <div className="perm-rule" key={r}><code>{r}</code><button className="x" onClick={() => onRemove(r)} title="Remove"><Icon name="close" size={12} /></button></div>
      ))}
    </div>
  );
}

// ──────────────────────────────── Skills ──────────────────────────────────
function SkillsPanel(): React.ReactElement {
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [editing, setEditing] = useState<SkillInfo | null>(null);
  const [creating, setCreating] = useState(false);
  const load = () => void window.mycode.getSkills().then(setSkills);
  useEffect(load, []);

  if (editing || creating) return <SkillEditor skill={editing} onDone={() => { setEditing(null); setCreating(false); load(); }} />;

  const groups: SkillInfo["source"][] = ["user", "project", "bundled"];
  return (
    <Panel title="Skills" action={<div className="row-inline">
      <button className="add-btn" onClick={() => setCreating(true)}>New skill</button>
      <button className="add-btn" onClick={() => window.mycode.openSkillsFolder()}>Open folder</button>
    </div>}>
      {!skills && <div className="stub">Loading…</div>}
      {skills && skills.length === 0 && <div className="stub">No skills yet. Create one — it becomes a slash command the agent can invoke.</div>}
      {groups.map((g) => {
        const items = (skills ?? []).filter((s) => s.source === g);
        if (!items.length) return null;
        return (
          <div key={g} className="skill-group">
            <div className="skill-group-label">{g}</div>
            {items.map((s) => (
              <div className="skill-row" key={`${g}:${s.name}`}>
                <div className="skill-info">
                  <div className="skill-name">/{s.name}</div>
                  <div className="skill-desc">{s.description || s.whenToUse || "—"}</div>
                </div>
                <div className="skill-actions">
                  {s.source !== "bundled"
                    ? <>
                        <button className="link-btn" onClick={() => setEditing(s)}>Edit</button>
                        <button className="link-btn danger" onClick={async () => { if (s.path) { await window.mycode.deleteSkill(s.path); load(); } }}>Delete</button>
                      </>
                    : <button className="link-btn" onClick={() => setEditing(s)}>View</button>}
                </div>
              </div>
            ))}
          </div>
        );
      })}
    </Panel>
  );
}
function SkillEditor({ skill, onDone }: { skill: SkillInfo | null; onDone: () => void }): React.ReactElement {
  const readonly = skill?.source === "bundled";
  const [name, setName] = useState(skill?.name ?? "");
  const [content, setContent] = useState(
    skill ? rebuildSkillFile(skill) : "---\nname: my-skill\ndescription: what it does\nwhen_to_use: when to trigger it\n---\n\nInstructions for the agent…\n"
  );
  const save = async () => {
    await window.mycode.saveSkill(name || "skill", content);
    onDone();
  };
  return (
    <Panel title={readonly ? `Skill: ${skill?.name}` : skill ? `Edit: ${skill.name}` : "New skill"}>
      {!readonly && <Field label="File name"><input className="fld" value={name} onChange={(e) => setName(e.target.value)} placeholder="my-skill" /></Field>}
      <textarea className="skill-editor" value={content} readOnly={readonly} onChange={(e) => setContent(e.target.value)} spellCheck={false} />
      <div className="add-actions">
        {!readonly && <button className="btn primary" onClick={save}>Save</button>}
        <button className="btn" onClick={onDone}>{readonly ? "Back" : "Cancel"}</button>
      </div>
    </Panel>
  );
}
function rebuildSkillFile(s: SkillInfo): string {
  const fm = ["---", `name: ${s.name}`, `description: ${s.description}`, s.whenToUse ? `when_to_use: ${s.whenToUse}` : "", "---", "", s.body].filter(Boolean);
  return fm.join("\n");
}

// ───────────────────────────────── Usage ──────────────────────────────────
function UsagePanel(): React.ReactElement {
  const [u, setU] = useState<UsageSummary | null>(null);
  useEffect(() => void window.mycode.getUsage().then(setU), []);
  if (!u) return <Panel title="Usage"><div className="stub">Loading…</div></Panel>;
  const sum = (rows: ModelUsage[]) => rows.reduce((a, r) => ({ t: a.t + r.turns, p: a.p + r.promptTokens, c: a.c + r.completionTokens }), { t: 0, p: 0, c: 0 });
  const fmt = (n: number) => n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
  const windows: [string, ModelUsage[]][] = [["Today", u.today], ["This week", u.week], ["All time", u.all]];

  return (
    <Panel title="Usage" note={`${u.sessionCount} sessions`}>
      <div className="usage-cards">
        {windows.map(([label, rows]) => {
          const s = sum(rows);
          return (
            <div className="usage-card" key={label}>
              <div className="usage-label">{label}</div>
              <div className="usage-big">{fmt(s.p + s.c)}<span> tokens</span></div>
              <div className="usage-sub">{s.t} turns · {fmt(s.p)} in / {fmt(s.c)} out</div>
            </div>
          );
        })}
      </div>
      <div className="usage-table">
        <div className="usage-trow usage-thead"><span>Model (all time)</span><span>Turns</span><span>In</span><span>Out</span></div>
        {u.all.map((r) => (
          <div className="usage-trow" key={r.model}>
            <span className="usage-model">{r.model}</span><span>{r.turns}</span><span>{fmt(r.promptTokens)}</span><span>{fmt(r.completionTokens)}</span>
          </div>
        ))}
        {u.all.length === 0 && <div className="stub">No usage recorded yet.</div>}
      </div>
    </Panel>
  );
}

// ─────────────────────────────── shared bits ──────────────────────────────
function Panel({ title, note, action, children }: { title: string; note?: string; action?: React.ReactNode; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="settings-panel">
      <div className="panel-head">
        <h2 className="panel-title">{title}</h2>
        {action}
      </div>
      {note && <div className="panel-note">{note}</div>}
      {children}
    </div>
  );
}
function Field({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return <div className="field"><label className="field-label">{label}</label>{children}</div>;
}

function DeviceCode({ prompt }: { prompt: DeviceCodePrompt }): React.ReactElement {
  return (
    <div className="device-code">
      <div className="dc-title">Finish sign-in</div>
      <p className="dc-msg">
        Go to <button className="link-btn" onClick={() => window.mycode.openExternal(prompt.verificationUri)}>{prompt.verificationUri}</button> and enter this code:
      </p>
      <div className="dc-code">
        <code>{prompt.userCode}</code>
        <button className="link-btn" onClick={() => navigator.clipboard.writeText(prompt.userCode)}>copy</button>
      </div>
      <div className="dc-wait"><span className="mini-spinner" /> waiting for you to sign in…</div>
    </div>
  );
}

function AddCustom({ onDone }: { onDone: () => void }): React.ReactElement {
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"stdio" | "http">("http");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    const input: CustomMcpInput = {
      name,
      transport,
      url: url || undefined,
      token: token || undefined,
      command: command || undefined,
      args: args ? args.split(/\s+/).filter(Boolean) : undefined,
    };
    const res = await window.mycode.addMcpServer(input);
    if (res.ok) onDone();
    else setErr(res.error ?? "failed");
  };

  return (
    <div className="add-custom">
      <div className="dc-title">Add custom MCP server</div>
      <input className="fld" placeholder="name (e.g. github)" value={name} onChange={(e) => setName(e.target.value)} />
      <div className="seg">
        <button className={transport === "http" ? "on" : ""} onClick={() => setTransport("http")}>HTTP</button>
        <button className={transport === "stdio" ? "on" : ""} onClick={() => setTransport("stdio")}>stdio</button>
      </div>
      {transport === "http" ? (
        <>
          <input className="fld" placeholder="https://example.com/mcp" value={url} onChange={(e) => setUrl(e.target.value)} />
          <input className="fld" placeholder="bearer token (optional)" value={token} onChange={(e) => setToken(e.target.value)} />
        </>
      ) : (
        <>
          <input className="fld" placeholder="command (e.g. npx)" value={command} onChange={(e) => setCommand(e.target.value)} />
          <input className="fld" placeholder="args (space-separated)" value={args} onChange={(e) => setArgs(e.target.value)} />
        </>
      )}
      {err && <div className="conn-notice err">{err}</div>}
      <div className="add-actions">
        <button className="btn primary" onClick={submit}>Add</button>
        <button className="btn" onClick={onDone}>Cancel</button>
      </div>
    </div>
  );
}
