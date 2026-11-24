import { createRequire } from 'node:module';

// sitegen — a fast drop-in reimplementation of the makefun-site 1.0.0 build.
// run(input) returns the same output tree (path -> text) for every input.
// Written from the published dialect spec; organised as: text helpers,
// front matter, Markdown, templates, then the build pipeline itself.

// ---------------------------------------------------------------- text rules

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const RE_ESC = /[&<>"']/g;

// Slice-built escaping: one native scan, entity substitutions appended as
// slices, and the untouched string returned when nothing needs escaping.
function esc(text) {
  RE_ESC.lastIndex = 0;
  const first = RE_ESC.exec(text);
  if (first === null) return text;
  let out = text.slice(0, first.index) + ESCAPE_MAP[first[0]];
  let segStart = RE_ESC.lastIndex;
  let m;
  while ((m = RE_ESC.exec(text)) !== null) {
    out += text.slice(segStart, m.index) + ESCAPE_MAP[m[0]];
    segStart = RE_ESC.lastIndex;
  }
  return out + text.slice(segStart);
}

const SLUG_LIMIT = 64;

function makeSlug(text) {
  // ASCII text is unchanged by NFKD and holds no combining marks, so it can
  // skip the normalisation pass entirely and work on char codes directly.
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (ascii) {
    let slug = '';
    let pendingDash = false;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      let keep = -1;
      if (code >= 65 && code <= 90) keep = code + 32;
      else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = code;
      if (keep === -1) {
        pendingDash = slug.length > 0;
        continue;
      }
      if (pendingDash) slug += '-';
      pendingDash = false;
      slug += String.fromCharCode(keep);
    }
    slug = slug.slice(0, SLUG_LIMIT).replace(/-+$/, '');
    return slug === '' ? 'untitled' : slug;
  }
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let slug = '';
  let pendingDash = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      pendingDash = slug.length > 0;
      continue;
    }
    if (pendingDash) slug += '-';
    pendingDash = false;
    slug += keep;
  }
  slug = slug.slice(0, SLUG_LIMIT).replace(/-+$/, '');
  return slug === '' ? 'untitled' : slug;
}

function claimSlug(base, takenSet) {
  let candidate = base;
  for (let n = 2; takenSet.has(candidate); n++) candidate = `${base}-${n}`;
  takenSet.add(candidate);
  return candidate;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function longFormDate(dateStr) {
  // dateStr is a validated YYYY-MM-DD, so fixed slices replace the split.
  return `${Number(dateStr.slice(8))} ${MONTH_NAMES[Number(dateStr.slice(5, 7)) - 1]} ${dateStr.slice(0, 4)}`;
}

function cmpCodeUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ------------------------------------------------------------- front matter

const KNOWN_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const KNOWN_KEY_SET = new Set(KNOWN_KEYS);
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE_SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LAYOUT_SHAPE = /^[a-z0-9-]+$/;
const SLUG_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_SHAPE = /^[^"[\]]+$/;

function monthLength(year, month) {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function readStringValue(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let value = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const nxt = raw[i + 1];
        if ((nxt !== '"' && nxt !== '\\') || i + 1 === raw.length - 1) {
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        }
        value += nxt;
        i++;
      } else if (c === '"') {
        return { error: 'a quoted string holds a stray quote' };
      } else {
        value += c;
      }
    }
    return { value };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function readKeyValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = readStringValue(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_SHAPE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > monthLength(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const names = inner.split(',').map((t) => t.trim());
      if (names.some((t) => t === '' || !TAG_SHAPE.test(t))) {
        return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: names };
    }
    case 'draft':
      if (raw === 'true') return { value: true };
      if (raw === 'false') return { value: false };
      return { error: 'key "draft": true or false' };
    case 'layout':
      return LAYOUT_SHAPE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_SHAPE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

// Returns { data, body } or { error } — the first refusal reason met, line by line.
// The closing line is located first (the original error order: an unclosed
// block reports "not closed" before any line inside it is judged), walking
// line boundaries by index so the document body is never split into lines.
function parseMatter(text) {
  const firstNl = text.indexOf('\n');
  const firstLine = firstNl === -1 ? text : text.slice(0, firstNl);
  if (firstLine !== '---') return { error: 'no front matter' };
  let closeAt = -1; // index just past the closing line's newline (or text end)
  let fmEnd = -1; // index where the closing line starts
  let pos = firstNl === -1 ? text.length : firstNl + 1;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? text.length : nl;
    if (text.slice(pos, lineEnd) === '---') {
      fmEnd = pos;
      closeAt = nl === -1 ? text.length : nl + 1;
      break;
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (closeAt === -1) return { error: 'the front matter is not closed' };
  const data = {};
  const fmLines = text.slice(firstNl + 1, fmEnd).split('\n');
  for (let i = 0; i < fmLines.length; i++) {
    const line = fmLines[i];
    if (isBlankLine(line) || line.startsWith('#')) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${i + 2} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!KNOWN_KEY_SET.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = readKeyValue(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeAt) };
}

// ----------------------------------------------------------------- markdown

const RE_BLANK = /^[ \t]*$/;
const RE_FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const RE_FENCE_CLOSE = /^```[ \t]*$/;
const RE_HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const RE_BREAK = /^(?:---|\*\*\*)[ \t]*$/;
const RE_BULLET = /^[-*] (.*)$/;
const RE_ORDERED = /^(\d{1,9})\. (.*)$/;
const RE_CONTINUATION = /^ {2,}\S/;

function matchHeading(line) {
  if (line.charCodeAt(0) !== 35) return null; // '#'
  const m = RE_HEADING.exec(line);
  return m === null || m[2] === '' ? null : { level: m[1].length, text: m[2] };
}

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const code = line.charCodeAt(i);
    if (code !== 32 && code !== 9) return false;
  }
  return true;
}

function paragraphEndsAt(line) {
  if (isBlankLine(line)) return true;
  // Only three line shapes can end a paragraph, each pinned to its first
  // character, so the regexes run only on candidate lines.
  const c = line.charCodeAt(0);
  if (c === 96) return RE_FENCE_OPEN.test(line); // '`'
  if (c === 35) return matchHeading(line) !== null; // '#'
  if (c === 45 || c === 42) return RE_BREAK.test(line); // '-' or '*'
  return false;
}

// Trim spaces and tabs (only those two) from both ends.
function trimPad(line) {
  let start = 0;
  let end = line.length;
  while (start < end && (line.charCodeAt(start) === 32 || line.charCodeAt(start) === 9)) start++;
  while (end > start && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
  return start === 0 && end === line.length ? line : line.slice(start, end);
}

// Split a body into block tokens, in order.
function lexBlocks(src) {
  const lines = src.split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlankLine(line)) {
      i++;
      continue;
    }
    const fence = line.charCodeAt(0) === 96 ? RE_FENCE_OPEN.exec(line) : null;
    if (fence !== null) {
      const bodyLines = [];
      i++;
      while (i < lines.length && !(lines[i].charCodeAt(0) === 96 && RE_FENCE_CLOSE.test(lines[i]))) bodyLines.push(lines[i++]);
      i++;
      blocks.push({ kind: 'code', lang: fence[1], lines: bodyLines });
      continue;
    }
    const heading = matchHeading(line);
    if (heading !== null) {
      blocks.push({ kind: 'heading', level: heading.level, text: heading.text });
      i++;
      continue;
    }
    if (RE_BREAK.test(line)) {
      blocks.push({ kind: 'hr' });
      i++;
      continue;
    }
    if (line.startsWith('>')) {
      const quoted = [];
      while (i < lines.length && lines[i].startsWith('>')) quoted.push(lines[i++].replace(/^> ?/, ''));
      blocks.push({ kind: 'quote', lines: quoted.map(trimPad).filter((l) => l !== '') });
      continue;
    }
    // Bullet markers start with '-' or '*', ordered markers with a digit;
    // the two families are disjoint, so gate each regex on the first char.
    const c0 = line.charCodeAt(0);
    const bullet = c0 === 45 || c0 === 42 ? RE_BULLET.exec(line) : null;
    const ordered = bullet === null && c0 >= 48 && c0 <= 57 ? RE_ORDERED.exec(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const marker = isOrdered ? RE_ORDERED : RE_BULLET;
      const items = [];
      while (i < lines.length) {
        const m = marker.exec(lines[i]);
        if (m !== null) {
          items.push([trimPad(isOrdered ? m[2] : m[1])]);
          i++;
        } else if (RE_CONTINUATION.test(lines[i])) {
          items[items.length - 1].push(trimPad(lines[i]));
          i++;
        } else break;
      }
      blocks.push({ kind: 'list', ordered: isOrdered, start: isOrdered ? Number(ordered[1]) : 1, items: items.map((parts) => parts.join('\n')) });
      continue;
    }
    const paraLines = [trimPad(line)];
    i++;
    while (i < lines.length && !paragraphEndsAt(lines[i])) paraLines.push(trimPad(lines[i++]));
    blocks.push({ kind: 'para', text: paraLines.join('\n') });
  }
  return blocks;
}

const ESCAPABLE_CHARS = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

// First index >= from where `needle` occurs outside a backslash escape, or -1.
function scanUnescaped(s, needle, from) {
  for (let j = from; j <= s.length - needle.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE_CHARS.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(needle, j)) return j;
  }
  return -1;
}

// First lone * at or after `from` (not part of a ** run), outside an escape, or -1.
function scanLoneStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE_CHARS.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

// Render one line-run's inline markup; linkOf(target) resolves a link's href.
// The pattern is shared across calls: it finds the next markup-significant
// character in one native scan, plain stretches between such characters are
// emitted as raw slices (they hold no &<>"' by construction), and every
// branch that recurses into renderInline re-seats lastIndex before the scan
// resumes, so the shared object's position is never trusted across a call.
const RE_INLINE_SPECIAL = /[\\`*\[&<>"']/g;
function renderInline(s, linkOf) {
  const re = RE_INLINE_SPECIAL;
  re.lastIndex = 0; // a nested call must scan its slice from the start
  let out = '';
  let segStart = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    let i = m.index;
    const c = s[i];
    if (c === '&' || c === '<' || c === '>' || c === '"' || c === "'") {
      out += s.slice(segStart, i) + ESCAPE_MAP[c];
      i++;
      segStart = i;
      re.lastIndex = i;
      continue;
    }
    if (c === '\\') {
      if (i + 1 < s.length && ESCAPABLE_CHARS.has(s[i + 1])) {
        out += s.slice(segStart, i) + esc(s[i + 1]);
        i += 2;
        segStart = i;
        re.lastIndex = i;
      }
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', i + 1);
      if (k > i + 1) {
        out += s.slice(segStart, i) + `<code>${esc(s.slice(i + 1, k))}</code>`;
        i = k + 1;
        segStart = i;
        re.lastIndex = i;
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const k = scanUnescaped(s, '**', i + 2);
        if (k > i + 2) {
          out += s.slice(segStart, i) + `<strong>${renderInline(s.slice(i + 2, k), linkOf)}</strong>`;
          i = k + 2;
          segStart = i;
          re.lastIndex = i;
        } else {
          re.lastIndex = i + 2;
        }
        continue;
      }
      const k = scanLoneStar(s, i + 1);
      if (k > i + 1) {
        out += s.slice(segStart, i) + `<em>${renderInline(s.slice(i + 1, k), linkOf)}</em>`;
        i = k + 1;
        segStart = i;
        re.lastIndex = i;
      }
      continue;
    }
    // c === '['
    const k = scanUnescaped(s, ']', i + 1);
    const end = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = end === -1 ? '' : s.slice(k + 2, end);
    if (target !== '' && !/\s/.test(target)) {
      out += s.slice(segStart, i) + `<a href="${esc(linkOf(target))}">${renderInline(s.slice(i + 1, k), linkOf)}</a>`;
      i = end + 1;
      segStart = i;
      re.lastIndex = i;
    }
  }
  return out + s.slice(segStart);
}

// Render a body: { html, toc, excerpt }.
function renderBody(src, linkOf) {
  const usedIds = new Set();
  let html = '';
  const toc = [];
  let excerpt = null;
  for (const block of lexBlocks(src)) {
    switch (block.kind) {
      case 'heading': {
        const id = claimSlug(makeSlug(block.text), usedIds);
        const inner = renderInline(block.text, linkOf);
        html += `<h${block.level} id="${id}">${inner}</h${block.level}>\n`;
        if (block.level === 2 || block.level === 3) toc.push({ level: block.level, id, html: inner });
        break;
      }
      case 'code': {
        const cls = block.lang === '' ? '' : ` class="language-${esc(block.lang)}"`;
        const raw = block.lines.length === 0 ? '' : `${block.lines.join('\n')}\n`;
        html += `<pre><code${cls}>${esc(raw)}</code></pre>\n`;
        break;
      }
      case 'hr':
        html += '<hr>\n';
        break;
      case 'quote':
        html += block.lines.length === 0
          ? '<blockquote>\n</blockquote>\n'
          : `<blockquote>\n<p>${renderInline(block.lines.join('\n'), linkOf)}</p>\n</blockquote>\n`;
        break;
      case 'list': {
        const tagName = block.ordered ? 'ol' : 'ul';
        const openTag = block.ordered && block.start !== 1 ? `<ol start="${block.start}">` : `<${tagName}>`;
        let listHtml = `${openTag}\n`;
        for (const item of block.items) listHtml += `<li>${renderInline(item, linkOf)}</li>\n`;
        html += `${listHtml}</${tagName}>\n`;
        break;
      }
      case 'para': {
        const inner = renderInline(block.text, linkOf);
        if (excerpt === null) excerpt = inner;
        html += `<p>${inner}</p>\n`;
        break;
      }
    }
  }
  return { html, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

const RE_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const RE_FOR_TAG = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const RE_IF_TAG = /^if (not )?(\S+)$/;
const RE_INCLUDE_TAG = /^include "([a-z0-9-]+)"$/;
const INCLUDE_MAX_DEPTH = 8;

class TemplateProblem extends Error {}

function parsePath(name, text) {
  if (!RE_PATH.test(text)) throw new TemplateProblem(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

// Split template source into text / var / raw / tag tokens. A {% %} tag that is
// alone on its line takes the whole line (and its newline) with it.
function tokenizeTemplate(name, src) {
  const tokens = [];
  let pending = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      pending += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      pending += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    pending += src.slice(i, open);
    if (next === '{') {
      const isRaw = src[open + 2] === '{';
      const closer = isRaw ? '}}}' : '}}';
      const close = src.indexOf(closer, open + (isRaw ? 3 : 2));
      if (close === -1) throw new TemplateProblem(`template "${name}": a ${isRaw ? '{{{' : '{{'} is not closed`);
      if (pending !== '') tokens.push({ t: 'text', text: pending });
      pending = '';
      tokens.push({ t: isRaw ? 'raw' : 'var', path: parsePath(name, src.slice(open + (isRaw ? 3 : 2), close).trim()) });
      i = close + (isRaw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateProblem(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const alone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (alone) pending = pending.slice(0, pending.length - (open - lineStart));
    if (pending !== '') tokens.push({ t: 'text', text: pending });
    pending = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = alone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (pending !== '') tokens.push({ t: 'text', text: pending });
  return tokens;
}

// Parse template source into a node tree; throws TemplateProblem.
function compileTemplate(name, src) {
  const rootNode = { kind: 'root', body: [] };
  const stack = [rootNode];
  let current = rootNode.body;
  for (const tok of tokenizeTemplate(name, src)) {
    if (tok.t === 'text') {
      current.push({ kind: 'text', k: 0, text: tok.text });
      continue;
    }
    if (tok.t === 'var' || tok.t === 'raw') {
      current.push({ kind: tok.t, k: tok.t === 'var' ? 1 : 2, path: tok.path });
      continue;
    }
    const tag = tok.tag;
    const top = stack[stack.length - 1];
    let m;
    if ((m = RE_FOR_TAG.exec(tag)) !== null) {
      const node = { kind: 'for', k: 4, name: m[1], path: parsePath(name, m[2]), body: [] };
      current.push(node);
      stack.push(node);
      current = node.body;
    } else if ((m = RE_IF_TAG.exec(tag)) !== null) {
      const node = { kind: 'if', k: 3, not: m[1] !== undefined, path: parsePath(name, m[2]), then: [], else: null };
      current.push(node);
      stack.push(node);
      current = node.then;
    } else if (tag === 'else') {
      if (top.kind !== 'if' || top.else !== null) throw new TemplateProblem(`template "${name}": an else outside an if`);
      top.else = [];
      current = top.else;
    } else if (tag === 'endfor' || tag === 'endif') {
      if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) {
        throw new TemplateProblem(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      }
      stack.pop();
      const parent = stack[stack.length - 1];
      current = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
    } else if ((m = RE_INCLUDE_TAG.exec(tag)) !== null) {
      current.push({ kind: 'include', k: 5, name: m[1] });
    } else {
      throw new TemplateProblem(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateProblem(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return rootNode.body;
}

// Resolve a dotted path against the scope chain (an array of vars objects,
// innermost last). The chain is pushed/popped by loops instead of allocating
// a fresh scope wrapper object for every iteration.
function resolvePath(chain, path) {
  const head = path[0];
  for (let s = chain.length - 1; s >= 0; s--) {
    const vars = chain[s];
    if (!Object.hasOwn(vars, head)) continue;
    let value = vars[head];
    for (let k = 1; k < path.length; k++) {
      if (value === null || typeof value !== 'object' || !Object.hasOwn(value, path[k])) return undefined;
      value = value[path[k]];
    }
    return value;
  }
  return undefined;
}

function valueToText(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(valueToText).join(', ');
  return '';
}

function isTruthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// Node kind codes for the interpreter's dispatch: 0 text, 1 var, 2 raw,
// 3 if, 4 for, 5 include (assigned in compileTemplate alongside `kind`).
// Rendered fragments are pushed onto a shared array and joined once by the
// caller, instead of concatenating a result string at every node and loop
// iteration.
function renderTree(nodes, chain, compiled, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const node = nodes[ni];
    switch (node.k) {
      case 0:
        out.push(node.text);
        break;
      case 1:
        out.push(esc(valueToText(resolvePath(chain, node.path))));
        break;
      case 2:
        out.push(valueToText(resolvePath(chain, node.path)));
        break;
      case 3: {
        const branch = isTruthy(resolvePath(chain, node.path)) !== node.not ? node.then : node.else;
        if (branch !== null) renderTree(branch, chain, compiled, depth, out);
        break;
      }
      case 4: {
        const items = resolvePath(chain, node.path);
        if (!Array.isArray(items)) break;
        // The loop's vars and loop objects are reused across iterations via
        // the node itself; a re-entrant render of the same loop (a template
        // including itself inside its own loop) falls back to fresh objects.
        const mine = !node._active;
        const vars = mine ? (node._vars ?? { loop: {} }) : { loop: {} };
        if (mine) {
          node._vars = vars;
          node._active = true;
        }
        const loop = vars.loop;
        chain.push(vars);
        for (let k = 0; k < items.length; k++) {
          vars[node.name] = items[k];
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === items.length - 1;
          loop.length = items.length;
          renderTree(node.body, chain, compiled, depth, out);
        }
        chain.pop();
        if (mine) node._active = false;
        break;
      }
      case 5: {
        const inner = compiled.get(node.name);
        if (inner !== undefined && depth < INCLUDE_MAX_DEPTH) renderTree(inner, chain, compiled, depth + 1, out);
        break;
      }
    }
  }
}

// ------------------------------------------------------------ build pipeline

const RESERVED_DIRS = ['posts', 'tags', 'page'];
const REPORT_NAME = 'build-report.txt';

function parentDirOf(path) {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
}

// Word count with the same whitespace definition as \s, counted by scanning
// for whitespace -> non-whitespace transitions instead of building the
// array of every word a /\S+/g match would return.
function countWords(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // Fast path: printable ASCII above the space is a word character; the
    // only ASCII whitespace is 0x09-0x0d and 0x20, both <= 0x20.
    if (code > 0x20) {
      if (code < 0xa0) {
        if (!inWord) { inWord = true; count++; }
        continue;
      }
      const space =
        code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) ||
        code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f ||
        code === 0x3000 || code === 0xfeff;
      if (space) inWord = false;
      else if (!inWord) { inWord = true; count++; }
    } else if (code === 0x20 || (code >= 0x09 && code <= 0x0d)) {
      inWord = false;
    } else if (!inWord) {
      // Remaining control characters count as word characters, as \s does.
      inWord = true;
      count++;
    }
  }
  return count;
}

// Resolve a link's relative path from a source's directory; null if it climbs above the root.
function resolveLinkPath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

function buildSite(input) {
  const notes = [];

  // Templates first, in name order; one that fails to compile is reported and left out.
  const compiled = new Map();
  for (const name of Object.keys(input.templates).sort(cmpCodeUnits)) {
    try {
      compiled.set(name, compileTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateProblem)) throw err;
      notes.push(err.message);
    }
  }

  const base = input.site.base_url.replace(/\/+$/, '');
  const state = {
    notes,
    broken: new Set(),
    sources: [],
    statics: [],
    byPath: new Map(),
    posts: [],
    tagList: [],
    output: {},
  };

  // 1. Sources sorted by path; .md files are sources (line ends normalised), the rest static.
  const orderedFiles = [...input.files].sort((x, y) => cmpCodeUnits(x.path, y.path));
  for (const f of orderedFiles) {
    if (f.path.endsWith('.md')) state.sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    else state.statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter and the drop checks, in their fixed order.
  const kept = [];
  for (const s of state.sources) {
    const fm = parseMatter(s.text);
    if ('error' in fm) {
      notes.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const ownDir = RESERVED_DIRS.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (ownDir !== undefined) {
      notes.push(`refused ${s.path}: ${ownDir}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      notes.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layoutName = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!compiled.has(layoutName)) {
      notes.push(`refused ${s.path}: layout "${layoutName}" is no template that parses`);
      continue;
    }
    s.layout = layoutName;
    if (s.data.draft === true) {
      notes.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  state.sources = kept;

  // 3. Permalinks: slug unique within its directory, claimed in source order.
  const claimedByDir = new Map();
  const claimedIn = (dir) => {
    if (!claimedByDir.has(dir)) claimedByDir.set(dir, new Set(dir === '' ? RESERVED_DIRS : []));
    return claimedByDir.get(dir);
  };
  for (const s of state.sources) {
    const dir = s.post ? 'posts' : parentDirOf(s.path);
    const slug = claimSlug(s.data.slug ?? makeSlug(s.data.title), claimedIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    state.byPath.set(s.path, s);
  }

  // 4. Markdown bodies, with link resolution against pages and static files.
  const staticPaths = new Set(state.statics.map((f) => f.path));
  for (const s of state.sources) {
    const dir = parentDirOf(s.path);
    const linkOf = (target) => {
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hashAt = target.indexOf('#');
      const rel = hashAt === -1 ? target : target.slice(0, hashAt);
      const frag = hashAt === -1 ? '' : target.slice(hashAt);
      const resolved = rel === '' ? null : resolveLinkPath(dir, rel);
      if (resolved !== null && state.byPath.has(resolved)) return `${state.byPath.get(resolved).url}${frag}`;
      if (resolved !== null && staticPaths.has(resolved)) return `${base}/${resolved}${frag}`;
      state.broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const renderedMd = renderBody(s.body, linkOf);
    s.html = renderedMd.html;
    s.toc = renderedMd.toc;
    s.excerpt = renderedMd.excerpt;
  }

  // 5. The post collection: newest first, equal dates by slug.
  const posts = state.sources.filter((s) => s.post);
  posts.sort((x, y) => cmpCodeUnits(y.data.date, x.data.date) || cmpCodeUnits(x.slug, y.slug));
  state.posts = posts;
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. Tags grouped by slug, named as first met in collection order.
  // Each tag name's slug is computed once here (NFKD normalisation is the
  // expensive part) and carried along as a { name, slug } pair.
  const ownTags = (s) => {
    const seenSlugs = new Set();
    const pairs = [];
    for (const name of s.data.tags ?? []) {
      const slug = makeSlug(name);
      if (seenSlugs.has(slug)) continue;
      seenSlugs.add(slug);
      pairs.push({ name, slug });
    }
    return pairs;
  };
  const tagsBySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const { name, slug } of ownTags(p)) {
      if (!tagsBySlug.has(slug)) tagsBySlug.set(slug, { name, slug, url: `${base}/tags/${slug}/`, posts: [] });
      const tag = tagsBySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of state.sources) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map(({ name, slug }) => tagsBySlug.get(slug) ?? { name, slug, url: '', posts: [] });
    }
  }
  state.tagList = [...tagsBySlug.values()].sort((x, y) => y.posts.length - x.posts.length || cmpCodeUnits(x.slug, y.slug));

  // Cards and page views, as templates read them.
  const linkView = (s) => (s === null ? null : {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longFormDate(s.data.date),
  });
  const cardView = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longFormDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(countWords(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  // A source's card is built once per case and shared by the page view, the
  // index pages, the tag pages and the recent list that all read it. It is
  // memoised on the source object itself, not in a side Map.
  const cardOf = (s) => {
    if (s._card === undefined) s._card = cardView(s);
    return s._card;
  };
  const pageView = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc,
    newer: linkView(s.newer ?? null),
    older: linkView(s.older ?? null),
    is_post: s.post,
  });

  // 7. Layouts: pages, index pages, tag pages, the tags index, then statics.
  posts.forEach((p) => cardOf(p));
  const siteView = { title: input.site.title, base_url: base };
  const allTagsView = state.tagList.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recentView = posts.slice(0, input.site.recent).map((p) => cardOf(p));
  const baseVars = { site: siteView, tags: allTagsView, recent: recentView };
  const renderNamed = (name, vars) => {
    const nodes = compiled.get(name);
    if (nodes === undefined) return null;
    // A template that is one static text node renders to that text as-is.
    if (nodes.length === 1 && nodes[0].kind === 'text') return nodes[0].text;
    const parts = [];
    renderTree(nodes, [baseVars, vars], compiled, 0, parts);
    return parts.join('');
  };
  for (const s of state.sources) state.output[`${s.outDir}/index.html`] = renderNamed(s.layout, { page: pageView(s) });
  const perPage = input.site.per_page;
  const indexCount = Math.max(1, Math.ceil(posts.length / perPage));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= indexCount; k++) {
    const html = renderNamed('index', {
      posts: posts.slice((k - 1) * perPage, k * perPage).map((p) => cardOf(p)),
      pager: {
        number: k,
        total: indexCount,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === indexCount ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) state.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of state.tagList) {
    const tagView = { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cardOf(p)) };
    const html = renderNamed('tag', { tag: tagView });
    if (html !== null) state.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsIndexHtml = renderNamed('tags', {});
  if (tagsIndexHtml !== null) state.output['tags/index.html'] = tagsIndexHtml;
  for (const f of state.statics) {
    if (Object.hasOwn(state.output, f.path)) notes.push(`shadowed ${f.path}: a built page has its path`);
    else state.output[f.path] = f.content;
  }

  // 8. The report: all noted lines and broken links, sorted, then the counts line.
  const reportLines = [...notes, ...state.broken].sort(cmpCodeUnits);
  const pageCount = state.sources.filter((s) => !s.post).length;
  reportLines.push(`built ${pageCount} pages, ${posts.length} posts, ${state.tagList.length} tags and ${state.statics.length} static files`);
  state.output[REPORT_NAME] = `${reportLines.join('\n')}\n`;

  return state.output;
}

/** The pure-JS build, kept as the fallback when the native engine is absent. */
function jsRun(input) {
  return buildSite(input);
}

// ---------------------------------------------------------------- native engine
// The same build implemented in C (engine.node, an N-API addon next to this
// file): one renderCase call per case, the whole build on the native side.
// Loaded when present; a load failure, or any error from the addon, leaves
// the JS build above in charge, so the entry answers identically anywhere.
const requireNative = createRequire(import.meta.url);
let nativeEngine = null;
try {
  nativeEngine = requireNative('./engine.node');
  if (!nativeEngine || typeof nativeEngine.renderCase !== 'function') nativeEngine = null;
} catch {
  nativeEngine = null;
}
const slugCore = (s) => s.normalize('NFKD').replace(/\p{M}/gu, '');

/** Whether the native engine loaded (the JS build answers when it did not). */
export const nativeActive = nativeEngine !== null;

/** The entry's answer for one case's input. */
export function run(input) {
  if (nativeEngine !== null) {
    try {
      return nativeEngine.renderCase(input, slugCore);
    } catch {
      // fall through to the JS build
    }
  }
  return jsRun(input);
}
