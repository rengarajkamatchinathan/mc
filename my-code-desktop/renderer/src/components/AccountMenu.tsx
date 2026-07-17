import React, { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { Logo } from "./Logo";
import { providerLabel, orderProviders, type SettingsSection } from "./Settings";
import type { AccountList, Bootstrap } from "../../../electron/ipc";

/**
 * Claude-Desktop-style account popover, anchored above the sidebar footer.
 * Fast account switcher + shortcuts into the settings modal.
 */
export function AccountMenu({
  boot,
  onOpenSettings,
}: {
  boot: Bootstrap | null;
  onOpenSettings: (section?: SettingsSection) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<AccountList | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  const [note, setNote] = useState<string>("");
  const [version, setVersion] = useState<string>("");
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void window.mycode.getVersion().then(setVersion).catch(() => {});
  }, []);

  // Refresh accounts every open so an add/remove in Settings is reflected.
  useEffect(() => {
    if (!open) return;
    setNote("");
    void window.mycode.getAccounts().then(setList).catch(() => {});
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const active = list?.accounts.find((a) => a.id === list.activeId);

  const switchTo = async (a: { id: string; name: string }) => {
    if (switching) return;
    setSwitching(a.id);
    setNote(`Switching to ${a.name}…`);
    try {
      const b = await window.mycode.setActiveAccount(a.id);
      setNote(b.model !== "—"
        ? `Now using ${a.name} (${b.model}).`
        : `Switched, but the backend failed to start — check Settings → Account.`);
    } catch (e) {
      setNote(`Couldn't switch: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSwitching(null);
      void window.mycode.getAccounts().then(setList).catch(() => {});
    }
  };

  const jump = (section: SettingsSection) => {
    setOpen(false);
    onOpenSettings(section);
  };

  const accounts = list?.accounts ?? [];

  return (
    <div className="account-wrap" ref={wrapRef}>
      {open && (
        <div className="account-menu" role="menu">
          <div className="am-header">
            <span className="avatar"><Icon name="user" size={16} /></span>
            <div className="account-meta">
              <div className="account-name">my-code</div>
              <div className="account-sub">
                {active ? `${providerLabel(active.provider)} · ${active.name}` : boot?.model ?? "no account"}
              </div>
            </div>
          </div>

          <div className="am-sep" />
          <div className="am-label">Accounts</div>
          {accounts.length === 0 && (
            <button className="am-item" onClick={() => jump("account")}>
              <span className="am-ico"><Icon name="plus" size={14} /></span> Add account…
            </button>
          )}
          {orderProviders([...new Set(accounts.map((a) => a.provider))]).map((prov) =>
            accounts.filter((a) => a.provider === prov).map((a) => {
              const isActive = list?.activeId === a.id;
              return (
                <button
                  key={a.id}
                  className={`am-item am-account ${isActive ? "on" : ""}`}
                  disabled={isActive || !!switching}
                  onClick={() => void switchTo(a)}
                >
                  <span className="am-ico">
                    {switching === a.id
                      ? <Icon name="spinner" size={14} className="am-spin" />
                      : isActive ? <Icon name="check" size={14} /> : null}
                  </span>
                  <span className="am-name">{a.name}</span>
                  <span className="am-prov">{providerLabel(a.provider)}</span>
                </button>
              );
            })
          )}
          {note && <div className="am-note">{note}</div>}

          <div className="am-sep" />
          <button className="am-item" onClick={() => jump("general")}>
            <span className="am-ico"><Icon name="sliders" size={14} /></span> Settings
          </button>
          <button className="am-item" onClick={() => jump("usage")}>
            <span className="am-ico"><Icon name="layers" size={14} /></span> Usage
          </button>

          <div className="am-sep" />
          <div className="am-version">{version ? `v${version}` : ""}</div>
        </div>
      )}

      <button className={`account no-drag ${open ? "open" : ""}`} onClick={() => setOpen((o) => !o)} title="Account & settings">
        <span className="avatar avatar-mark"><Logo size={22} tile /></span>
        <div className="account-meta">
          <div className="account-name">my-code</div>
          <div className="account-sub">{boot?.model ?? "…"}</div>
        </div>
        <span className="am-chev"><Icon name={open ? "chevronDown" : "chevronUp"} size={14} /></span>
      </button>
    </div>
  );
}
