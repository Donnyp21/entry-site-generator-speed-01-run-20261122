// Fast drop-in for makefun-site 1.0.0 (make.fun's own static site generator).
//
// Returns exactly makefun-site's answer for every input: the output tree
// (each page's index.html, index and tag pages, build-report.txt, each static
// file) as path -> text, byte for byte. Reimplements its pipeline faithfully
// (front matter, template dialect, Markdown subset, slug rule, report) with
// the reference code as the authority wherever the README and the code differ.
//
// Speed comes from removing the reference's per-item overhead, not from
// changing any answer:
//   - templates are compiled once per case to JS functions (via new Function)
//     with loop variables as locals and scope lookups resolved at compile
//     time where the binding is lexical; includes call the compiled function
//     of the included template in the same runtime scope stack;
//   - Markdown is lexed and rendered in one fused pass with char-code block
//     classification and a regex-driven inline scanner that only touches
//     special characters;
//   - slugify results and link resolutions are cached per case (titles,
//     headings and tag names repeat heavily; link targets repeat too);
//   - front matter is parsed with one scan for the closing fence instead of
//     splitting the whole file twice;
//   - output is built in arrays and joined once, never with += in a loop.
//
// No dependency, no I/O, no clock, no randomness: the output is a function
// of the input alone, exactly as makefun-site's is.

const RESERVED = ['posts', 'tags', 'page'];
const REPORT_FILE = 'build-report.txt';

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- text

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped (V8's replace beats a per-char loop here). */
function escapeHtml(s) {
  return s.replace(ESC_RE, (c) => ESC[c]);
}

const SLUG_MAX = 64;

/** The slug of `text`, exactly as the reference computes it. */
function slugifySlow(text) {
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 128) { ascii = false; break; }
  }
  // NFKD is the identity on pure ASCII, and ASCII holds no combining marks.
  const plain = ascii ? text : text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** Exactly JavaScript's \s: WhiteSpace + LineTerminator code units. */
function isWS(cc) {
  return cc === 32 || cc === 9 || cc === 10 || cc === 11 || cc === 12 || cc === 13 ||
    cc === 0xa0 || cc === 0x1680 || (cc >= 0x2000 && cc <= 0x200a) || cc === 0x2028 ||
    cc === 0x2029 || cc === 0x202f || cc === 0x205f || cc === 0x3000 || cc === 0xfeff;
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (isWS(text.charCodeAt(i))) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

/** `rel` from the directory `dir` of a source, or null when it climbs out. */
function resolvePath(dir, rel) {
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

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** Whether `target` opens with a scheme: /^[A-Za-z][A-Za-z0-9+.-]*:/ . */
function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function isDigit(cc) { return cc >= 48 && cc <= 57; }

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function isName(raw) {
  if (raw.length === 0) return false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return true;
}

function isSlugValue(raw) {
  if (raw.length === 0 || raw.length > 64) return false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
    if (c === 45 && (i === 0 || i === raw.length - 1 || raw.charCodeAt(i - 1) === 45)) return false;
  }
  return true;
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          if (!isDigit(raw.charCodeAt(i))) { ok = false; break; }
        }
      }
      const y = ok ? Number(raw.slice(0, 4)) : 0;
      const mo = ok ? Number(raw.slice(5, 7)) : 0;
      const d = ok ? Number(raw.slice(8, 10)) : 0;
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let i = 0; i < t.length; i++) {
          const c = t.charCodeAt(i);
          if (c === 34 || c === 91 || c === 93) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return isName(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return isSlugValue(raw) ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const cc = line.charCodeAt(i);
    if (cc !== 32 && cc !== 9) return false;
  }
  return true;
}

/**
 * A source's front matter and body: { data, body }, or { error }.
 * `text` has "\n" line ends. Finds the closing fence with one scan instead
 * of splitting the whole file, then parses only the front-matter lines.
 */
function parseFrontMatter(text) {
  if (text === '---') return { error: 'the front matter is not closed' };
  if (!text.startsWith('---\n')) return { error: 'no front matter' };
  let fmEnd;
  let bodyStart;
  const p = text.indexOf('\n---\n', 3);
  if (p !== -1) { fmEnd = p; bodyStart = p + 5; }
  else if (text.endsWith('\n---')) { fmEnd = text.length - 4; bodyStart = text.length; }
  else return { error: 'the front matter is not closed' };
  const fmText = text.slice(4, fmEnd);
  const lines = fmText === '' ? [] : fmText.split('\n');
  const data = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isBlankLine(line) || line.charCodeAt(0) === 35) continue; // blank or '#...'
    const c = line.indexOf(':');
    if (c === -1) return { error: `line ${i + 2} is not "key: value"` };
    const key = line.slice(0, c);
    let keyOk = key.length > 0;
    if (keyOk) {
      for (let k = 0; k < key.length; k++) {
        const cc = key.charCodeAt(k);
        if (!((cc >= 97 && cc <= 122) || cc === 95)) { keyOk = false; break; }
      }
    }
    let raw;
    if (!keyOk) return { error: `line ${i + 2} is not "key: value"` };
    if (c + 1 === line.length) raw = '';
    else if (line.charCodeAt(c + 1) === 32) raw = line.slice(c + 2);
    else return { error: `line ${i + 2} is not "key: value"` };
    // Trailing spaces and tabs dropped.
    let e = raw.length;
    while (e > 0 && (raw.charCodeAt(e - 1) === 32 || raw.charCodeAt(e - 1) === 9)) e--;
    if (e !== raw.length) raw = raw.slice(0, e);
    if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- templates

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lk(S, name) {
  for (let i = S.length - 1; i >= 0; i--) {
    const v = S[i];
    if (Object.hasOwn(v, name)) return v[name];
  }
  return undefined;
}

function pv(v, k) {
  return v !== null && typeof v === 'object' && Object.hasOwn(v, k) ? v[k] : undefined;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * Compile a parsed template into a function(S, T, D, lk, pv, hv, esc, textOf, truthy, M, memoGet, memoSet)
 * returning its rendered string. S is the scope stack (root vars at [0], loop
 * scopes pushed on top); T maps template names to their compiled functions;
 * D is the include depth; M is the per-case include memo. Output accumulates
 * in one string (_s += ...), which beats an array + join for this append-heavy code.
 * A path's first name bound by a loop in this same template becomes a JS
 * local; a root name (site, tags, recent, page, posts, pager, tag — never a
 * loop variable in this generator's templates) reads straight from S[0];
 * anything else is resolved through the runtime scope stack, exactly as the
 * reference's lookup does (nearest scope first, then own properties).
 */
const ROOT_NAMES = new Set(['site', 'tags', 'recent', 'page', 'posts', 'pager', 'tag']);

/** The root values, identical for every render in a case: memoizing a template that reads only these is one render. */
const STABLE_ROOTS = new Set(['site', 'tags', 'recent']);

/**
 * A template's direct free reads: the first segments its own nodes look up
 * outside its own loops, and the names it includes directly. A name bound by
 * an enclosing loop inside this template is not free (its value derives from
 * the loop's iterable, which is read free).
 */
function directReads(nodes) {
  const reads = new Set();
  const includes = [];
  function walk(ns, bound) {
    for (const n of ns) {
      if (n.kind === 'var' || n.kind === 'raw' || n.kind === 'if' || n.kind === 'for') {
        if (!bound.has(n.path[0])) reads.add(n.path[0]);
      }
      if (n.kind === 'for') {
        const b2 = new Set(bound);
        b2.add(n.name);
        b2.add('loop');
        walk(n.body, b2);
      } else if (n.kind === 'if') {
        walk(n.then, bound);
        if (n.else !== null) walk(n.else, bound);
      } else if (n.kind === 'include') includes.push(n.name);
    }
  }
  walk(nodes, new Set());
  return { reads, includes };
}

/**
 * Every first segment a template may look up in the scope it is rendered in:
 * its direct free reads plus those of every template it includes, transitively.
 * Site-independent (a name bound by a loop at an include site resolves there,
 * so it belongs in the key), hence a pure function of the template graph.
 */
function computeReads(name, asts, cache) {
  const hit = cache.get(name);
  if (hit !== undefined) return hit;
  const out = new Set();
  const stack = [name];
  const seen = new Set([name]);
  while (stack.length > 0) {
    const cur = stack.pop();
    const nodes = asts.get(cur);
    if (nodes === undefined) continue;
    const { reads, includes } = directReads(nodes);
    for (const r of reads) out.add(r);
    for (const inc of includes) {
      if (!seen.has(inc)) { seen.add(inc); stack.push(inc); }
    }
  }
  const arr = [...out];
  cache.set(name, arr);
  return arr;
}

/** The names included from inside a `for` body anywhere in `asts`. */
function includedInLoop(asts) {
  const out = new Set();
  function walk(ns, inLoop) {
    for (const n of ns) {
      if (n.kind === 'include' && inLoop) out.add(n.name);
      else if (n.kind === 'for') walk(n.body, true);
      else if (n.kind === 'if') {
        walk(n.then, inLoop);
        if (n.else !== null) walk(n.else, inLoop);
      }
    }
  }
  for (const nodes of asts.values()) walk(nodes, false);
  return out;
}

/**
 * The per-case include memo, a trie keyed by [template, depth, ...values]:
 * `memoGet` returns the stored string or undefined on a miss. Values are
 * compared by Map identity (objects) or value (strings, numbers, booleans),
 * which is exact here: a template's render is a pure function of the values
 * its reads resolve to, and no value it reads is ever mutated mid-build.
 */
function memoGet(M, name, parts) {
  let node = M.get(name);
  if (node === undefined) return undefined;
  for (let k = 0; k < parts.length; k++) {
    node = node.get(parts[k]);
    if (node === undefined) return undefined;
  }
  return node;
}

function memoSet(M, name, parts, str) {
  let node = M.get(name);
  if (node === undefined) { node = new Map(); M.set(name, node); }
  for (let k = 0; k < parts.length - 1; k++) {
    let child = node.get(parts[k]);
    if (child === undefined) { child = new Map(); node.set(parts[k], child); }
    node = child;
  }
  node.set(parts[parts.length - 1], str);
}

function hv(v, k) {
  return Object.hasOwn(v, k) ? v[k] : undefined;
}

/** Whether `nodes` hold an include at any depth (their render needs the scope pushed). */
function bodyHasInclude(nodes) {
  for (const n of nodes) {
    if (n.kind === 'include') return true;
    if (n.kind === 'for' && bodyHasInclude(n.body)) return true;
    if (n.kind === 'if' && (bodyHasInclude(n.then) || (n.else !== null && bodyHasInclude(n.else)))) return true;
  }
  return false;
}

/** Whether `nodes` read `loop` at any depth (their loop object must be built). */
function bodyUsesLoop(nodes) {
  for (const n of nodes) {
    if ((n.kind === 'var' || n.kind === 'raw' || n.kind === 'if' || n.kind === 'for') && n.path[0] === 'loop') return true;
    if (n.kind === 'for' && bodyUsesLoop(n.body)) return true;
    if (n.kind === 'if' && (bodyUsesLoop(n.then) || (n.else !== null && bodyUsesLoop(n.else)))) return true;
  }
  return false;
}

/**
 * `meta` maps every template name to { reads, memoize }: the names it may
 * look up in its render scope, and whether its includes are memoized (its
 * reads are only the per-case stable roots, or it is included from a loop,
 * so the same inputs recur).
 */
/**
 * `rootFast` is true only when no loop variable anywhere in this case's
 * templates is named a root name: then a root name can never be bound by an
 * ancestor loop, so reading it straight from S[0] is exact. Otherwise every
 * name resolves through the scope stack, exactly as the reference does.
 */
function compileTemplate(nodes, meta, rootFast) {
  let uid = 0;
  const lines = ['let _s=\'\';'];
  function findBinding(scope, name) {
    for (let i = scope.length - 1; i >= 0; i--) {
      const s = scope[i];
      if (name === 'loop') return s.loopLocal;
      if (s.name === name) return s.local;
    }
    return null;
  }
  function expr(path, scope) {
    const b = findBinding(scope, path[0]);
    let e;
    if (b !== null) e = b;
    else if (rootFast && ROOT_NAMES.has(path[0])) e = `hv(S[0],${JSON.stringify(path[0])})`;
    else e = `lk(S,${JSON.stringify(path[0])})`;
    for (let k = 1; k < path.length; k++) e = `pv(${e},${JSON.stringify(path[k])})`;
    return e;
  }
  function gen(ns, scope) {
    for (const n of ns) {
      if (n.kind === 'text') lines.push(`_s+=${JSON.stringify(n.text)};`);
      else if (n.kind === 'var') lines.push(`_s+=esc(textOf(${expr(n.path, scope)}));`);
      else if (n.kind === 'raw') lines.push(`_s+=textOf(${expr(n.path, scope)});`);
      else if (n.kind === 'if') {
        lines.push(`if(truthy(${expr(n.path, scope)})${n.not ? '===false' : '!==false'}){`);
        gen(n.then, scope);
        if (n.else !== null) { lines.push('}else{'); gen(n.else, scope); }
        lines.push('}');
      } else if (n.kind === 'for') {
        const a = `_a${uid}`;
        const ii = `_i${uid}`;
        const x = `_x${uid}`;
        const l = `_l${uid}`;
        uid++;
        // The loop's scope object is only pushed when the body can include
        // another template (only an included template reads the runtime
        // scope); the loop object itself is only built when the body (or an
        // include in it) can read `loop`.
        const needsPush = bodyHasInclude(n.body);
        const needsLoop = needsPush || bodyUsesLoop(n.body);
        lines.push(`{const ${a}=${expr(n.path, scope)};if(Array.isArray(${a})){for(let ${ii}=0;${ii}<${a}.length;${ii}++){const ${x}=${a}[${ii}];${needsLoop ? `const ${l}={index:${ii}+1,first:${ii}===0,last:${ii}===${a}.length-1,length:${a}.length};` : ''}${needsPush ? `S.push({${JSON.stringify(n.name)}:${x},loop:${l}});` : ''}`);
        gen(n.body, scope.concat([{ name: n.name, local: x, loopLocal: l }]));
        // Three closes (for, if, block); the first } ends the ${} interpolation.
        lines.push(`${needsPush ? 'S.pop();' : ''}}}}`);
      } else if (n.kind === 'include') {
        const info = meta.get(n.name);
        const call = `_f(S,T,D+1,lk,pv,hv,esc,textOf,truthy,M,memoGet,memoSet)`;
        if (info !== undefined && info.memoize) {
          // Memoized: the render depends only on the depth and the values its
          // reads resolve to here, so those are the key. A miss renders,
          // stores and appends; a hit appends the stored string.
          const keyParts = ['D', ...info.reads.map((r) => expr([r], scope))].join(',');
          lines.push(`if(D<8){const _f=T[${JSON.stringify(n.name)}];if(_f!==undefined){const _vv=[${keyParts}];const _mm=memoGet(M,${JSON.stringify(n.name)},_vv);if(_mm!==undefined)_s+=_mm;else{const _rr=${call};memoSet(M,${JSON.stringify(n.name)},_vv,_rr);_s+=_rr;}}}`);
        } else {
          lines.push(`if(D<8){const _f=T[${JSON.stringify(n.name)}];if(_f!==undefined)_s+=${call};}`);
        }
      }
    }
  }
  gen(nodes, []);
  lines.push('return _s;');
  return new Function('S', 'T', 'D', 'lk', 'pv', 'hv', 'esc', 'textOf', 'truthy', 'M', 'memoGet', 'memoSet', lines.join('\n'));
}

// ---------------------------------------------------------------- Markdown

const SPEC = /[\\`*\[&<>"']/g;
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

function isEscapable(c) { return ESCAPABLE.has(c); }

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
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

/**
 * `s` rendered inline; `link(target)` is a link's href. The shared SPEC
 * regex jumps straight to the next interesting character, so plain runs are
 * copied whole; its lastIndex is reset after every construct (recursive
 * calls reuse the same regex, so it is set explicitly, never left to drift).
 */
function inline(s, link) {
  let out = '';
  let i = 0;
  SPEC.lastIndex = 0;
  let m;
  while ((m = SPEC.exec(s)) !== null) {
    const j = m.index;
    if (j > i) out += s.slice(i, j);
    const c = s[j];
    if (c === '\\') {
      const nx = s[j + 1];
      if (nx !== undefined && ESCAPABLE.has(nx)) {
        out += escapeHtml(nx);
        i = j + 2;
      } else {
        out += '\\';
        i = j + 1;
      }
    } else if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        out += `<code>${escapeHtml(s.slice(j + 1, k))}</code>`;
        i = k + 1;
      } else {
        out += '`';
        i = j + 1;
      }
    } else if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          out += `<strong>${inline(s.slice(j + 2, k), link)}</strong>`;
          i = k + 2;
        } else {
          out += '**';
          i = j + 2;
        }
      } else {
        const k = findSingleStar(s, j + 1);
        if (k > j + 1) {
          out += `<em>${inline(s.slice(j + 1, k), link)}</em>`;
          i = k + 1;
        } else {
          out += '*';
          i = j + 1;
        }
      }
    } else if (c === '[') {
      const k = findUnescaped(s, ']', j + 1);
      const mm = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = mm === -1 ? '' : s.slice(k + 2, mm);
      if (target !== '' && !/\s/.test(target)) {
        out += `<a href="${escapeHtml(link(target))}">${inline(s.slice(j + 1, k), link)}</a>`;
        i = mm + 1;
      } else {
        out += '[';
        i = j + 1;
      }
    } else {
      out += ESC[c];
      i = j + 1;
    }
    SPEC.lastIndex = i;
  }
  if (i < s.length) out += s.slice(i);
  return out;
}

function trimST(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** A fence-open line's language, or null when the line is not one. */
function fenceOpen(line) {
  if (!line.startsWith('```')) return null;
  let k = 3;
  const n = line.length;
  while (k < n) {
    const cc = line.charCodeAt(k);
    if ((cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122) || (cc >= 48 && cc <= 57) || cc === 95 || cc === 43 || cc === 45) k++;
    else break;
  }
  const lang = line.slice(3, k);
  while (k < n) {
    const cc = line.charCodeAt(k);
    if (cc === 32 || cc === 9) k++;
    else return null;
  }
  return lang;
}

/** Whether `line` closes a fence: three backticks, spaces or tabs after. */
function isFenceClose(line) {
  if (!line.startsWith('```')) return false;
  for (let i = 3; i < line.length; i++) {
    const cc = line.charCodeAt(i);
    if (cc !== 32 && cc !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let k = 0;
  while (k < line.length && line.charCodeAt(k) === 35) k++;
  if (k === 0 || k > 6) return null;
  if (k >= line.length || (line.charCodeAt(k) !== 32 && line.charCodeAt(k) !== 9)) return null;
  let s = k;
  while (s < line.length && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
  let e = line.length;
  while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  if (e === s) return null;
  return { depth: k, text: line.slice(s, e) };
}

/** Whether `line` is a thematic break: `---` or `***`, spaces or tabs after. */
function isHR(line) {
  if (line.length < 3) return false;
  const c = line.charCodeAt(0);
  if (c !== 45 && c !== 42) return false;
  if (line.charCodeAt(1) !== c || line.charCodeAt(2) !== c) return false;
  for (let i = 3; i < line.length; i++) {
    const cc = line.charCodeAt(i);
    if (cc !== 32 && cc !== 9) return false;
  }
  return true;
}

/**
 * Whether `line` ends a paragraph: a blank line, a fence, a heading or a
 * thematic break. Dispatched on the first character: only a blank line can
 * start with a space or tab, only a fence with a backtick, only a heading
 * with '#', only a break with '-' or '*'.
 */
function endsParagraph(line) {
  if (line.length === 0) return true;
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) return isBlankLine(line);
  if (c0 === 96) return fenceOpen(line) !== null;
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return isHR(line);
  return false;
}

const CONTINUED = /^ {2,}\S/;

/** A list-start line, or null: { ordered, start, text } with the text trimmed. */
function listStart(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) return { ordered: false, start: 1, text: trimST(line.slice(2)) };
  let k = 0;
  while (k < line.length && line.charCodeAt(k) >= 48 && line.charCodeAt(k) <= 57) k++;
  if (k >= 1 && k <= 9 && line.charCodeAt(k) === 46 && line.charCodeAt(k + 1) === 32) {
    return { ordered: true, start: Number(line.slice(0, k)), text: trimST(line.slice(k + 2)) };
  }
  return null;
}

/** A following list-item line of the same kind, or null: its trimmed text. */
function listItem(line, ordered) {
  if (ordered) {
    let k = 0;
    while (k < line.length && line.charCodeAt(k) >= 48 && line.charCodeAt(k) <= 57) k++;
    if (k >= 1 && k <= 9 && line.charCodeAt(k) === 46 && line.charCodeAt(k + 1) === 32) return trimST(line.slice(k + 2));
    return null;
  }
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) return trimST(line.slice(2));
  return null;
}

/**
 * `src` rendered in one fused lex+render pass: its HTML (each block on its
 * own lines, a "\n" after the last), its table of contents (every level 2
 * and 3 heading) and its excerpt (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, link, slugify) {
  const lines = src.split('\n');
  const n = lines.length;
  const blocks = [];
  const toc = [];
  const ids = new Set();
  let excerpt = '';
  let excerptSet = false;
  let i = 0;
  /** A list starting at `ls`, rendered; advances `i` past its lines. */
  function takeList(ls) {
    const items = [[ls.text]];
    i++;
    while (i < n) {
      const l = lines[i];
      const it = listItem(l, ls.ordered);
      if (it !== null) { items.push([it]); i++; }
      else if (CONTINUED.test(l)) { items[items.length - 1].push(trimST(l)); i++; }
      else break;
    }
    const tag = ls.ordered ? 'ol' : 'ul';
    const open = ls.ordered && ls.start !== 1 ? `<ol start="${ls.start}">` : `<${tag}>`;
    let b = `${open}\n`;
    for (const parts of items) b += `<li>${inline(parts.join('\n'), link)}</li>\n`;
    b += `</${tag}>`;
    return b;
  }
  while (i < n) {
    const line = lines[i];
    // Dispatch on the first character, in the reference's block order: a
    // line can only be a fence, heading, break, quote or list when it opens
    // on that block's marker, and only a blank line opens on a space or tab.
    // Anything else falls through to the paragraph below.
    const c0 = line.length === 0 ? 0 : line.charCodeAt(0);
    if (c0 === 96) {
      const lang = fenceOpen(line);
      if (lang !== null) {
        const body = [];
        i++;
        while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
        i++;
        let b = '<pre><code';
        if (lang !== '') b += ` class="language-${escapeHtml(lang)}"`;
        b += '>';
        for (const l of body) { b += escapeHtml(l); b += '\n'; }
        b += '</code></pre>';
        blocks.push(b);
        continue;
      }
    } else if (c0 === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text), ids);
        const html = inline(heading.text, link);
        blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHR(line)) { blocks.push('<hr>'); i++; continue; }
      const ls0 = listStart(line);
      if (ls0 !== null) { blocks.push(takeList(ls0)); continue; }
    } else if (c0 === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.length > 1 && l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const kept = [];
      for (const l of body) {
        const t = trimST(l);
        if (t !== '') kept.push(t);
      }
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(kept.join('\n'), link)}</p>\n</blockquote>`);
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      const ls = listStart(line);
      if (ls !== null) { blocks.push(takeList(ls)); continue; }
    } else if (c0 === 0 || c0 === 32 || c0 === 9) {
      if (isBlankLine(line)) { i++; continue; }
    }
    const body = [trimST(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimST(lines[i++]));
    const html = inline(body.join('\n'), link);
    if (!excerptSet) { excerpt = html; excerptSet = true; }
    blocks.push(`<p>${html}</p>`);
  }
  // Each block followed by "\n": join puts "\n" between them, one more ends it.
  return { html: blocks.length === 0 ? '' : `${blocks.join('\n')}\n`, toc, excerpt };
}

// ---------------------------------------------------------------- the build

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** One site's output tree: path -> text. */
export function run(input) {
  // Per-case caches: slugify results and link resolutions repeat heavily.
  const slugCache = new Map();
  const slugify = (text) => {
    let v = slugCache.get(text);
    if (v === undefined) { v = slugifySlow(text); slugCache.set(text, v); }
    return v;
  };

  // Templates, parsed in code-unit order of name; one that does not parse
  // is reported and left out, as if it were not there.
  const templates = new Map();
  // The compiled functions index their includes as T["name"], so they get a
  // plain object (null-prototyped: a template could be named "__proto__").
  const tplObj = Object.create(null);
  const report = [];
  const asts = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      asts.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  // Include memoization, decided per template from its reads and from
  // whether it is ever included inside a loop: a template whose reads are
  // only the per-case stable roots renders once per case, and one included
  // from a loop renders once per element it is given.
  const readsCache = new Map();
  const inLoop = includedInLoop(asts);
  const meta = new Map();
  for (const name of asts.keys()) {
    const reads = computeReads(name, asts, readsCache);
    meta.set(name, { reads, memoize: reads.every((r) => STABLE_ROOTS.has(r)) || inLoop.has(name) });
  }
  // The root fast path is exact only when no loop variable in this case is
  // named a root name (a loop could otherwise shadow it from an include).
  let rootFast = true;
  for (const nodes of asts.values()) {
    const stack = [nodes];
    while (stack.length > 0) {
      for (const n of stack.pop()) {
        if (n.kind === 'for') {
          if (ROOT_NAMES.has(n.name)) rootFast = false;
          stack.push(n.body);
        } else if (n.kind === 'if') {
          stack.push(n.then);
          if (n.else !== null) stack.push(n.else);
        }
      }
    }
    if (!rootFast) break;
  }
  for (const [name, nodes] of asts) {
    const fn = compileTemplate(nodes, meta, rootFast);
    templates.set(name, fn);
    tplObj[name] = fn;
  }
  const memo = new Map();

  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. Sources, in code-unit order of path; a source that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter; refused sources and drafts are reported and dropped.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    for (const d of RESERVED) {
      if (d !== 'posts' && s.path.startsWith(`${d}/`)) { own = d; break; }
    }
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Permalinks: each page's directory, slug (unique in its directory, in
  // source order) and url.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) { set = new Set(dir === '' ? RESERVED : []); taken.set(dir, set); }
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown, each body's links resolved to the pages and static files.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  // Only successful resolutions are cached, keyed by directory + target:
  // a broken link is reported per source, so it must be recomputed (and
  // reported) for every source that holds it, never served from a cache.
  const linkCache = new Map();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (hasScheme(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
      const key = `${dir}\n${target}`;
      const hit = linkCache.get(key);
      if (hit !== undefined) return hit;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      let v;
      if (path !== null && bySource.has(path)) v = `${bySource.get(path).url}${frag}`;
      else if (path !== null && staticPaths.has(path)) v = `${base}/${path}${frag}`;
      else {
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      }
      linkCache.set(key, v);
      return v;
    };
    const md = renderMarkdown(s.body, link, slugify);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections: posts newest first, equal dates by slug; newer/older.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. Tags: grouped by slug, each named as first met in the posts' order,
  // ordered by count then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) { seen.add(slug); out.push(name); }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Layouts: every page through its layout, the index and tag pages.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  for (const s of kept) s.card = cardOf(s);
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => p.card);
  const output = {};
  const render = (name, vars) => {
    const fn = templates.get(name);
    if (fn === undefined) return null;
    return fn([{ site, tags: allTags, recent, ...vars }], tplObj, 0, lk, pv, hv, escapeHtml, textOf, truthy, memo, memoGet, memoSet);
  };
  const pageOf = (s) => ({
    ...s.card,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => p.card),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => p.card) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did
  // not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pagesCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pagesCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
