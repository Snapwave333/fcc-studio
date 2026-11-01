import { ReactNode, memo, useMemo, useState } from "react";
import { Check, Copy } from "lucide-react";
import { api } from "./api";

export type Block =
  | { type: "code"; lang: string; text: string }
  | { type: "heading"; level: number; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "quote"; text: string }
  | { type: "hr" }
  | { type: "table"; header: string[]; rows: string[][] }
  | { type: "p"; text: string };

const LIST_RE = /^\s*([-*+]|\d+[.)])\s+(.*)$/;

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*(```|~~~)\s*([\w+#.-]*)/);
    if (fence) {
      const marker = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(marker)) {
        body.push(lines[i]);
        i++;
      }
      i++;
      blocks.push({ type: "code", lang: fence[2] ?? "", text: body.join("\n") });
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2].replace(/\s*#+\s*$/, "") });
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      const header = splitRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      blocks.push({ type: "table", header, rows });
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      blocks.push({ type: "quote", text: body.join("\n") });
      continue;
    }
    const li = line.match(LIST_RE);
    if (li) {
      const ordered = /\d/.test(li[1]);
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i].match(LIST_RE);
        if (m && /\d/.test(m[1]) === ordered) {
          items.push(m[2]);
          i++;
        } else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
          items[items.length - 1] += " " + lines[i].trim();
          i++;
        } else {
          break;
        }
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*(```|~~~)/.test(lines[i]) &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !LIST_RE.test(lines[i]) &&
      !/^\s*>/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    blocks.push({ type: "p", text: para.join("\n") });
  }
  return blocks;
}

const INLINE_RE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*|__[^_\n]+__)|(\*[^*\n]+\*|\b_[^_\n]+_\b)|(\[[^\]\n]+\]\((https?:\/\/[^)\s]+)\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

function openLink(url: string) {
  api.openExternal(url).catch(() => {});
}

export function renderInline(text: string, keyBase = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(text.slice(last, idx));
    const key = `${keyBase}-${k++}`;
    if (m[1]) {
      out.push(
        <code key={key} className="rounded bg-[#0c0c10] px-1 py-px text-[12px] text-fuchsia2">
          {m[1].slice(1, -1)}
        </code>
      );
    } else if (m[2]) {
      out.push(<strong key={key}>{renderInline(m[2].slice(2, -2), key)}</strong>);
    } else if (m[3]) {
      out.push(<em key={key}>{renderInline(m[3].slice(1, -1), key)}</em>);
    } else if (m[4]) {
      const label = m[4].slice(1, m[4].indexOf("]("));
      const url = m[5];
      out.push(
        <a key={key} href={url} className="text-fuchsia2 underline underline-offset-2" onClick={(e) => { e.preventDefault(); openLink(url); }}>
          {label}
        </a>
      );
    } else if (m[6]) {
      const url = m[6];
      out.push(
        <a key={key} href={url} className="break-all text-fuchsia2 underline underline-offset-2" onClick={(e) => { e.preventDefault(); openLink(url); }}>
          {url}
        </a>
      );
    }
    last = idx + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="group relative my-1.5 overflow-hidden rounded-lg border border-[#26262f] bg-[#0c0c10]">
      <div className="flex items-center justify-between border-b border-[#1d1d25] px-3 py-1 text-[10.5px] text-muted">
        <span>{lang || "text"}</span>
        <button
          className="flex items-center gap-1 opacity-70 hover:text-text hover:opacity-100"
          onClick={() => {
            navigator.clipboard?.writeText(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            });
          }}
        >
          {copied ? <Check size={11} /> : <Copy size={11} />} {copied ? "copied" : "copy"}
        </button>
      </div>
      <pre className="overflow-x-auto px-3 py-2 font-mono text-[12px] leading-relaxed text-text2">
        <code>{text}</code>
      </pre>
    </div>
  );
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return (
    <div className="md space-y-2 break-words text-[13px] leading-relaxed text-text">
      {blocks.map((b, i) => {
        const key = `b${i}`;
        switch (b.type) {
          case "code":
            return <CodeBlock key={key} lang={b.lang} text={b.text} />;
          case "heading": {
            const size = b.level <= 1 ? "text-[16px]" : b.level === 2 ? "text-[14.5px]" : "text-[13.5px]";
            return (
              <div key={key} className={`${size} pt-1 font-semibold text-text`}>
                {renderInline(b.text, key)}
              </div>
            );
          }
          case "list": {
            const items = b.items.map((it, j) => (
              <li key={j} className="pl-0.5">
                {renderInline(it.replace(/^\[( |x)\]\s+/i, (s) => (s.includes("x") || s.includes("X") ? "☑ " : "☐ ")), `${key}-${j}`)}
              </li>
            ));
            return b.ordered ? (
              <ol key={key} className="list-decimal space-y-0.5 pl-5">{items}</ol>
            ) : (
              <ul key={key} className="list-disc space-y-0.5 pl-5">{items}</ul>
            );
          }
          case "quote":
            return (
              <blockquote key={key} className="border-l-2 border-fuchsia/60 pl-3 text-text2">
                {renderInline(b.text, key)}
              </blockquote>
            );
          case "hr":
            return <hr key={key} className="border-[#26262f]" />;
          case "table":
            return (
              <div key={key} className="overflow-x-auto">
                <table className="w-full border-collapse text-[12px]">
                  <thead>
                    <tr>
                      {b.header.map((h, j) => (
                        <th key={j} className="border border-[#26262f] bg-bg2 px-2 py-1 text-left font-semibold">
                          {renderInline(h, `${key}-h${j}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, j) => (
                      <tr key={j}>
                        {r.map((c, n) => (
                          <td key={n} className="border border-[#26262f] px-2 py-1 align-top">
                            {renderInline(c, `${key}-${j}-${n}`)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          default:
            return (
              <p key={key} className="whitespace-pre-wrap">
                {renderInline(b.text, key)}
              </p>
            );
        }
      })}
    </div>
  );
});
