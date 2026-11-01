import { MemoryEntry, SelectedElement } from "./api";

export interface PromptInput {
  text: string;
  skill?: string | null;
  element?: SelectedElement | null;
  instructions?: string;
  memory?: Pick<MemoryEntry, "kind" | "title" | "body">[];
}

export interface BuiltPrompt {
  prompt: string;
  systemPrompt: string;
}

const MAX_MEMORY_CHARS = 6000;

export function buildPrompt({ text, skill, element, instructions, memory = [] }: PromptInput): BuiltPrompt {
  let prompt = skill ? `Use the "${skill}" skill for this task.\n\n${text}` : text;
  if (element) {
    prompt +=
      `\n\n[Selected UI element from live preview]\n` +
      `tag: ${element.tag}\n` +
      (element.id ? `id: ${element.id}\n` : "") +
      `selector: ${element.selector}\n` +
      (element.classes.length ? `classes: ${element.classes.join(", ")}\n` : "") +
      (element.text ? `text: ${element.text}\n` : "") +
      `html: ${element.html}`;
  }

  const sections: string[] = [];
  if (instructions?.trim()) sections.push(`Project instructions:\n${instructions.trim()}`);
  const lines: string[] = [];
  let used = 0;
  for (const m of memory) {
    const line = `- [${m.kind}] ${m.title}${m.body.trim() ? `: ${m.body.trim()}` : ""}`;
    if (used + line.length > MAX_MEMORY_CHARS) break;
    lines.push(line);
    used += line.length + 1;
  }
  if (lines.length) sections.push(`Relevant memory:\n${lines.join("\n")}`);

  return { prompt, systemPrompt: sections.join("\n\n") };
}
