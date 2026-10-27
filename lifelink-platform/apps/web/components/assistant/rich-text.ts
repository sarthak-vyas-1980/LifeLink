/**
 * A small, safe Markdown subset for assistant answers: headings, paragraphs, bullet lists,
 * numbered steps, fenced code, **bold**, and `code`. Text is never rendered as HTML.
 */
export type RichBlock =
  | { kind: "heading"; level: 2 | 3; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "bullets"; items: string[] }
  | { kind: "steps"; items: string[] }
  | { kind: "code"; language: string | null; code: string };

export type RichInline = { kind: "text" | "bold" | "code"; text: string };

export function parseRichText(content: string): RichBlock[] {
  const blocks: RichBlock[] = [];
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  let paragraph: string[] = [];
  let list: { kind: "bullets" | "steps"; items: string[] } | null = null;
  const flushParagraph = () => { if (paragraph.length) blocks.push({ kind: "paragraph", text: paragraph.join("\n") }); paragraph = []; };
  const flushList = () => { if (list?.items.length) blocks.push({ kind: list.kind, items: list.items }); list = null; };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = line.match(/^\s*```\s*([\w+-]*)\s*$/);
    if (fence) {
      flushParagraph(); flushList();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) { code.push(lines[index]); index += 1; }
      blocks.push({ kind: "code", language: fence[1] || null, code: code.join("\n") });
      continue;
    }
    const heading = line.match(/^\s{0,3}(#{1,4})\s+(.+?)\s*#*\s*$/);
    if (heading) { flushParagraph(); flushList(); blocks.push({ kind: "heading", level: heading[1].length <= 2 ? 2 : 3, text: heading[2] }); continue; }
    const bullet = line.match(/^\s{0,3}[-*•]\s+(.+)$/);
    const step = line.match(/^\s{0,3}(\d{1,2})[.)]\s+(.+)$/);
    if (bullet || step) {
      flushParagraph();
      const kind = bullet ? "bullets" : "steps";
      if (list && list.kind !== kind) flushList();
      if (!list) list = { kind, items: [] };
      list.items.push((bullet ? bullet[1] : step![2]).trim());
      continue;
    }
    if (!line.trim()) { flushParagraph(); flushList(); continue; }
    // An indented continuation line belongs to the current list item.
    if (list && /^\s{2,}\S/.test(line)) { list.items[list.items.length - 1] += `\n${line.trim()}`; continue; }
    flushList();
    paragraph.push(line);
  }
  flushParagraph(); flushList();
  return blocks;
}

export function parseInline(text: string): RichInline[] {
  const parts: RichInline[] = [];
  for (const piece of text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g)) {
    if (!piece) continue;
    if (piece.length > 2 && piece.startsWith("`") && piece.endsWith("`")) parts.push({ kind: "code", text: piece.slice(1, -1) });
    else if (piece.length > 4 && piece.startsWith("**") && piece.endsWith("**")) parts.push({ kind: "bold", text: piece.slice(2, -2) });
    else parts.push({ kind: "text", text: piece });
  }
  return parts;
}
