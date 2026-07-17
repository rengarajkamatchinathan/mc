import React, { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { AccountMenu } from "./AccountMenu";
import type { SettingsSection } from "./Settings";
import type { Bootstrap, Mode, SessionMeta } from "../../../electron/ipc";

const isMac = window.mycode.platform === "darwin";

export interface SidebarProps {
  boot: Bootstrap | null;
  mode: Mode;
  sessions: SessionMeta[];
  activeTitle: string | null;
  loadingId: string | null;
  onMode: (m: Mode) => void;
  onNewChat: () => void;
  onResume: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onOpenSettings: (section?: SettingsSection) => void;
  onOpenCommand: () => void;
}

/**
 * Claude-Desktop-style sidebar: window chrome row, Home/Code segmented control,
 * primary nav, a flat Recents list, and the account footer. The whole column is
 * the app's left rail — there is no separate title bar.
 */
export function Sidebar({
  boot,
  mode,
  sessions,
  activeTitle,
  loadingId,
  onMode,
  onNewChat,
  onResume,
  onRename,
  onDelete,
  onOpenSettings,
  onOpenCommand,
}: SidebarProps): React.ReactElement {
  const sorted = [...sessions].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  return (
    <aside className="sidebar">
      {/* window chrome — draggable; on macOS the native traffic lights sit here */}
      <div className={`side-chrome ${isMac ? "is-mac" : ""}`}>
        {!isMac && (
          <div className="traffic no-drag">
            <button className="tl tl-close" onClick={() => window.mycode.windowClose()} title="Close" aria-label="Close" />
            <button className="tl tl-min" onClick={() => window.mycode.windowMinimize()} title="Minimize" aria-label="Minimize" />
            <button className="tl tl-max" onClick={() => window.mycode.windowToggleMaximize()} title="Zoom" aria-label="Zoom" />
          </div>
        )}
        <button className="chrome-btn no-drag" onClick={onOpenCommand} title="Search (Ctrl/⌘+K)" aria-label="Search">
          <Icon name="search" size={15} />
        </button>
      </div>

      <div className="mode-tabs no-drag" role="tablist" aria-label="Mode">
        <button
          className={`mode-tab ${mode === "chat" ? "active" : ""}`}
          role="tab"
          aria-selected={mode === "chat"}
          onClick={() => onMode("chat")}
        >
          <Icon name="home" size={13} /> Home
        </button>
        <button
          className={`mode-tab ${mode === "code" ? "active" : ""}`}
          role="tab"
          aria-selected={mode === "code"}
          onClick={() => onMode("code")}
        >
          <Icon name="code" size={13} /> Code
        </button>
      </div>

      <nav className="snav">
        <button className="snav-item snav-new" onClick={onNewChat}>
          <Icon name="plus" size={15} /> New
        </button>
        <button className="snav-item" disabled title="Coming soon">
          <Icon name="folder" size={15} /> Projects
        </button>
        <button className="snav-item" disabled title="Coming soon">
          <Icon name="layers" size={15} /> Artifacts
        </button>
        <button className="snav-item" disabled title="Coming soon">
          <Icon name="clock" size={15} /> Scheduled
        </button>
        <button className="snav-item" disabled title="Coming soon">
          <Icon name="box" size={15} /> Dispatch <span className="badge-beta">Beta</span>
        </button>
        <button className="snav-item" onClick={() => onOpenSettings()}>
          <Icon name="sliders" size={15} /> Customize
        </button>
      </nav>

      <div className="side-label">Recents</div>
      <div className="recents-list">
        {sorted.length === 0 && <div className="recents-empty">No sessions yet</div>}
        {sorted.map((s) => (
          <RecentRow
            key={s.id}
            session={s}
            active={!!activeTitle && s.firstPrompt === activeTitle}
            loading={loadingId === s.id}
            onResume={() => onResume(s.id)}
            onRename={(title) => onRename(s.id, title)}
            onDelete={() => onDelete(s.id)}
          />
        ))}
      </div>

      <div className="sidebar-foot">
        <AccountMenu boot={boot} onOpenSettings={onOpenSettings} />
      </div>
    </aside>
  );
}

function RecentRow({
  session,
  active,
  loading,
  onResume,
  onRename,
  onDelete,
}: {
  session: SessionMeta;
  active: boolean;
  loading: boolean;
  onResume: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
}): React.ReactElement {
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.firstPrompt ?? session.id);
  const rowRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (rowRef.current && !rowRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);

  const label = session.firstPrompt ?? session.id;

  if (editing) {
    return (
      <div className="recent-row" ref={rowRef}>
        <input
          className="recent-edit"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              onRename(draft.trim() || label);
              setEditing(false);
            } else if (e.key === "Escape") {
              setEditing(false);
              setDraft(label);
            }
          }}
          onBlur={() => setEditing(false)}
        />
      </div>
    );
  }

  return (
    <div className={`recent-row ${active ? "active" : ""}`} ref={rowRef}>
      <button className="recent-item" title={label} onClick={onResume} disabled={loading}>
        <span className="recent-dot" aria-hidden="true" />
        <span className="recent-text">{label}</span>
      </button>
      <div className="recent-tail">
        {loading ? (
          <span className="mini-spinner" aria-label="loading" />
        ) : (
          <button
            className="dots-btn"
            title="More"
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((o) => !o);
            }}
          >
            <Icon name="more" size={16} />
          </button>
        )}
      </div>
      {menuOpen && (
        <div className="recent-menu">
          <button
            onClick={() => {
              setEditing(true);
              setMenuOpen(false);
            }}
          >
            Rename
          </button>
          <button className="danger" onClick={() => { setMenuOpen(false); onDelete(); }}>
            Delete
          </button>
        </div>
      )}
    </div>
  );
}
