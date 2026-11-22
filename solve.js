// Fast drop-in implementation of makefun-site 1.0.0.
// Pure ES module with no external dependencies; each run(input) call is isolated with no cross-case caching.

const REPORT_FILE = 'build-report.txt';
const RESERVED = ['posts', 'tags', 'page'];
const SLUG_MAX = 64;
const INCLUDE_DEPTH = 8;

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const WS_ASCII = new Uint8Array(128);
WS_ASCII[9] = 1;
WS_ASCII[10] = 1;
WS_ASCII[11] = 1;
WS_ASCII[12] = 1;
WS_ASCII[13] = 1;
WS_ASCII[32] = 1;

const NON_WS = new Uint8Array(128);
NON_WS.fill(1);
NON_WS[9] = 0;
NON_WS[10] = 0;
NON_WS[11] = 0;
NON_WS[12] = 0;
NON_WS[13] = 0;
NON_WS[32] = 0;

// Special characters in renderInline: " & ' * < > [ \ `
const INLINE_SPECIAL = new Uint8Array(128);
INLINE_SPECIAL[34] = 1; // "
INLINE_SPECIAL[38] = 1; // &
INLINE_SPECIAL[39] = 1; // '
INLINE_SPECIAL[42] = 1; // *
INLINE_SPECIAL[60] = 1; // <
INLINE_SPECIAL[62] = 1; // >
INLINE_SPECIAL[91] = 1; // [
INLINE_SPECIAL[92] = 1; // \
INLINE_SPECIAL[96] = 1; // `

// Characters escapable by backslash: \ ` * _ [ ] ( ) # + - . ! >
const ESCAPABLE = new Uint8Array(128);
for (const ch of ['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']) {
  ESCAPABLE[ch.charCodeAt(0)] = 1;
}

// HTML escapable characters: & < > " '
const HTML_SPECIAL = new Uint8Array(128);
HTML_SPECIAL[34] = 1; // "
HTML_SPECIAL[38] = 1; // &
HTML_SPECIAL[39] = 1; // '
HTML_SPECIAL[60] = 1; // <
HTML_SPECIAL[62] = 1; // >

const SAFE_STR_PROPS = new Set(['date', 'date_long', 'slug']);
const SAFE_URL_PROPS = new Set(['url', 'newer_url', 'older_url']);
const NUM_PROPS = new Set(['reading_minutes', 'count', 'number', 'total']);

const PROTO_PROPS = new Set([
  'constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf',
  'propertyIsEnumerable', 'toLocaleString', '__proto__',
  'at', 'concat', 'copyWithin', 'entries', 'every', 'fill', 'filter', 'find',
  'findIndex', 'findLast', 'findLastIndex', 'flat', 'flatMap', 'forEach',
  'includes', 'indexOf', 'join', 'keys', 'lastIndexOf', 'map', 'pop', 'push',
  'reduce', 'reduceRight', 'reverse', 'shift', 'slice', 'some', 'sort',
  'splice', 'toReversed', 'toSorted', 'toSpliced', 'unshift', 'values', 'with',
]);

function byCodeUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function escapeHtmlRange(text, start, end) {
  let last = start;
  let out = '';
  for (let i = start; i < end; i++) {
    const c = text.charCodeAt(i);
    if (c < 128 && HTML_SPECIAL[c] !== 0) {
      if (last < i) out += text.slice(last, i);
      out += c === 38 ? '&amp;' : c === 60 ? '&lt;' : c === 62 ? '&gt;' : c === 34 ? '&quot;' : '&#39;';
      last = i + 1;
    }
  }
  if (last === start) return text.slice(start, end);
  if (last < end) out += text.slice(last, end);
  return out;
}

function escapeHtml(text) {
  const len = text.length;
  let last = 0;
  let out = '';
  for (let i = 0; i < len; i++) {
    const c = text.charCodeAt(i);
    if (c < 128 && HTML_SPECIAL[c] !== 0) {
      if (last < i) out += text.slice(last, i);
      out += c === 38 ? '&amp;' : c === 60 ? '&lt;' : c === 62 ? '&gt;' : c === 34 ? '&quot;' : '&#39;';
      last = i + 1;
    }
  }
  if (last === 0) return text;
  if (last < len) out += text.slice(last);
  return out;
}

function createSlugifier() {
  const cache = new Map();
  return function slugify(text) {
    const hit = cache.get(text);
    if (hit !== undefined) return hit;

    const len = text.length;
    let ascii = true;
    for (let i = 0; i < len; i++) {
      if (text.charCodeAt(i) >= 128) {
        ascii = false;
        break;
      }
    }
    const plain = ascii ? text : text.normalize('NFKD').replace(/\p{M}/gu, '');
    const plen = plain.length;
    let out = '';
    let gap = false;
    for (let i = 0; i < plen; i++) {
      let c = plain.charCodeAt(i);
      if (c >= 65 && c <= 90) c += 32;
      else if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57))) {
        if (out.length > 0) gap = true;
        continue;
      }
      if (gap) {
        if (out.length >= 63) break;
        out += '-';
        gap = false;
      } else if (out.length >= SLUG_MAX) {
        break;
      }
      out += String.fromCharCode(c);
    }
    const res = out === '' ? 'untitled' : out;
    cache.set(text, res);
    return res;
  };
}

function uniqueSlug(slug, taken) {
  if (!taken.has(slug)) {
    taken.add(slug);
    return slug;
  }
  for (let n = 2; ; n++) {
    const out = `${slug}-${n}`;
    if (!taken.has(out)) {
      taken.add(out);
      return out;
    }
  }
}

function longDate(date) {
  const m = (date.charCodeAt(5) - 48) * 10 + (date.charCodeAt(6) - 48);
  const d = (date.charCodeAt(8) - 48) * 10 + (date.charCodeAt(9) - 48);
  return `${d} ${MONTHS[m - 1]} ${date.slice(0, 4)}`;
}

function isUnicodeSpace(c) {
  return (
    c === 0x00a0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f ||
    c === 0x3000 || c === 0xfeff
  );
}

function countWords(text) {
  const len = text.length;
  let count = 0;
  let prevWs = 1;
  for (let i = 0; i < len; i++) {
    const c = text.charCodeAt(i);
    const nw = c < 128 ? NON_WS[c] : (isUnicodeSpace(c) ? 0 : 1);
    count += nw & prevWs;
    prevWs = nw ^ 1;
  }
  return count;
}

function dirOf(path) {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  let start = 0;
  const rlen = rel.length;
  while (start <= rlen) {
    const slash = rel.indexOf('/', start);
    const end = slash === -1 ? rlen : slash;
    const segLen = end - start;
    if (segLen === 0 || (segLen === 1 && rel.charCodeAt(start) === 46)) {
      // '' or '.'
    } else if (segLen === 2 && rel.charCodeAt(start) === 46 && rel.charCodeAt(start + 1) === 46) {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(rel.slice(start, end));
    }
    if (slash === -1) break;
    start = slash + 1;
  }
  return parts.join('/');
}

function hasUrlScheme(target) {
  const colon = target.indexOf(':');
  if (colon <= 0) return false;
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < colon; i++) {
    const c = target.charCodeAt(i);
    if (
      !((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)
    ) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------- Front Matter

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    const len = raw.length;
    if (len < 2 || raw.charCodeAt(len - 1) !== 34) {
      return { error: 'a quoted string is not closed' };
    }
    if (raw.indexOf('\\', 1) === -1 && raw.indexOf('"', 1) === len - 1) {
      return { value: raw.slice(1, len - 1) };
    }
    let out = '';
    for (let i = 1; i < len - 1; i++) {
      const c = raw.charCodeAt(i);
      if (c === 92) {
        const n = raw.charCodeAt(i + 1);
        if ((n !== 34 && n !== 92) || i + 1 === len - 1) {
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        }
        out += raw[i + 1];
        i++;
      } else if (c === 34) {
        return { error: 'a quoted string holds a stray quote' };
      } else {
        out += raw[i];
      }
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      if (raw.length !== 10 || raw.charCodeAt(4) !== 45 || raw.charCodeAt(7) !== 45) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      const m = DATE_RE.exec(raw);
      if (!m) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      const y = Number(m[1]);
      const mo = Number(m[2]);
      const d = Number(m[3]);
      if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      const len = raw.length;
      if (len < 2 || raw.charCodeAt(0) !== 91 || raw.charCodeAt(len - 1) !== 93) {
        return { error: 'key "tags": not a list [a, b]' };
      }
      const inner = raw.slice(1, len - 1);
      if (inner.trim() === '') return { value: [] };
      const parts = inner.split(',');
      const tags = new Array(parts.length);
      for (let i = 0; i < parts.length; i++) {
        const t = parts[i].trim();
        if (t === '' || !TAG_RE.test(t)) {
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
        tags[i] = t;
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return raw.length <= 64 && SLUG_RE.test(raw) ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

function parseFrontMatter(text) {
  const len = text.length;
  if (len < 3 || text.charCodeAt(0) !== 45 || text.charCodeAt(1) !== 45 || text.charCodeAt(2) !== 45) {
    return { error: 'no front matter' };
  }
  if (len === 3) return { error: 'the front matter is not closed' };
  if (text.charCodeAt(3) !== 10) return { error: 'no front matter' };

  let closeStart = -1;
  let closeEnd = -1;
  let scan = 4;
  while (scan <= len) {
    const nl = text.indexOf('\n', scan);
    const end = nl === -1 ? len : nl;
    if (end - scan === 3 && text.charCodeAt(scan) === 45 && text.charCodeAt(scan + 1) === 45 && text.charCodeAt(scan + 2) === 45) {
      closeStart = scan;
      closeEnd = nl === -1 ? len : nl + 1;
      break;
    }
    if (nl === -1) break;
    scan = nl + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };

  const data = {};
  let p = 4;
  let lineNum = 2;
  while (p < closeStart) {
    const end = text.indexOf('\n', p);
    const c0 = p < end ? text.charCodeAt(p) : -1;
    if (c0 === 35) {
      p = end + 1;
      lineNum++;
      continue;
    }
    if (c0 === -1 || c0 === 32 || c0 === 9) {
      let onlyWs = true;
      for (let k = p; k < end; k++) {
        const ch = text.charCodeAt(k);
        if (ch !== 32 && ch !== 9) {
          onlyWs = false;
          break;
        }
      }
      if (onlyWs) {
        p = end + 1;
        lineNum++;
        continue;
      }
    }

    let kEnd = p;
    while (kEnd < end) {
      const ch = text.charCodeAt(kEnd);
      if ((ch >= 97 && ch <= 122) || ch === 95) kEnd++;
      else break;
    }
    if (kEnd === p || kEnd >= end || text.charCodeAt(kEnd) !== 58) {
      return { error: `line ${lineNum} is not "key: value"` };
    }
    let raw = '';
    if (kEnd + 1 < end) {
      if (text.charCodeAt(kEnd + 1) !== 32) {
        return { error: `line ${lineNum} is not "key: value"` };
      }
      let rEnd = end;
      while (rEnd > kEnd + 2) {
        const ch = text.charCodeAt(rEnd - 1);
        if (ch === 32 || ch === 9) rEnd--;
        else break;
      }
      raw = text.slice(kEnd + 2, rEnd);
    }

    const key = text.slice(p, kEnd);
    if (
      key !== 'title' && key !== 'date' && key !== 'tags' &&
      key !== 'draft' && key !== 'layout' && key !== 'slug' && key !== 'summary'
    ) {
      return { error: `unknown key "${key}"` };
    }
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;

    p = end + 1;
    lineNum++;
  }

  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeEnd) };
}

// ---------------------------------------------------------------- Markdown

function renderInline(s, from, to, env) {
  let out = '';
  let plainStart = from;
  let i = from;
  while (i < to) {
    const c = s.charCodeAt(i);
    if (c >= 128 || INLINE_SPECIAL[c] === 0) {
      i++;
      continue;
    }
    if (c === 92) {
      if (i + 1 < to) {
        const next = s.charCodeAt(i + 1);
        if (next < 128 && ESCAPABLE[next] !== 0) {
          if (plainStart < i) out += s.slice(plainStart, i);
          out += next === 62 ? '&gt;' : s[i + 1];
          i += 2;
          plainStart = i;
          continue;
        }
      }
      i++;
      continue;
    }
    if (c === 96) {
      let j = -1;
      let clean = true;
      for (let x = i + 1; x < to; x++) {
        const ch = s.charCodeAt(x);
        if (ch === 96) {
          j = x;
          break;
        }
        if (ch < 128 && HTML_SPECIAL[ch] !== 0) clean = false;
      }
      if (j > i + 1) {
        if (plainStart < i) out += s.slice(plainStart, i);
        out += '<code>' + (clean ? s.slice(i + 1, j) : escapeHtmlRange(s, i + 1, j)) + '</code>';
        i = j + 1;
        plainStart = i;
      } else {
        i++;
      }
      continue;
    }
    if (c === 42) {
      if (i + 1 < to && s.charCodeAt(i + 1) === 42) {
        let j = -1;
        let clean = true;
        const limit = to - 2;
        for (let x = i + 2; x <= limit; x++) {
          const ch = s.charCodeAt(x);
          if (ch < 128 && INLINE_SPECIAL[ch] !== 0) {
            if (ch === 42 && s.charCodeAt(x + 1) === 42) {
              j = x;
              break;
            }
            clean = false;
            if (ch === 92 && x + 1 < to) {
              const n = s.charCodeAt(x + 1);
              if (n < 128 && ESCAPABLE[n] !== 0) x++;
            }
          }
        }
        if (j > i + 2) {
          if (plainStart < i) out += s.slice(plainStart, i);
          out += '<strong>' + (clean ? s.slice(i + 2, j) : renderInline(s, i + 2, j, env)) + '</strong>';
          i = j + 2;
          plainStart = i;
        } else {
          i += 2;
        }
        continue;
      }
      let j = -1;
      let clean = true;
      for (let x = i + 1; x < to; x++) {
        const ch = s.charCodeAt(x);
        if (ch < 128 && INLINE_SPECIAL[ch] !== 0) {
          if (ch === 42) {
            if (x + 1 < to && s.charCodeAt(x + 1) === 42) {
              clean = false;
              x++;
              continue;
            }
            j = x;
            break;
          }
          clean = false;
          if (ch === 92 && x + 1 < to) {
            const n = s.charCodeAt(x + 1);
            if (n < 128 && ESCAPABLE[n] !== 0) x++;
          }
        }
      }
      if (j > i + 1) {
        if (plainStart < i) out += s.slice(plainStart, i);
        out += '<em>' + (clean ? s.slice(i + 1, j) : renderInline(s, i + 1, j, env)) + '</em>';
        i = j + 1;
        plainStart = i;
      } else {
        i++;
      }
      continue;
    }
    if (c === 91) {
      let k = -1;
      let cleanText = true;
      for (let x = i + 1; x < to; x++) {
        const ch = s.charCodeAt(x);
        if (ch < 128 && INLINE_SPECIAL[ch] !== 0) {
          cleanText = false;
          if (ch === 92 && x + 1 < to) {
            const n = s.charCodeAt(x + 1);
            if (n < 128 && ESCAPABLE[n] !== 0) {
              x++;
              continue;
            }
          }
        }
        if (ch === 93) {
          k = x;
          break;
        }
      }
      if (k !== -1 && k + 1 < to && s.charCodeAt(k + 1) === 40) {
        let m = -1;
        let hasWs = false;
        for (let x = k + 2; x < to; x++) {
          const ch = s.charCodeAt(x);
          if (ch === 41) {
            m = x;
            break;
          }
          if (ch < 128 ? WS_ASCII[ch] !== 0 : isUnicodeSpace(ch)) {
            hasWs = true;
            break;
          }
        }
        if (m > k + 2 && !hasWs) {
          if (plainStart < i) out += s.slice(plainStart, i);
          const target = s.slice(k + 2, m);
          out += '<a href="' + env.escapedLink(target) + '">' + (cleanText ? s.slice(i + 1, k) : renderInline(s, i + 1, k, env)) + '</a>';
          i = m + 1;
          plainStart = i;
          continue;
        }
      }
      i++;
      continue;
    }
    if (plainStart < i) out += s.slice(plainStart, i);
    out += c === 38 ? '&amp;' : c === 60 ? '&lt;' : c === 62 ? '&gt;' : c === 34 ? '&quot;' : '&#39;';
    i++;
    plainStart = i;
  }
  if (plainStart === from) return s.slice(from, to);
  if (plainStart < to) out += s.slice(plainStart, to);
  return out;
}

function trimLineSlice(src, start, end) {
  while (start < end) {
    const c = src.charCodeAt(start);
    if (c === 32 || c === 9) start++;
    else break;
  }
  while (end > start) {
    const c = src.charCodeAt(end - 1);
    if (c === 32 || c === 9) end--;
    else break;
  }
  return src.slice(start, end);
}

function isBlankRange(src, start, end) {
  for (let i = start; i < end; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function parseFenceOpen(src, start, end) {
  if (end - start < 3 || src.charCodeAt(start) !== 96 || src.charCodeAt(start + 1) !== 96 || src.charCodeAt(start + 2) !== 96) {
    return null;
  }
  let p = start + 3;
  while (p < end) {
    const c = src.charCodeAt(p);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) {
      p++;
    } else break;
  }
  const langEnd = p;
  while (p < end) {
    const c = src.charCodeAt(p);
    if (c !== 32 && c !== 9) return null;
    p++;
  }
  return src.slice(start + 3, langEnd);
}

function isFenceClose(src, start, end) {
  if (end - start < 3 || src.charCodeAt(start) !== 96 || src.charCodeAt(start + 1) !== 96 || src.charCodeAt(start + 2) !== 96) {
    return false;
  }
  for (let p = start + 3; p < end; p++) {
    const c = src.charCodeAt(p);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

let _hDepth = 0;
let _hStart = 0;
let _hEnd = 0;
function matchHeading(src, start, end) {
  if (start >= end || src.charCodeAt(start) !== 35) return false;
  let depth = 1;
  while (depth <= 6 && start + depth < end && src.charCodeAt(start + depth) === 35) depth++;
  if (depth > 6) return false;
  let p = start + depth;
  if (p >= end) return false;
  const firstWs = src.charCodeAt(p);
  if (firstWs !== 32 && firstWs !== 9) return false;
  while (p < end) {
    const c = src.charCodeAt(p);
    if (c === 32 || c === 9) p++;
    else break;
  }
  let tEnd = end;
  while (tEnd > p) {
    const c = src.charCodeAt(tEnd - 1);
    if (c === 32 || c === 9) tEnd--;
    else break;
  }
  if (tEnd <= p) return false;
  _hDepth = depth;
  _hStart = p;
  _hEnd = tEnd;
  return true;
}

function isHr(src, start, end) {
  if (end - start < 3) return false;
  const c = src.charCodeAt(start);
  if (c !== 45 && c !== 42) return false;
  if (src.charCodeAt(start + 1) !== c || src.charCodeAt(start + 2) !== c) return false;
  for (let p = start + 3; p < end; p++) {
    const ch = src.charCodeAt(p);
    if (ch !== 32 && ch !== 9) return false;
  }
  return true;
}

function isContinued(src, start, end) {
  if (end - start < 3 || src.charCodeAt(start) !== 32 || src.charCodeAt(start + 1) !== 32) return false;
  let p = start + 2;
  while (p < end && src.charCodeAt(p) === 32) p++;
  if (p >= end) return false;
  const c = src.charCodeAt(p);
  return !(c < 128 ? WS_ASCII[c] !== 0 : isUnicodeSpace(c));
}

function matchOrdered(src, start, end) {
  let p = start;
  const maxD = Math.min(end, start + 9);
  while (p < maxD) {
    const c = src.charCodeAt(p);
    if (c >= 48 && c <= 57) p++;
    else break;
  }
  if (p === start || p + 1 >= end) return -1;
  if (src.charCodeAt(p) !== 46 || src.charCodeAt(p + 1) !== 32) return -1;
  return p + 2;
}

function renderMarkdown(src, env, slugify) {
  const len = src.length;
  const ids = new Set();
  const toc = [];
  let excerpt = null;
  const blocks = [];

  let pos = 0;
  while (pos < len) {
    const nl = src.indexOf('\n', pos);
    const end = nl === -1 ? len : nl;

    if (pos === end) {
      pos = nl === -1 ? len : nl + 1;
      continue;
    }

    const c0 = src.charCodeAt(pos);
    if ((c0 === 32 || c0 === 9) && isBlankRange(src, pos, end)) {
      pos = nl === -1 ? len : nl + 1;
      continue;
    }

    // Fence
    if (c0 === 96) {
      const lang = parseFenceOpen(src, pos, end);
      if (lang !== null) {
        const bodyStart = nl === -1 ? len + 1 : nl + 1;
        pos = bodyStart;
        let bodyEnd = bodyStart;
        let hasLines = false;
        let trailingNl = false;
        let closed = false;
        while (pos <= len) {
          if (pos === len) {
            if (len > 0 && src.charCodeAt(len - 1) === 10) {
              trailingNl = true;
            }
            pos = len + 1;
            break;
          }
          const fnl = src.indexOf('\n', pos);
          const fend = fnl === -1 ? len : fnl;
          if (src.charCodeAt(pos) === 96 && isFenceClose(src, pos, fend)) {
            pos = fnl === -1 ? len : fnl + 1;
            closed = true;
            break;
          }
          hasLines = true;
          bodyEnd = fend;
          pos = fnl === -1 ? len + 1 : fnl + 1;
        }
        if (closed && pos > len) pos = len;
        let bodyHtml = '';
        if (hasLines) {
          bodyHtml = escapeHtmlRange(src, bodyStart, bodyEnd) + '\n';
        }
        if (trailingNl) bodyHtml += '\n';
        const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
        blocks.push('<pre><code' + cls + '>' + bodyHtml + '</code></pre>\n');
        continue;
      }
    }

    // Heading
    if (c0 === 35 && matchHeading(src, pos, end)) {
      const depth = _hDepth;
      const hStart = _hStart;
      const hEnd = _hEnd;
      const id = uniqueSlug(slugify(src.slice(hStart, hEnd)), ids);
      const inlineHtml = renderInline(src, hStart, hEnd, env);
      blocks.push('<h' + depth + ' id="' + id + '">' + inlineHtml + '</h' + depth + '>\n');
      if (depth === 2 || depth === 3) {
        toc.push({ level: depth, id, html: inlineHtml });
      }
      pos = nl === -1 ? len : nl + 1;
      continue;
    }

    // HR
    if ((c0 === 45 || c0 === 42) && isHr(src, pos, end)) {
      blocks.push('<hr>\n');
      pos = nl === -1 ? len : nl + 1;
      continue;
    }

    // Blockquote
    if (c0 === 62) {
      const qLines = [];
      while (pos < len && src.charCodeAt(pos) === 62) {
        const qnl = src.indexOf('\n', pos);
        const qend = qnl === -1 ? len : qnl;
        let qStart = pos + 1;
        if (qStart < qend && src.charCodeAt(qStart) === 32) qStart++;
        const trimmed = trimLineSlice(src, qStart, qend);
        if (trimmed !== '') qLines.push(trimmed);
        pos = qnl === -1 ? len : qnl + 1;
      }
      if (qLines.length === 0) {
        blocks.push('<blockquote>\n</blockquote>\n');
      } else if (qLines.length === 1) {
        const q = qLines[0];
        blocks.push('<blockquote>\n<p>' + renderInline(q, 0, q.length, env) + '</p>\n</blockquote>\n');
      } else {
        const q = qLines.join('\n');
        blocks.push('<blockquote>\n<p>' + renderInline(q, 0, q.length, env) + '</p>\n</blockquote>\n');
      }
      continue;
    }

    // Bullet list
    if ((c0 === 45 || c0 === 42) && pos + 1 < end && src.charCodeAt(pos + 1) === 32) {
      let listHtml = '<ul>\n';
      let curItem = trimLineSlice(src, pos + 2, end);
      pos = nl === -1 ? len : nl + 1;
      while (pos < len) {
        const lnl = src.indexOf('\n', pos);
        const lend = lnl === -1 ? len : lnl;
        const lc0 = pos < lend ? src.charCodeAt(pos) : -1;
        if ((lc0 === 45 || lc0 === 42) && pos + 1 < lend && src.charCodeAt(pos + 1) === 32) {
          listHtml += '<li>' + renderInline(curItem, 0, curItem.length, env) + '</li>\n';
          curItem = trimLineSlice(src, pos + 2, lend);
          pos = lnl === -1 ? len : lnl + 1;
        } else if (lc0 === 32 && isContinued(src, pos, lend)) {
          curItem += '\n' + trimLineSlice(src, pos, lend);
          pos = lnl === -1 ? len : lnl + 1;
        } else {
          break;
        }
      }
      listHtml += '<li>' + renderInline(curItem, 0, curItem.length, env) + '</li>\n</ul>\n';
      blocks.push(listHtml);
      continue;
    }

    // Ordered list
    if (c0 >= 48 && c0 <= 57) {
      const oStart = matchOrdered(src, pos, end);
      if (oStart !== -1) {
        const startNum = Number(src.slice(pos, oStart - 2));
        let listHtml = startNum !== 1 ? `<ol start="${startNum}">\n` : '<ol>\n';
        let curItem = trimLineSlice(src, oStart, end);
        pos = nl === -1 ? len : nl + 1;
        while (pos < len) {
          const lnl = src.indexOf('\n', pos);
          const lend = lnl === -1 ? len : lnl;
          const lc0 = pos < lend ? src.charCodeAt(pos) : -1;
          if (lc0 >= 48 && lc0 <= 57) {
            const mo = matchOrdered(src, pos, lend);
            if (mo !== -1) {
              listHtml += '<li>' + renderInline(curItem, 0, curItem.length, env) + '</li>\n';
              curItem = trimLineSlice(src, mo, lend);
              pos = lnl === -1 ? len : lnl + 1;
              continue;
            }
          }
          if (lc0 === 32 && isContinued(src, pos, lend)) {
            curItem += '\n' + trimLineSlice(src, pos, lend);
            pos = lnl === -1 ? len : lnl + 1;
          } else {
            break;
          }
        }
        listHtml += '<li>' + renderInline(curItem, 0, curItem.length, env) + '</li>\n</ol>\n';
        blocks.push(listHtml);
        continue;
      }
    }

    // Paragraph (contiguous zero-copy fast path when no line has leading/trailing [ \t])
    let pStart = pos;
    let pEnd = end;
    while (pStart < pEnd) {
      const ch = src.charCodeAt(pStart);
      if (ch === 32 || ch === 9) pStart++;
      else break;
    }
    while (pEnd > pStart) {
      const ch = src.charCodeAt(pEnd - 1);
      if (ch === 32 || ch === 9) pEnd--;
      else break;
    }
    const contigStart = pStart;
    let contigEnd = pEnd;
    let extraLines = null;
    const firstHadTrailing = pEnd < end;
    pos = nl === -1 ? len : nl + 1;

    while (pos < len) {
      const pnl = src.indexOf('\n', pos);
      const pend = pnl === -1 ? len : pnl;
      if (pos === pend) break;
      const pc0 = src.charCodeAt(pos);
      if ((pc0 === 32 || pc0 === 9) && isBlankRange(src, pos, pend)) break;
      if (pc0 === 96 && parseFenceOpen(src, pos, pend) !== null) break;
      if (pc0 === 35 && matchHeading(src, pos, pend)) break;
      if ((pc0 === 45 || pc0 === 42) && isHr(src, pos, pend)) break;

      const pcLast = src.charCodeAt(pend - 1);
      const needsTrim = pc0 === 32 || pc0 === 9 || pcLast === 32 || pcLast === 9;
      if (extraLines === null) {
        if (!firstHadTrailing && !needsTrim) {
          contigEnd = pend;
          pos = pnl === -1 ? len : pnl + 1;
          continue;
        }
        extraLines = [src.slice(contigStart, contigEnd)];
      }
      extraLines.push(needsTrim ? trimLineSlice(src, pos, pend) : src.slice(pos, pend));
      pos = pnl === -1 ? len : pnl + 1;
    }

    let inlineHtml;
    if (extraLines === null) {
      inlineHtml = renderInline(src, contigStart, contigEnd, env);
    } else {
      const pText = extraLines.join('\n');
      inlineHtml = renderInline(pText, 0, pText.length, env);
    }
    if (excerpt === null) excerpt = inlineHtml;
    blocks.push('<p>' + inlineHtml + '</p>\n');
  }

  return { html: blocks.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- Templates

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;
const BLANK_TAG_SIDE = /^[ \t]*$/;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenizeTemplate(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  const len = src.length;
  while (i < len) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === len - 1) {
      text += src.slice(i);
      break;
    }
    const next = src.charCodeAt(open + 1);
    if (next !== 123 && next !== 37) {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === 123) {
      const raw = src.charCodeAt(open + 2) === 123;
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
    const lineEnd = nl === -1 ? len : nl;
    const standalone = BLANK_TAG_SIDE.test(src.slice(lineStart, open)) && BLANK_TAG_SIDE.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? len : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  const tokens = tokenizeTemplate(name, src);
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
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
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) {
        body.push({ kind: 'include', name: m[1] });
      } else {
        throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
      }
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function collectFreeVars(nodes, bound, out, templatesMap, depth) {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.kind === 'var' || n.kind === 'raw') {
      const k = n.path[0];
      if (!bound.has(k)) out.add(k);
    } else if (n.kind === 'if') {
      const k = n.path[0];
      if (!bound.has(k)) out.add(k);
      collectFreeVars(n.then, bound, out, templatesMap, depth);
      if (n.else !== null) collectFreeVars(n.else, bound, out, templatesMap, depth);
    } else if (n.kind === 'for') {
      const k = n.path[0];
      if (!bound.has(k)) out.add(k);
      const hadName = bound.has(n.name);
      const hadLoop = bound.has('loop');
      bound.add(n.name);
      bound.add('loop');
      collectFreeVars(n.body, bound, out, templatesMap, depth);
      if (!hadName) bound.delete(n.name);
      if (!hadLoop) bound.delete('loop');
    } else if (n.kind === 'include' && depth < INCLUDE_DEPTH) {
      const inc = templatesMap.get(n.name);
      if (inc !== undefined) collectFreeVars(inc, bound, out, templatesMap, depth + 1);
    }
  }
}

function resolveStaticValue(obj, path, startIdx) {
  let v = obj;
  for (let i = startIdx; i < path.length; i++) {
    const seg = path[i];
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, seg)) return undefined;
    v = v[seg];
  }
  return v;
}

function createTemplateRunner(templatesMap, siteGlobals, baseSafe) {
  const compiled = new Map();
  const staticPartials = new Map();
  const cardCache = new Map();
  const freeVarsCache = new Map();

  function getFreeVars(name, depth) {
    const k = `${name}@${depth}`;
    let s = freeVarsCache.get(k);
    if (s === undefined) {
      s = new Set();
      const ast = templatesMap.get(name);
      if (ast !== undefined) collectFreeVars(ast, new Set(), s, templatesMap, depth);
      freeVarsCache.set(k, s);
    }
    return s;
  }

  function cardRender(p, incName, incDepth) {
    let byName = cardCache.get(incName);
    if (byName === undefined) {
      byName = new Map();
      cardCache.set(incName, byName);
    }
    let html = byName.get(p);
    if (html === undefined) {
      const subFn = compileEntry(incName, incDepth);
      html = subFn({ site: siteGlobals.site, tags: siteGlobals.tags, recent: siteGlobals.recent, p });
      byName.set(p, html);
    }
    return html;
  }

  function compileEntry(name, baseDepth = 0) {
    const cacheKey = baseDepth === 0 ? name : `${name}@${baseDepth}`;
    const cached = compiled.get(cacheKey);
    if (cached !== undefined) return cached;
    const ast = templatesMap.get(name);
    if (ast === undefined) return null;

    let tmpId = 0;
    const usedTmps = [];
    const trackedTmp = (p = '_t') => {
      const t = `${p}${tmpId++}`;
      usedTmps.push(t);
      return t;
    };
    const lines = ['const _o = [];'];

    function isShadowed(rootKey, bindings) {
      for (let i = bindings.length - 1; i >= 0; i--) {
        if (bindings[i].name === rootKey) return true;
      }
      return false;
    }

    function tryStaticSitePath(path, bindings) {
      const rootKey = path[0];
      if (rootKey !== 'site' || isShadowed('site', bindings)) return null;
      return { found: true, val: resolveStaticValue(siteGlobals.site, path, 1) };
    }

    function isSafeNoEscapePath(path) {
      if (path.length < 2) return false;
      const last = path[path.length - 1];
      if (SAFE_STR_PROPS.has(last) || NUM_PROPS.has(last)) return true;
      if (baseSafe && SAFE_URL_PROPS.has(last)) return true;
      return false;
    }

    function emitPath(path, bindings) {
      const rootKey = path[0];
      let baseExpr = null;
      for (let i = bindings.length - 1; i >= 0; i--) {
        const b = bindings[i];
        if (rootKey === 'loop') {
          if (path.length === 2) {
            const prop = path[1];
            if (prop === 'index') return `(${b.k} + 1)`;
            if (prop === 'first') return `(${b.k} === 0)`;
            if (prop === 'last') return `(${b.k} === ${b.len} - 1)`;
            if (prop === 'length') return b.len;
          }
          baseExpr = `({ index: ${b.k} + 1, first: ${b.k} === 0, last: ${b.k} === ${b.len} - 1, length: ${b.len} })`;
          break;
        }
        if (rootKey === b.name) {
          baseExpr = b.v;
          break;
        }
      }
      if (baseExpr === null) {
        baseExpr = PROTO_PROPS.has(rootKey)
          ? `(Object.hasOwn(_r, ${JSON.stringify(rootKey)}) ? _r[${JSON.stringify(rootKey)}] : undefined)`
          : `_r.${rootKey}`;
      }
      if (path.length === 1) return baseExpr;

      let cur = baseExpr;
      for (let i = 1; i < path.length; i++) {
        const seg = path[i];
        const tmp = trackedTmp();
        const propAccess = PROTO_PROPS.has(seg)
          ? `(Object.hasOwn(${tmp}, ${JSON.stringify(seg)}) ? ${tmp}[${JSON.stringify(seg)}] : undefined)`
          : `${tmp}.${seg}`;
        cur = `((${tmp} = ${cur}) !== null && typeof ${tmp} === "object" ? ${propAccess} : undefined)`;
      }
      return cur;
    }

    function isSiteOnlyInclude(incName, depth) {
      if (depth > INCLUDE_DEPTH || !templatesMap.has(incName)) return false;
      const free = getFreeVars(incName, depth);
      for (const k of free) {
        if (k !== 'site' && k !== 'tags' && k !== 'recent') return false;
      }
      return true;
    }

    function emitNodes(nodes, bindings, depth) {
      let textBuf = '';
      const exprParts = [];
      const flushConcat = () => {
        if (textBuf !== '') {
          exprParts.push(JSON.stringify(textBuf));
          textBuf = '';
        }
        if (exprParts.length > 0) {
          lines.push(`_o.push(${exprParts.join(' + ')});`);
          exprParts.length = 0;
        }
      };

      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        switch (n.kind) {
          case 'text':
            textBuf += n.text;
            break;
          case 'var':
          case 'raw': {
            const st = tryStaticSitePath(n.path, bindings);
            if (st !== null) {
              const s = textOf(st.val);
              textBuf += n.kind === 'var' ? escapeHtml(s) : s;
              break;
            }
            if (textBuf !== '') {
              exprParts.push(JSON.stringify(textBuf));
              textBuf = '';
            }
            const expr = emitPath(n.path, bindings);
            if (n.path[0] === 'loop' && n.path.length === 2 && bindings.length > 0 && (n.path[1] === 'index' || n.path[1] === 'length')) {
              exprParts.push(expr);
            } else {
              const tv = trackedTmp('_v');
              if (n.kind === 'raw' || isSafeNoEscapePath(n.path)) {
                exprParts.push(`(typeof (${tv} = ${expr}) === "string" ? ${tv} : _txt(${tv}))`);
              } else {
                exprParts.push(`(typeof (${tv} = ${expr}) === "string" ? _esc(${tv}) : _esc(_txt(${tv})))`);
              }
            }
            break;
          }
          case 'if': {
            const st = tryStaticSitePath(n.path, bindings);
            if (st !== null) {
              const v = st.val;
              const truth = Array.isArray(v) ? v.length > 0 : (v !== undefined && v !== null && v !== false && v !== '' && v !== 0);
              const branch = truth !== n.not ? n.then : n.else;
              if (branch !== null) {
                emitNodes(branch, bindings, depth);
              }
              break;
            }
            flushConcat();
            const expr = emitPath(n.path, bindings);
            const tv = trackedTmp('_v');
            lines.push(`${tv} = ${expr};`);
            const truth = `(Array.isArray(${tv}) ? ${tv}.length > 0 : (${tv} !== undefined && ${tv} !== null && ${tv} !== false && ${tv} !== "" && ${tv} !== 0))`;
            lines.push(`if (${n.not ? `!${truth}` : truth}) {`);
            emitNodes(n.then, bindings, depth);
            if (n.else !== null) {
              lines.push('} else {');
              emitNodes(n.else, bindings, depth);
            }
            lines.push('}');
            break;
          }
          case 'for': {
            flushConcat();
            if (
              n.body.length === 1 && n.body[0].kind === 'include' &&
              n.name === 'p' && depth < INCLUDE_DEPTH
            ) {
              const incName = n.body[0].name;
              if (templatesMap.has(incName)) {
                const free = getFreeVars(incName, depth + 1);
                let onlyP = true;
                for (const k of free) {
                  if (k !== 'p' && k !== 'site' && k !== 'tags' && k !== 'recent') {
                    onlyP = false;
                    break;
                  }
                }
                if (onlyP && !isShadowed('site', bindings) && !isShadowed('tags', bindings) && !isShadowed('recent', bindings)) {
                  const expr = emitPath(n.path, bindings);
                  const arr = trackedTmp('_a');
                  const lenVar = trackedTmp('_l');
                  const kVar = trackedTmp('_k');
                  lines.push(`${arr} = ${expr};`);
                  lines.push(`if (Array.isArray(${arr})) {`);
                  lines.push(`const ${lenVar} = ${arr}.length;`);
                  lines.push(`for (let ${kVar} = 0; ${kVar} < ${lenVar}; ${kVar}++) {`);
                  lines.push(`_o.push(_cardRender(${arr}[${kVar}], ${JSON.stringify(incName)}, ${depth + 1}));`);
                  lines.push('}');
                  lines.push('}');
                  break;
                }
              }
            }
            const expr = emitPath(n.path, bindings);
            const arr = trackedTmp('_a');
            const lenVar = trackedTmp('_l');
            const kVar = trackedTmp('_k');
            const elemVar = trackedTmp('_e');
            lines.push(`${arr} = ${expr};`);
            lines.push(`if (Array.isArray(${arr})) {`);
            lines.push(`const ${lenVar} = ${arr}.length;`);
            lines.push(`for (let ${kVar} = 0; ${kVar} < ${lenVar}; ${kVar}++) {`);
            lines.push(`const ${elemVar} = ${arr}[${kVar}];`);
            bindings.push({ name: n.name, v: elemVar, k: kVar, len: lenVar });
            emitNodes(n.body, bindings, depth);
            bindings.pop();
            lines.push('}');
            lines.push('}');
            break;
          }
          case 'include': {
            const inc = templatesMap.get(n.name);
            if (inc !== undefined && depth < INCLUDE_DEPTH) {
              const shadowed = isShadowed('site', bindings) || isShadowed('tags', bindings) || isShadowed('recent', bindings);
              if (!shadowed && isSiteOnlyInclude(n.name, depth + 1)) {
                const pKey = `${n.name}@${depth + 1}`;
                let rendered = staticPartials.get(pKey);
                if (rendered === undefined) {
                  const subFn = compileEntry(n.name, depth + 1);
                  rendered = subFn(siteGlobals);
                  staticPartials.set(pKey, rendered);
                }
                textBuf += rendered;
              } else {
                flushConcat();
                emitNodes(inc, bindings, depth + 1);
              }
            }
            break;
          }
        }
      }
      flushConcat();
    }

    emitNodes(ast, [], baseDepth);
    const decl = usedTmps.length > 0 ? `let ${usedTmps.join(', ')};` : '';
    const code = `${decl}\n${lines.join('\n')}\nreturn _o.join('');`;
    const fn = new Function('_r', '_esc', '_txt', '_cardRender', code);
    const wrapper = (vars) => fn(vars, escapeHtml, textOf, cardRender);
    compiled.set(cacheKey, wrapper);
    return wrapper;
  }

  return compileEntry;
}

// ---------------------------------------------------------------- Build

export function run(input) {
  const slugify = createSlugifier();

  // 1. Parse templates in code-unit order
  const templates = new Map();
  const report = [];
  const tplNames = Object.keys(input.templates).sort(byCodeUnits);
  for (let i = 0; i < tplNames.length; i++) {
    const name = tplNames[i];
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  // 2. Sort files by path in code-unit order, split sources vs static files
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f.path.endsWith('.md')) {
      const content = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text: content });
    } else {
      statics.push(f);
    }
  }

  // 3. Front matter & refusals/drafts
  const kept = [];
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    const path = s.path;
    const post = path.startsWith('posts/');
    if (!post && (path.startsWith('tags/') || path.startsWith('page/'))) {
      const own = path.startsWith('tags/') ? 'tags' : 'page';
      report.push(`refused ${path}: ${own}/ is the generator's own`);
      continue;
    }
    if (post && !Object.hasOwn(fm.data, 'date')) {
      report.push(`refused ${path}: a post needs a date`);
      continue;
    }
    const layout = fm.data.layout ?? (post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${path}: layout "${layout}" is no template that parses`);
      continue;
    }
    if (fm.data.draft === true) {
      report.push(`draft ${path}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = post;
    s.layout = layout;
    kept.push(s);
  }

  // 4. Permalinks
  const base = input.site.base_url.replace(/\/+$/, '');
  const taken = new Map();
  const bySource = new Map();
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const dir = s.post ? 'posts' : dirOf(s.path);
    let tSet = taken.get(dir);
    if (tSet === undefined) {
      tSet = new Set(dir === '' ? RESERVED : undefined);
      taken.set(dir, tSet);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), tSet);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 5. Markdown
  const staticPaths = new Set();
  for (let i = 0; i < statics.length; i++) staticPaths.add(statics[i].path);
  const broken = new Set();
  const resolveDirCaches = new Map();
  const extEscCache = new Map();
  const dirEscLinkCaches = new Map();

  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const dir = dirOf(s.path);
    let dirCache = resolveDirCaches.get(dir);
    if (dirCache === undefined) {
      dirCache = new Map();
      resolveDirCaches.set(dir, dirCache);
    }
    let dirEscCache = dirEscLinkCaches.get(dir);
    if (dirEscCache === undefined) {
      dirEscCache = new Map();
      dirEscLinkCaches.set(dir, dirEscCache);
    }
    const env = {
      escapedLink(target) {
        const fast = dirEscCache.get(target);
        if (fast !== undefined) return fast;

        const c0 = target.charCodeAt(0);
        if (c0 === 47 || c0 === 35 || hasUrlScheme(target)) {
          let esc = extEscCache.get(target);
          if (esc === undefined) {
            esc = escapeHtml(target);
            extEscCache.set(target, esc);
          }
          dirEscCache.set(target, esc);
          return esc;
        }
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        if (rel !== '') {
          let resolvedUrl = dirCache.get(rel);
          if (resolvedUrl === undefined) {
            const resolved = resolvePath(dir, rel);
            if (resolved !== null) {
              const targetSource = bySource.get(resolved);
              if (targetSource !== undefined) resolvedUrl = targetSource.url;
              else if (staticPaths.has(resolved)) resolvedUrl = `${base}/${resolved}`;
              else resolvedUrl = null;
            } else {
              resolvedUrl = null;
            }
            dirCache.set(rel, resolvedUrl);
          }
          if (resolvedUrl !== null) {
            const esc = escapeHtml(frag === '' ? resolvedUrl : `${resolvedUrl}${frag}`);
            dirEscCache.set(target, esc);
            return esc;
          }
        }
        broken.add(`broken-link ${s.path} -> ${target}`);
        let esc = extEscCache.get(target);
        if (esc === undefined) {
          esc = escapeHtml(target);
          extEscCache.set(target, esc);
        }
        return esc;
      },
    };
    const md = renderMarkdown(s.body, env, slugify);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 6. Collections
  const posts = [];
  for (let i = 0; i < kept.length; i++) {
    if (kept[i].post) posts.push(kept[i]);
  }
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    const p = posts[k];
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 7. Tags
  const bySlug = new Map();
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    const rawTags = p.data.tags;
    const refs = [];
    if (rawTags !== undefined && rawTags.length > 0) {
      const seen = new Set();
      for (let j = 0; j < rawTags.length; j++) {
        const name = rawTags[j];
        const slug = slugify(name);
        if (seen.has(slug)) continue;
        seen.add(slug);
        let tag = bySlug.get(slug);
        if (tag === undefined) {
          tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [], _ref: { name, slug, url: `${base}/tags/${slug}/` } };
          bySlug.set(slug, tag);
        }
        tag.posts.push(p);
        refs.push(tag._ref);
      }
    }
    p.tagRefs = refs;
  }

  const pageMissingTagRefs = new Map();
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    if (s.post) continue;
    const rawTags = s.data.tags;
    const refs = [];
    if (rawTags !== undefined && rawTags.length > 0) {
      const seen = new Set();
      for (let j = 0; j < rawTags.length; j++) {
        const name = rawTags[j];
        const slug = slugify(name);
        if (seen.has(slug)) continue;
        seen.add(slug);
        const existing = bySlug.get(slug);
        if (existing !== undefined) {
          refs.push(existing._ref);
        } else {
          let miss = pageMissingTagRefs.get(slug);
          if (miss === undefined || miss.name !== name) {
            miss = { name, slug, url: '' };
            if (!pageMissingTagRefs.has(slug)) pageMissingTagRefs.set(slug, miss);
          }
          refs.push(miss);
        }
      }
    }
    s.tagRefs = refs;
  }

  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 8. Layouts
  const dateCache = new Map();
  const fmtDate = (d) => {
    if (d === undefined) return '';
    let res = dateCache.get(d);
    if (res === undefined) {
      res = longDate(d);
      dateCache.set(d, res);
    }
    return res;
  };

  const linkOf = (s) => {
    if (s === null || s === undefined) return null;
    if (s._link !== undefined) return s._link;
    const obj = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: fmtDate(s.data.date),
    };
    s._link = obj;
    return obj;
  };

  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: fmtDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(countWords(s.body) / 200)),
    tags: s.tagRefs,
  });

  const cards = new Map();
  for (let i = 0; i < posts.length; i++) {
    cards.set(posts[i], cardOf(posts[i]));
  }

  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recentCount = Math.min(input.site.recent, posts.length);
  const recent = new Array(recentCount);
  for (let i = 0; i < recentCount; i++) recent[i] = cards.get(posts[i]);

  const baseSafe = escapeHtml(base) === base;
  const siteGlobals = { site, tags: allTags, recent };
  const getCompiler = createTemplateRunner(templates, siteGlobals, baseSafe);
  const output = {};

  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const fn = getCompiler(s.layout, 0);
    const c = s.post ? cards.get(s) : cardOf(s);
    const page = {
      title: c.title,
      url: c.url,
      date: c.date,
      date_long: c.date_long,
      summary: c.summary,
      excerpt: c.excerpt,
      reading_minutes: c.reading_minutes,
      tags: c.tags,
      slug: s.slug,
      content: s.html,
      toc: s.toc,
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = fn({ site, tags: allTags, recent, page });
  }

  const indexFn = getCompiler('index', 0);
  if (indexFn !== null) {
    const per = input.site.per_page;
    const pages = Math.max(1, Math.ceil(posts.length / per));
    const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
    for (let k = 1; k <= pages; k++) {
      const start = (k - 1) * per;
      const end = Math.min(k * per, posts.length);
      const pagePosts = new Array(Math.max(0, end - start));
      for (let j = start; j < end; j++) pagePosts[j - start] = cards.get(posts[j]);
      const pager = {
        number: k,
        total: pages,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pages ? '' : indexUrl(k + 1),
      };
      output[k === 1 ? 'index.html' : `page/${k}/index.html`] = indexFn({ site, tags: allTags, recent, posts: pagePosts, pager });
    }
  }

  const tagFn = getCompiler('tag', 0);
  if (tagFn !== null) {
    for (let i = 0; i < tags.length; i++) {
      const t = tags[i];
      const tPosts = new Array(t.posts.length);
      for (let j = 0; j < t.posts.length; j++) tPosts[j] = cards.get(t.posts[j]);
      output[`tags/${t.slug}/index.html`] = tagFn({
        site,
        tags: allTags,
        recent,
        tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: tPosts },
      });
    }
  }

  const tagsFn = getCompiler('tags', 0);
  if (tagsFn !== null) {
    output['tags/index.html'] = tagsFn({ site, tags: allTags, recent });
  }

  for (let i = 0; i < statics.length; i++) {
    const f = statics[i];
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 9. Report
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.length - posts.length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;

  return output;
}
