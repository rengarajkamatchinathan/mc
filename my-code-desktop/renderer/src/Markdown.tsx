/**
 * Tiny markdown renderer for assistant bubbles.
 *
 * Models emit `**bold**`, `- bullets`, `# headers`, `` `code` ``, fenced code
 * blocks, tables, blockquotes and links even when the persona says "plain
 * text". Without this, my-code's replies show literal asterisks.
 *
 * Intentionally not a CommonMark parser — covers the subset the model actually
 * emits, plus lightweight syntax highlighting for fenced code.
 */

import React, { useState } from "react";

export interface MarkdownProps {
  content: string;
  /**
   * While true, plain text is split into per-word spans so words newly
   * appended by a delta mount fresh and fade in (Claude-style soft reveal).
   * On finalize the same content re-renders unsplit and the DOM collapses.
   */
  streaming?: boolean;
}

/**
 * Memoized so a streaming turn only re-parses the *live* message. Without this,
 * every assistant delta re-rendered (and re-parsed) every prior bubble too.
 */
export const Markdown = React.memo(MarkdownImpl);

function MarkdownImpl({ content, streaming = false }: MarkdownProps): React.ReactElement {
  const lines = content.split("\n");
  const blocks: React.ReactElement[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block ```lang … ```
    if (line.trim().startsWith("```")) {
      const lang = line.trim().slice(3).trim();
      const end = lines.findIndex((l, k) => k > i && l.trim().startsWith("```"));
      const stop = end === -1 ? lines.length : end;
      const code = lines.slice(i + 1, stop).join("\n");
      blocks.push(<CodeBlock key={key++} code={code} lang={lang} />);
      i = stop + 1;
      continue;
    }

    // Table: header row + |---| separator + body rows
    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const header = splitRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      blocks.push(
        <div key={key++} className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>{header.map((c, k) => <th key={k}>{renderInline(c)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>{r.map((c, k) => <td key={k}>{renderInline(c)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    // Blockquote: consecutive "> " lines
    if (/^\s*>\s?/.test(line)) {
      const quote: React.ReactNode[] = [];
      let qk = 0;
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quote.push(<div key={qk++}>{renderInline(lines[i].replace(/^\s*>\s?/, ""))}</div>);
        i++;
      }
      blocks.push(<blockquote key={key++} className="md-quote">{quote}</blockquote>);
      continue;
    }

    // Headings
    if (line.startsWith("### ")) { blocks.push(<h4 key={key++} className="md-h">{renderInline(line.slice(4))}</h4>); i++; continue; }
    if (line.startsWith("## ")) { blocks.push(<h3 key={key++} className="md-h">{renderInline(line.slice(3))}</h3>); i++; continue; }
    if (line.startsWith("# ")) { blocks.push(<h2 key={key++} className="md-h">{renderInline(line.slice(2))}</h2>); i++; continue; }

    // Bullet list: collapse consecutive bullets into one <ul>.
    const bulletMatch = /^(\s*)[-*]\s+(.*)$/.exec(line);
    if (bulletMatch) {
      const items: React.ReactNode[] = [];
      while (i < lines.length) {
        const m = /^(\s*)[-*]\s+(.*)$/.exec(lines[i]);
        if (!m) break;
        items.push(<li key={items.length} className="md-li">{renderInline(m[2], streaming)}</li>);
        i++;
      }
      blocks.push(<ul key={key++} className="md-ul">{items}</ul>);
      continue;
    }

    // Blank line → paragraph break
    if (line.trim() === "") { blocks.push(<div key={key++} className="md-spacer" />); i++; continue; }

    // Plain paragraph line
    blocks.push(<p key={key++} className="md-p">{renderInline(line, streaming)}</p>);
    i++;
  }
  return <div className="md">{blocks}</div>;
}

// ─── tables ───
function isTableRow(l: string): boolean { return /^\s*\|.*\|\s*$/.test(l); }
function isTableSep(l: string): boolean { return /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(l) && l.includes("-"); }
function splitRow(l: string): string[] {
  return l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
}

// ─── fenced code with header, copy button, and syntax highlight ───
function CodeBlock({ code, lang }: { code: string; lang?: string }): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="md-code-wrap">
      <div className="md-code-head">
        <span className="md-code-lang">{lang || "code"}</span>
        <button className={`md-copy ${copied ? "done" : ""}`} onClick={copy} title="Copy code">
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="md-code-block"><code>{highlight(code)}</code></pre>
    </div>
  );
}

/**
 * Lightweight, language-agnostic highlighter. One combined regex classifies
 * comments, strings, keywords, function calls, Types and numbers; anything
 * unmatched stays plain. Never throws — falls back to raw text on error.
 */
const HL = new RegExp(
  [
    /(?<com>\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)/, // comments
    /(?<str>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/, // strings
    /(?<kw>\b(?:const|let|var|function|return|if|else|for|while|import|from|export|default|class|new|await|async|type|interface|enum|extends|implements|public|private|protected|readonly|static|null|true|false|undefined|void|typeof|instanceof|in|of|switch|case|break|continue|throw|try|catch|finally|def|lambda|print|elif|then|fi|do|done|echo|yield|package|func|struct|impl|use|fn|module)\b)/,
    /(?<fn>\b[A-Za-z_$][\w$]*(?=\s*\())/, // function calls
    /(?<type>\b[A-Z][A-Za-z0-9_$]*\b)/, // Types / components
    /(?<num>\b\d+(?:\.\d+)?\b)/, // numbers
  ].map((r) => r.source).join("|"),
  "g"
);

function highlight(code: string): React.ReactNode[] {
  try {
    const out: React.ReactNode[] = [];
    let last = 0;
    let key = 0;
    let m: RegExpExecArray | null;
    HL.lastIndex = 0;
    while ((m = HL.exec(code)) !== null) {
      if (m.index > last) out.push(code.slice(last, m.index));
      const g = m.groups ?? {};
      const cls = g.com ? "sc" : g.str ? "ss" : g.kw ? "sk" : g.fn ? "sf" : g.type ? "st" : g.num ? "sn" : "";
      out.push(cls ? <span key={key++} className={cls}>{m[0]}</span> : m[0]);
      last = m.index + m[0].length;
      if (m[0].length === 0) HL.lastIndex++; // guard against zero-width matches
    }
    if (last < code.length) out.push(code.slice(last));
    return out;
  } catch {
    return [code];
  }
}

/**
 * Tokenize one line on links, **bold**, *italic*, _italic_, and `code`. Order
 * matters — links & bold first so single-* italic doesn't swallow `**bold**`.
 */
function renderInline(line: string, streaming = false): React.ReactNode[] {
  const re = /(\[[^\]\n]+\]\([^)\n]+\)|\*\*[^*\n]+\*\*|`[^`\n]+`|\*[^*\n]+\*|_[^_\n]+_)/g;
  const out: React.ReactNode[] = [];
  let lastIdx = 0;
  let key = 0;
  // While streaming, plain text becomes per-word spans: an appended word is a
  // NEW element (prior words keep their keys), so its mount animation fires
  // exactly once. Finalizing re-renders unsplit and the extra spans vanish.
  const pushText = (text: string) => {
    if (!streaming) {
      out.push(<span key={key++}>{text}</span>);
      return;
    }
    for (const w of text.split(/(?<=\s)/)) {
      if (w) out.push(<span key={key++} className="wfade">{w}</span>);
    }
  };
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (m.index > lastIdx) pushText(line.slice(lastIdx, m.index));
    const tok = m[0];
    if (tok.startsWith("[")) {
      const lm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
      if (lm) {
        const url = lm[2];
        out.push(
          <a
            key={key++}
            className="md-link"
            href={url}
            onClick={(e) => { e.preventDefault(); window.mycode?.openExternal(url); }}
          >
            {lm[1]}
          </a>
        );
      } else {
        out.push(<span key={key++}>{tok}</span>);
      }
    } else if (tok.startsWith("**")) {
      out.push(<strong key={key++} className="md-strong">{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith("`")) {
      out.push(<code key={key++} className="md-code">{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith("*") || tok.startsWith("_")) {
      out.push(<em key={key++} className="md-em">{tok.slice(1, -1)}</em>);
    }
    lastIdx = re.lastIndex;
  }
  if (lastIdx < line.length) pushText(line.slice(lastIdx));
  return out;
}
