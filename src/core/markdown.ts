// A small Markdown-to-HTML renderer for our own guide files (docs/guides/*.md).
// It supports exactly what those files use: headings, paragraphs, bold, inline code, links,
// ordered and unordered lists (with nested content), tables, fenced code and screenshot
// placeholders. All text is HTML-escaped; raw HTML in the source is shown as text.

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(text: string): string {
  // Pull code spans out first so their contents are not treated as bold or links.
  const codes: string[] = [];
  let s = text.replace(/`([^`]+)`/g, (_, code: string) => {
    codes.push(`<code>${esc(code)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(((?:https?:\/\/|\/)[^)\s]*)\)/g, '<a href="$2">$1</a>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => codes[Number(i)]);
}

const FENCE = /^```/;
const HEADING = /^(#{1,3})\s+(.*)$/;
const ITEM = /^(\d+\.|-)\s+(.*)$/;
const SHOT = /^`\[\s*Screenshot:\s*(.*?)\s*\]`$/;
const TABLE_RULE = /^\|[\s:|-]+\|$/;

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const cells = (row: string) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
const indentOf = (line: string) => line.length - line.trimStart().length;
const startsBlock = (line: string) =>
  FENCE.test(line) || HEADING.test(line) || ITEM.test(line) || SHOT.test(line.trim()) || line.startsWith('|');

function renderBlocks(lines: string[]): string {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }

    if (FENCE.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i])) body.push(lines[i++]);
      i++; // closing fence
      out.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}${level === 2 ? ` id="${slug(heading[2])}"` : ''}>${inline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    const shot = SHOT.exec(line.trim());
    if (shot) {
      out.push(`<div class="shot">Screenshot: ${esc(shot[1])}</div>`);
      i++;
      continue;
    }

    if (line.startsWith('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1].trim())) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(cells(lines[i++]));
      out.push(
        `<table><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>` +
          rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('') +
          '</tbody></table>',
      );
      continue;
    }

    const first = ITEM.exec(line);
    if (first) {
      const ordered = first[1] !== '-';
      const items: string[] = [];
      while (i < lines.length) {
        const m = ITEM.exec(lines[i]);
        if (!m || (m[1] !== '-') !== ordered) break;
        const body: string[] = [m[2]];
        i++;
        // Continuation: indented lines, and blank lines that are followed by more indented lines.
        while (i < lines.length) {
          if (lines[i].trim() === '') {
            let j = i;
            while (j < lines.length && lines[j].trim() === '') j++;
            if (j < lines.length && indentOf(lines[j]) >= 2) {
              body.push('');
              i++;
              continue;
            }
            break;
          }
          if (indentOf(lines[i]) < 2) break;
          body.push(lines[i++]);
        }
        const rest = body.slice(1);
        const indent = Math.min(...rest.filter((l) => l.trim() !== '').map(indentOf), 99);
        const dedented = rest.map((l) => l.slice(Math.min(indent, indentOf(l))));
        // Plain wrapped lines belong to the item's own sentence; anything after is nested content.
        let lead = body[0];
        let k = 0;
        while (k < dedented.length && dedented[k].trim() !== '' && !startsBlock(dedented[k])) lead += ` ${dedented[k++].trim()}`;
        const nested = dedented.slice(k);
        items.push(nested.some((l) => l.trim() !== '') ? `${inline(lead)}${renderBlocks(nested)}` : inline(lead));
        // Skip blank lines between items of the same list.
        let j = i;
        while (j < lines.length && lines[j].trim() === '') j++;
        const next = j < lines.length ? ITEM.exec(lines[j]) : null;
        if (next && (next[1] !== '-') === ordered) i = j;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((it) => `<li>${it}</li>`).join('')}</${tag}>`);
      continue;
    }

    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !FENCE.test(lines[i]) &&
      !HEADING.test(lines[i]) &&
      !ITEM.test(lines[i]) &&
      !SHOT.test(lines[i].trim()) &&
      !(lines[i].startsWith('|') && para.length > 0)
    ) {
      para.push(lines[i++].trim());
    }
    if (para.length === 0) para.push(lines[i++].trim()); // a lone "|" line or similar: never loop forever
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return out.join('\n');
}

export function renderMarkdown(markdown: string): string {
  return renderBlocks(markdown.replace(/\r\n/g, '\n').split('\n'));
}

/** The text of the first "# " heading. */
export function titleOf(markdown: string): string {
  const m = /^#\s+(.*)$/m.exec(markdown.replace(/\r\n/g, '\n'));
  return m ? m[1].trim() : '';
}
