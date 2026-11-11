// A safe Markdown subset for report prose: headings, lists, tables, fenced code, quotes, links and emphasis.
// Every value is escaped; raw HTML in the source is shown as text, never interpreted.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

// Web, mail and file links pass through. Absolute paths inside the artifact folder become relative links, so
// they survive moving the folder; other absolute paths become file: URLs. Any other scheme is dropped.
function safeUrl(raw, directory) {
  const url = String(raw).trim();
  if (/^(https?:|mailto:|file:)/i.test(url)) return url;
  if (path.isAbsolute(url)) {
    if (directory && url.startsWith(directory + path.sep)) {
      return path.relative(directory, url).split(path.sep).map(encodeURIComponent).join('/');
    }
    return pathToFileURL(url).href;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return null;
  try {
    return encodeURI(decodeURI(url));
  } catch {
    return encodeURI(url);
  }
}

export function inline(text, { directory } = {}) {
  // Code spans first, so nothing inside them is formatted.
  return String(text ?? '').replace(/\u0000/g, '').split(/(`[^`\n]+`)/).map((part) => {
    if (/^`[^`\n]+`$/.test(part)) return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
    let html = escapeHtml(part);
    const links = [];
    const hold = (link) => `\u0000${links.push(link) - 1}\u0000`;
    html = html.replace(/\[([^\]\n]+)\]\((?:&lt;([^\n]+?)&gt;|([^)\s]+))(?:\s+&quot;[^&]*&quot;)?\)/g, (match, label, angled, plain) => {
      const url = safeUrl((angled ?? plain).replace(/&amp;/g, '&'), directory);
      return url ? hold(`<a href="${escapeHtml(url)}">${label}</a>`) : label;
    });
    html = html.replace(/\bhttps?:\/\/[^\s<\u0000]+[^\s<\u0000.,;:!?)\]'"]/g, (url) => hold(`<a href="${url}">${url}</a>`));
    // Emphasis must hug its text, so globs and arithmetic such as "*.js and *.ts" stay literal.
    html = html.replace(/\*\*(?=\S)([^*\n]+?)(?<=\S)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^_\w])__(?=\S)([^_\n]+?)(?<=\S)__(?!\w)/g, '$1<strong>$2</strong>')
      .replace(/(^|[^*\w])\*(?=\S)([^*\n]+?)(?<=\S)\*(?!\w)/g, '$1<em>$2</em>')
      .replace(/(^|[^_\w])_(?=\S)([^_\n]+?)(?<=\S)_(?!\w)/g, '$1<em>$2</em>')
      .replace(/~~(?=\S)([^~\n]+?)(?<=\S)~~/g, '<del>$1</del>');
    return html.replace(/\u0000(\d+)\u0000/g, (match, index) => links[Number(index)] ?? '');
  }).join('');
}

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
// A table's delimiter row: cells of hyphens with optional alignment colons, separated by pipes.
const isTableRule = (line) => line.includes('|') && line.includes('-') && /^\s*\|?(\s*:?-+:?\s*\|)*\s*:?-+:?\s*\|?\s*$/.test(line);
const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());

function renderList(items, options) {
  // items: [{ indent, ordered, text }]; deeper indents nest under the item before them.
  const html = [];
  let i = 0;
  const level = (base) => {
    const ordered = items[i].ordered;
    html.push(ordered ? '<ol>' : '<ul>');
    while (i < items.length && items[i].indent >= base) {
      if (items[i].indent > base) { level(items[i].indent); continue; }
      const item = items[i++];
      const task = /^\[([ xX])\]\s+(.*)$/.exec(item.text);
      html.push(task
        ? `<li class="task"><span class="box">${task[1] === ' ' ? '☐' : '☑'}</span> ${inline(task[2], options)}`
        : `<li>${inline(item.text, options)}`);
      if (i < items.length && items[i].indent > base) level(items[i].indent);
      html.push('</li>');
    }
    html.push(ordered ? '</ol>' : '</ul>');
  };
  while (i < items.length) level(items[i].indent);
  return html.join('');
}

export function markdown(source, options = {}) {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  const startsBlock = (line, next) => /^\s*```/.test(line) || /^#{1,6}\s/.test(line) || /^>\s?/.test(line) ||
    LIST_ITEM.test(line) || RULE.test(line) || (line.includes('|') && isTableRule(next ?? ''));
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (/^\s*```/.test(line)) {
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      // Report sections own h1 and h2, so document headings start at h3.
      const n = Math.min(6, heading[1].length + 2);
      out.push(`<h${n}>${inline(heading[2].replace(/\s+#+\s*$/, ''), options)}</h${n}>`);
      i++;
      continue;
    }
    if (RULE.test(line)) { out.push('<hr>'); i++; continue; }
    if (line.includes('|') && isTableRule(lines[i + 1] ?? '')) {
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push(`<div class="table"><table><thead><tr>${head.map((cell) => `<th>${inline(cell, options)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${head.map((_, k) => `<td>${inline(row[k] ?? '', options)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const body = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${markdown(body.join('\n'), options)}</blockquote>`);
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const items = [];
      while (i < lines.length) {
        const match = LIST_ITEM.exec(lines[i]);
        if (match) {
          items.push({ indent: match[1].replace(/\t/g, '  ').length, ordered: /\d/.test(match[2]), text: match[3] });
          i++;
        } else if (lines[i].trim() && /^\s+/.test(lines[i]) && items.length) {
          items.at(-1).text += ` ${lines[i++].trim()}`;
        } else break;
      }
      out.push(renderList(items, options));
      continue;
    }
    const paragraph = [];
    while (i < lines.length && lines[i].trim() && (!paragraph.length || !startsBlock(lines[i], lines[i + 1]))) {
      paragraph.push(lines[i++].trim());
    }
    out.push(`<p>${inline(paragraph.join('\n'), options).replace(/\n/g, '<br>')}</p>`);
  }
  return out.join('\n');
}
