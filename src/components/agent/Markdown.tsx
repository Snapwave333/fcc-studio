import { memo, useMemo, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Block, Inline, parseMarkdown } from "../../lib/markdown";
import { api } from "../../lib/api";

function InlineView({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.kind) {
          case "text":
            return <span key={i}>{n.value}</span>;
          case "code":
            return (
              <code key={i} className="rounded bg-[#0c0c10] px-1 py-px text-[12px] text-fuchsia2">
                {n.value}
              </code>
            );
          case "strong":
            return (
              <strong key={i} className="font-semibold text-text">
                <InlineView nodes={n.children} />
              </strong>
            );
          case "em":
            return (
              <em key={i}>
                <InlineView nodes={n.children} />
              </em>
            );
          case "link":
            return (
              <a
                key={i}
                href={n.href}
                className="text-fuchsia2 underline decoration-fuchsia/40 underline-offset-2 hover:decoration-fuchsia2"
                onClick={(e) => {
                  e.preventDefault();
                  if (/^https?:\/\//i.test(n.href)) api.openExternal(n.href).catch(() => {});
                }}
              >
                <InlineView nodes={n.children} />
              </a>
            );
        }
      })}
    </>
  );
}

function CodeBlock({ lang, value }: { lang: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="group relative my-1.5 overflow-hidden rounded-lg border border-[#26262f] bg-[#0c0c10]">
      <div className="flex items-center justify-between border-b border-[#1d1d26] px-3 py-1 text-[10.5px] text-muted">
        <span>{lang || "text"}</span>
        <button
          className="flex items-center gap-1 opacity-60 hover:text-text hover:opacity-100"
          onClick={() => {
            navigator.clipboard
              ?.writeText(value)
              .then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              })
              .catch(() => {});
          }}
        >
          {copied ? <Check size={11} /> : <Copy size={11} />}
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <pre className="overflow-x-auto px-3 py-2 font-mono text-[12px] leading-relaxed text-text2">
        <code>{value}</code>
      </pre>
    </div>
  );
}

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case "code":
      return <CodeBlock lang={block.lang} value={block.value} />;
    case "heading": {
      const size = block.level <= 1 ? "text-[15px]" : block.level === 2 ? "text-[14px]" : "text-[13px]";
      return (
        <div className={`mt-2 font-semibold text-text ${size}`}>
          <InlineView nodes={block.children} />
        </div>
      );
    }
    case "list":
      return block.ordered ? (
        <ol start={block.start} className="ml-5 list-decimal space-y-0.5">
          {block.items.map((it, i) => (
            <li key={i} className="whitespace-pre-wrap">
              <InlineView nodes={it} />
            </li>
          ))}
        </ol>
      ) : (
        <ul className="ml-5 list-disc space-y-0.5 marker:text-fuchsia2">
          {block.items.map((it, i) => (
            <li key={i} className="whitespace-pre-wrap">
              <InlineView nodes={it} />
            </li>
          ))}
        </ul>
      );
    case "quote":
      return (
        <blockquote className="whitespace-pre-wrap border-l-2 border-fuchsia/60 pl-3 text-text2">
          <InlineView nodes={block.children} />
        </blockquote>
      );
    case "rule":
      return <hr className="my-2 border-[#26262f]" />;
    case "table":
      return (
        <div className="my-1.5 overflow-x-auto">
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr>
                {block.header.map((h, i) => (
                  <th key={i} className="border border-[#26262f] bg-panel px-2 py-1 text-left font-semibold">
                    <InlineView nodes={h} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, ci) => (
                    <td key={ci} className="border border-[#26262f] px-2 py-1 align-top">
                      <InlineView nodes={c} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "paragraph":
      return (
        <p className="whitespace-pre-wrap">
          <InlineView nodes={block.children} />
        </p>
      );
  }
}

function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div className="space-y-2 break-words text-[13px] leading-relaxed text-text">
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} />
      ))}
    </div>
  );
}

export default memo(Markdown);
