export type Inline =
  | { kind: "text"; value: string }
  | { kind: "code"; value: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] }
  | { kind: "link"; href: string; children: Inline[] };

export type Block =
  | { kind: "code"; lang: string; value: string }
  | { kind: "heading"; level: number; children: Inline[] }
  | { kind: "list"; ordered: boolean; start: number; items: Inline[][] }
  | { kind: "quote"; children: Inline[] }
  | { kind: "rule" }
  | { kind: "table"; header: Inline[][]; rows: Inline[][][] }
  | { kind: "paragraph"; children: Inline[] };

const INLINE_RE = /(`+)([\s\S]*?[^`])\1(?!`)|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|\*([^*\s][^*]*?)\*|_([^_\s][^_]*?)_(?![A-Za-z0-9])|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  const re = new RegExp(INLINE_RE.source, "g");
  while ((m = re.exec(src))) {
    if (m.index > last) out.push({ kind: "text", value: src.slice(last, m.index) });
    if (m[2] !== undefined) out.push({ kind: "code", value: m[2].replace(/^ (.+) $/, "$1") });
    else if (m[3] !== undefined) out.push({ kind: "strong", children: parseInline(m[3]) });
    else if (m[4] !== undefined) out.push({ kind: "strong", children: parseInline(m[4]) });
    else if (m[5] !== undefined) out.push({ kind: "em", children: parseInline(m[5]) });
    else if (m[6] !== undefined) out.push({ kind: "em", children: parseInline(m[6]) });
    else if (m[7] !== undefined) out.push({ kind: "link", href: m[8], children: parseInline(m[7]) });
    else if (m[9] !== undefined) out.push({ kind: "link", href: m[9], children: [{ kind: "text", value: m[9] }] });
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ kind: "text", value: src.slice(last) });
  return out;
}

const FENCE_RE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const UL_RE = /^\s*[-*+]\s+(.*)$/;
const OL_RE = /^\s*(\d+)[.)]\s+(.*)$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;
const RULE_RE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(FENCE_RE);
    if (fence) {
      const marker = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(marker)) {
        body.push(lines[i]);
        i++;
      }
      i++;
      blocks.push({ kind: "code", lang: fence[2] ?? "", value: body.join("\n") });
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const heading = line.match(HEADING_RE);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1].length, children: parseInline(heading[2]) });
      i++;
      continue;
    }
    if (RULE_RE.test(line)) {
      blocks.push({ kind: "rule" });
      i++;
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      const header = splitRow(line).map(parseInline);
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(splitRow(lines[i]).map(parseInline));
        i++;
      }
      blocks.push({ kind: "table", header, rows });
      continue;
    }
    if (QUOTE_RE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) {
        body.push(lines[i].match(QUOTE_RE)![1]);
        i++;
      }
      blocks.push({ kind: "quote", children: parseInline(body.join("\n")) });
      continue;
    }
    const ul = line.match(UL_RE);
    const ol = line.match(OL_RE);
    if (ul || ol) {
      const ordered = !!ol;
      const start = ol ? parseInt(ol[1], 10) : 1;
      const items: string[] = [];
      while (i < lines.length) {
        const cur = lines[i];
        const m = ordered ? cur.match(OL_RE) : cur.match(UL_RE);
        if (m) {
          items.push(ordered ? m[2] : m[1]);
          i++;
        } else if (cur.trim() && /^\s{2,}/.test(cur) && items.length > 0) {
          items[items.length - 1] += "\n" + cur.trim();
          i++;
        } else {
          break;
        }
      }
      blocks.push({ kind: "list", ordered, start, items: items.map(parseInline) });
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !FENCE_RE.test(lines[i]) &&
      !HEADING_RE.test(lines[i]) &&
      !UL_RE.test(lines[i]) &&
      !OL_RE.test(lines[i]) &&
      !QUOTE_RE.test(lines[i]) &&
      !RULE_RE.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    blocks.push({ kind: "paragraph", children: parseInline(para.join("\n")) });
  }
  return blocks;
}
