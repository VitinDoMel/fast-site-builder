// High-speed zero-allocation Uint8Array/Buffer arena implementation of makefun-site 1.0.0.
// Pure ES module with no external dependencies; each run(input) call resets cursors cleanly with no cross-case leakage.

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

// First byte on a line that can stop a paragraph: \t(9), ' '(32), #(35), *(42), -(45), `(96)
const PARA_STOP_FIRST = new Uint8Array(128);
PARA_STOP_FIRST[9] = 1;
PARA_STOP_FIRST[32] = 1;
PARA_STOP_FIRST[35] = 1;
PARA_STOP_FIRST[42] = 1;
PARA_STOP_FIRST[45] = 1;
PARA_STOP_FIRST[96] = 1;

// Special bytes in renderInline: " & ' * < > [ \ ` (256-entry avoids <128 branch)
const INLINE_SPECIAL = new Uint8Array(256);
INLINE_SPECIAL[34] = 1; // "
INLINE_SPECIAL[38] = 1; // &
INLINE_SPECIAL[39] = 1; // '
INLINE_SPECIAL[42] = 1; // *
INLINE_SPECIAL[60] = 1; // <
INLINE_SPECIAL[62] = 1; // >
INLINE_SPECIAL[91] = 1; // [
INLINE_SPECIAL[92] = 1; // \
INLINE_SPECIAL[96] = 1; // `

// Escapable by backslash: \ ` * _ [ ] ( ) # + - . ! >
const ESCAPABLE = new Uint8Array(256);
for (const ch of ['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']) {
  ESCAPABLE[ch.charCodeAt(0)] = 1;
}

// HTML escapable bytes: & < > " '
const HTML_SPECIAL = new Uint8Array(256);
HTML_SPECIAL[34] = 1; // "
HTML_SPECIAL[38] = 1; // &
HTML_SPECIAL[39] = 1; // '
HTML_SPECIAL[60] = 1; // <
HTML_SPECIAL[62] = 1; // >

// JSON escapable byte flags: any < 32, "(34), \(92)
const JSON_SPECIAL = new Uint8Array(256);
for (let i = 0; i < 32; i++) JSON_SPECIAL[i] = 1;
JSON_SPECIAL[34] = 1;
JSON_SPECIAL[92] = 1;

const HEX_LO = '0123456789abcdef';

// ---------------------------------------------------------------- Persistent Reusable Arenas

let srcArena = Buffer.allocUnsafe(4 * 1024 * 1024);
let srcPos = 0;

let mdArena = Buffer.allocUnsafe(6 * 1024 * 1024);
let mdPos = 0;

let tplArena = Buffer.allocUnsafe(1024 * 1024);
let tplPos = 0;

let cardArena = Buffer.allocUnsafe(1024 * 1024);
let cardPos = 0;

let outArena = Buffer.allocUnsafe(8 * 1024 * 1024);
let outU32 = new Uint32Array(outArena.buffer, outArena.byteOffset, outArena.byteLength >>> 2);
let outPos = 0;

let jsonArena = Buffer.allocUnsafe(10 * 1024 * 1024);
let jsonPos = 0;

let scratchArena = Buffer.allocUnsafe(256 * 1024);

let linkArena = Buffer.allocUnsafe(512 * 1024);
let linkPos = 0;

function growArena(cur, minSize) {
  let cap = cur.length;
  while (cap < minSize) cap *= 2;
  const next = Buffer.allocUnsafe(cap);
  cur.copy(next, 0, 0, cur.length);
  return next;
}

function ensureSrc(need) {
  if (srcPos + need > srcArena.length) srcArena = growArena(srcArena, srcPos + need);
}
function ensureMd(need) {
  if (mdPos + need > mdArena.length) mdArena = growArena(mdArena, mdPos + need);
}
function ensureTpl(need) {
  if (tplPos + need > tplArena.length) tplArena = growArena(tplArena, tplPos + need);
}
function ensureCard(need) {
  if (cardPos + need > cardArena.length) cardArena = growArena(cardArena, cardPos + need);
}
function ensureOut(need) {
  if (outPos + need > outArena.length) {
    outArena = growArena(outArena, outPos + need);
    outU32 = new Uint32Array(outArena.buffer, outArena.byteOffset, outArena.byteLength >>> 2);
  }
}
function ensureJson(need) {
  if (jsonPos + need > jsonArena.length) jsonArena = growArena(jsonArena, jsonPos + need);
}
function ensureScratch(need) {
  if (need > scratchArena.length) {
    let cap = scratchArena.length;
    while (cap < need) cap *= 2;
    scratchArena = Buffer.allocUnsafe(cap);
  }
}
function ensureLink(need) {
  if (linkPos + need > linkArena.length) linkArena = growArena(linkArena, linkPos + need);
}

// Target output sink used by template VM: either outArena (default) or cardArena
let vmBuf = outArena;
let vmPos = 0;
let vmIsCard = false;

function ensureVm(need) {
  if (vmIsCard) {
    if (vmPos + need > cardArena.length) {
      cardArena = growArena(cardArena, vmPos + need);
      vmBuf = cardArena;
    }
  } else {
    if (vmPos + need > outArena.length) {
      outArena = growArena(outArena, vmPos + need);
      outU32 = new Uint32Array(outArena.buffer, outArena.byteOffset, outArena.byteLength >>> 2);
      vmBuf = outArena;
    }
  }
}

// ---------------------------------------------------------------- Low-level Arena Writers

function mdWriteAscii(str) {
  const len = str.length;
  if (mdPos + len > mdArena.length) ensureMd(len);
  const b = mdArena;
  let p = mdPos;
  for (let i = 0; i < len; i++) b[p++] = str.charCodeAt(i);
  mdPos = p;
}

function mdCopySpan(src, from, to) {
  const len = to - from;
  if (len <= 0) return;
  if (mdPos + len > mdArena.length) ensureMd(len);
  if (len <= 48) {
    const b = mdArena;
    let p = mdPos;
    for (let i = from; i < to; i++) b[p++] = src[i];
    mdPos = p;
  } else {
    src.copy(mdArena, mdPos, from, to);
    mdPos += len;
  }
}

function mdWriteEscapeSpan(src, from, to) {
  const len = to - from;
  if (len <= 0) return;
  if (mdPos + len * 6 > mdArena.length) ensureMd(len * 6);
  const dst = mdArena;
  let p = mdPos;
  let plain = from;
  for (let i = from; i < to; i++) {
    const c = src[i];
    if (c < 128 && HTML_SPECIAL[c] !== 0) {
      if (plain < i) {
        const sl = i - plain;
        if (sl <= 32) {
          for (let k = plain; k < i; k++) dst[p++] = src[k];
        } else {
          src.copy(dst, p, plain, i);
          p += sl;
        }
      }
      if (c === 38) { // &amp;
        dst[p] = 38; dst[p + 1] = 97; dst[p + 2] = 109; dst[p + 3] = 112; dst[p + 4] = 59; p += 5;
      } else if (c === 60) { // &lt;
        dst[p] = 38; dst[p + 1] = 108; dst[p + 2] = 116; dst[p + 3] = 59; p += 4;
      } else if (c === 62) { // &gt;
        dst[p] = 38; dst[p + 1] = 103; dst[p + 2] = 116; dst[p + 3] = 59; p += 4;
      } else if (c === 34) { // &quot;
        dst[p] = 38; dst[p + 1] = 113; dst[p + 2] = 117; dst[p + 3] = 111; dst[p + 4] = 116; dst[p + 5] = 59; p += 6;
      } else { // &#39;
        dst[p] = 38; dst[p + 1] = 35; dst[p + 2] = 51; dst[p + 3] = 57; dst[p + 4] = 59; p += 5;
      }
      plain = i + 1;
    }
  }
  if (plain < to) {
    const sl = to - plain;
    if (sl <= 32) {
      for (let k = plain; k < to; k++) dst[p++] = src[k];
    } else {
      src.copy(dst, p, plain, to);
      p += sl;
    }
  }
  mdPos = p;
}

function mdWriteStrUtf8(str) {
  const len = str.length;
  if (len === 0) return;
  if (mdPos + len * 3 > mdArena.length) ensureMd(len * 3);
  mdPos += mdArena.utf8Write(str, mdPos);
}

function mdWriteUint(n) {
  if (n < 10) {
    if (mdPos + 1 > mdArena.length) ensureMd(1);
    mdArena[mdPos++] = 48 + n;
    return;
  }
  const s = String(n);
  mdWriteAscii(s);
}

function vmWriteBytes(src, from, to) {
  const len = to - from;
  if (len <= 0) return;
  if (vmPos + len > vmBuf.length) ensureVm(len);
  if (len <= 40) {
    const dst = vmBuf;
    let p = vmPos;
    for (let i = from; i < to; i++) dst[p++] = src[i];
    vmPos = p;
  } else {
    src.copy(vmBuf, vmPos, from, to);
    vmPos += len;
  }
}

function vmWriteEscapeSpan(src, from, to) {
  const len = to - from;
  if (len <= 0) return;
  if (vmPos + len * 6 > vmBuf.length) ensureVm(len * 6);
  const dst = vmBuf;
  let p = vmPos;
  let plain = from;
  for (let i = from; i < to; i++) {
    const c = src[i];
    if (c < 128 && HTML_SPECIAL[c] !== 0) {
      if (plain < i) {
        const sl = i - plain;
        if (sl <= 32) {
          for (let k = plain; k < i; k++) dst[p++] = src[k];
        } else {
          src.copy(dst, p, plain, i);
          p += sl;
        }
      }
      if (c === 38) {
        dst[p] = 38; dst[p + 1] = 97; dst[p + 2] = 109; dst[p + 3] = 112; dst[p + 4] = 59; p += 5;
      } else if (c === 60) {
        dst[p] = 38; dst[p + 1] = 108; dst[p + 2] = 116; dst[p + 3] = 59; p += 4;
      } else if (c === 62) {
        dst[p] = 38; dst[p + 1] = 103; dst[p + 2] = 116; dst[p + 3] = 59; p += 4;
      } else if (c === 34) {
        dst[p] = 38; dst[p + 1] = 113; dst[p + 2] = 117; dst[p + 3] = 111; dst[p + 4] = 116; dst[p + 5] = 59; p += 6;
      } else {
        dst[p] = 38; dst[p + 1] = 35; dst[p + 2] = 51; dst[p + 3] = 57; dst[p + 4] = 59; p += 5;
      }
      plain = i + 1;
    }
  }
  if (plain < to) {
    const sl = to - plain;
    if (sl <= 32) {
      for (let k = plain; k < to; k++) dst[p++] = src[k];
    } else {
      src.copy(dst, p, plain, to);
      p += sl;
    }
  }
  vmPos = p;
}

function vmWriteStrRaw(str) {
  const len = str.length;
  if (len === 0) return;
  if (vmPos + len * 3 > vmBuf.length) ensureVm(len * 3);
  const dst = vmBuf;
  let p = vmPos;
  for (let i = 0; i < len; i++) {
    const c = str.charCodeAt(i);
    if (c < 128) {
      dst[p++] = c;
    } else {
      vmPos += dst.utf8Write(str, vmPos);
      return;
    }
  }
  vmPos = p;
}

function vmWriteStrEscaped(str) {
  const len = str.length;
  if (len === 0) return;
  if (vmPos + len * 6 > vmBuf.length) ensureVm(len * 6);
  const dst = vmBuf;
  let p = vmPos;
  for (let i = 0; i < len; i++) {
    const c = str.charCodeAt(i);
    if (c < 128) {
      if (HTML_SPECIAL[c] === 0) {
        dst[p++] = c;
      } else if (c === 38) {
        dst[p] = 38; dst[p + 1] = 97; dst[p + 2] = 109; dst[p + 3] = 112; dst[p + 4] = 59; p += 5;
      } else if (c === 60) {
        dst[p] = 38; dst[p + 1] = 108; dst[p + 2] = 116; dst[p + 3] = 59; p += 4;
      } else if (c === 62) {
        dst[p] = 38; dst[p + 1] = 103; dst[p + 2] = 116; dst[p + 3] = 59; p += 4;
      } else if (c === 34) {
        dst[p] = 38; dst[p + 1] = 113; dst[p + 2] = 117; dst[p + 3] = 111; dst[p + 4] = 116; dst[p + 5] = 59; p += 6;
      } else {
        dst[p] = 38; dst[p + 1] = 35; dst[p + 2] = 51; dst[p + 3] = 57; dst[p + 4] = 59; p += 5;
      }
    } else {
      // Non-ASCII: encode into scratch, then byte-escape
      ensureScratch(len * 3);
      const nb = scratchArena.utf8Write(str, 0);
      vmWriteEscapeSpan(scratchArena, 0, nb);
      return;
    }
  }
  vmPos = p;
}

function vmWriteInt(n) {
  if (n >= 0 && n < 10000) {
    if (vmPos + 4 > vmBuf.length) ensureVm(4);
    const dst = vmBuf;
    let p = vmPos;
    if (n < 10) {
      dst[p++] = 48 + n;
    } else if (n < 100) {
      const q = (n / 10) | 0;
      dst[p++] = 48 + q;
      dst[p++] = 48 + (n - q * 10);
    } else if (n < 1000) {
      const q1 = (n / 100) | 0;
      const r1 = n - q1 * 100;
      const q2 = (r1 / 10) | 0;
      dst[p++] = 48 + q1;
      dst[p++] = 48 + q2;
      dst[p++] = 48 + (r1 - q2 * 10);
    } else {
      const q1 = (n / 1000) | 0;
      const r1 = n - q1 * 1000;
      const q2 = (r1 / 100) | 0;
      const r2 = r1 - q2 * 100;
      const q3 = (r2 / 10) | 0;
      dst[p++] = 48 + q1;
      dst[p++] = 48 + q2;
      dst[p++] = 48 + q3;
      dst[p++] = 48 + (r2 - q3 * 10);
    }
    vmPos = p;
    return;
  }
  vmWriteStrRaw(String(n));
}

// ---------------------------------------------------------------- Common Helpers

function byCodeUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
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
  function slugifyStr(text) {
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
  }

  // Zero-alloc ASCII fast slugifier for headings on srcArena/buf
  const slugTmp = new Uint8Array(64);
  function slugifyBuf(buf, start, end) {
    for (let i = start; i < end; i++) {
      if (buf[i] >= 128) return slugifyStr(buf.toString('utf8', start, end));
    }
    let outLen = 0;
    let gap = false;
    for (let i = start; i < end; i++) {
      let c = buf[i];
      if (c >= 65 && c <= 90) c += 32;
      else if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57))) {
        if (outLen > 0) gap = true;
        continue;
      }
      if (gap) {
        if (outLen >= 63) break;
        slugTmp[outLen++] = 45;
        gap = false;
      } else if (outLen >= SLUG_MAX) {
        break;
      }
      slugTmp[outLen++] = c;
    }
    if (outLen === 0) return 'untitled';
    return Buffer.from(slugTmp.buffer, 0, outLen).toString('latin1');
  }

  return { slugifyStr, slugifyBuf };
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

// Check UTF-8 Unicode space starting at buf[i] (< end). Returns byte length (2 or 3) if Unicode space, else 0.
function unicodeSpaceByteLen(buf, i, end) {
  const b0 = buf[i];
  if (b0 === 0xc2) {
    return i + 1 < end && buf[i + 1] === 0xa0 ? 2 : 0;
  }
  if (b0 === 0xe1) {
    return i + 2 < end && buf[i + 1] === 0x9a && buf[i + 2] === 0x80 ? 3 : 0;
  }
  if (b0 === 0xe2) {
    if (i + 2 >= end) return 0;
    const b1 = buf[i + 1];
    const b2 = buf[i + 2];
    if (b1 === 0x80) {
      return ((b2 >= 0x80 && b2 <= 0x8a) || b2 === 0xa8 || b2 === 0xa9 || b2 === 0xaf) ? 3 : 0;
    }
    return b1 === 0x81 && b2 === 0x9f ? 3 : 0;
  }
  if (b0 === 0xe3) {
    return i + 2 < end && buf[i + 1] === 0x80 && buf[i + 2] === 0x80 ? 3 : 0;
  }
  if (b0 === 0xef) {
    return i + 2 < end && buf[i + 1] === 0xbb && buf[i + 2] === 0xbf ? 3 : 0;
  }
  return 0;
}

function utf8SeqLen(b0) {
  if (b0 < 0xc0) return 1;
  if (b0 < 0xe0) return 2;
  if (b0 < 0xf0) return 3;
  return 4;
}

function countWordsBytes(buf, start, end) {
  let count = 0;
  let prevWs = 1;
  let i = start;
  const lim = end - 3;
  while (i < lim) {
    const b0 = buf[i];
    const b1 = buf[i + 1];
    const b2 = buf[i + 2];
    const b3 = buf[i + 3];
    if ((b0 | b1 | b2 | b3) < 128) {
      const nw0 = NON_WS[b0];
      count += nw0 & prevWs;
      const nw1 = NON_WS[b1];
      count += nw1 & (nw0 ^ 1);
      const nw2 = NON_WS[b2];
      count += nw2 & (nw1 ^ 1);
      const nw3 = NON_WS[b3];
      count += nw3 & (nw2 ^ 1);
      prevWs = nw3 ^ 1;
      i += 4;
    } else if (b0 < 128) {
      const nw = NON_WS[b0];
      count += nw & prevWs;
      prevWs = nw ^ 1;
      i++;
    } else {
      const us = unicodeSpaceByteLen(buf, i, end);
      if (us !== 0) {
        prevWs = 1;
        i += us;
      } else {
        count += prevWs;
        prevWs = 0;
        const sl = utf8SeqLen(b0);
        i = i + sl <= end ? i + sl : end;
      }
    }
  }
  while (i < end) {
    const b0 = buf[i];
    if (b0 < 128) {
      const nw = NON_WS[b0];
      count += nw & prevWs;
      prevWs = nw ^ 1;
      i++;
    } else {
      const us = unicodeSpaceByteLen(buf, i, end);
      if (us !== 0) {
        prevWs = 1;
        i += us;
      } else {
        count += prevWs;
        prevWs = 0;
        const sl = utf8SeqLen(b0);
        i = i + sl <= end ? i + sl : end;
      }
    }
  }
  return count;
}

function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

function findNl(buf, pos, end) {
  while (pos < end && buf[pos] !== 10) pos++;
  return pos;
}

function mdCopyFast(src, from, to) {
  const len = to - from;
  if (len <= 0) return;
  const dst = mdArena;
  let p = mdPos;
  if (len <= 48) {
    for (let i = from; i < to; i++) dst[p++] = src[i];
  } else {
    src.copy(dst, p, from, to);
    p += len;
  }
  mdPos = p;
}

function resolvePath(dir, rel) {
  if (rel.indexOf('..') === -1 && rel.indexOf('./') === -1 && rel.indexOf('//') === -1 && rel !== '.' && !rel.startsWith('/') && !rel.endsWith('/')) {
    return dir === '' ? rel : `${dir}/${rel}`;
  }
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.join('/');
}

function hasUrlScheme(target) {
  const len = target.length;
  if (len < 2) return false;
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < len; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true;
    if (
      !(c >= 65 && c <= 90) &&
      !(c >= 97 && c <= 122) &&
      !(c >= 48 && c <= 57) &&
      c !== 43 && c !== 45 && c !== 46
    ) {
      return false;
    }
  }
  return false;
}

// ---------------------------------------------------------------- Front Matter

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"\[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28;
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

function parseFrontMatterBytes(buf, start, end) {
  const len = end - start;
  if (len < 3 || buf[start] !== 45 || buf[start + 1] !== 45 || buf[start + 2] !== 45) {
    return { error: 'no front matter' };
  }
  if (len === 3) return { error: 'the front matter is not closed' };
  if (buf[start + 3] !== 10) return { error: 'no front matter' };

  let closeStart = -1;
  let closeEnd = -1;
  let scan = start + 4;
  while (scan <= end) {
    const lEnd = findNl(buf, scan, end);
    if (lEnd - scan === 3 && buf[scan] === 45 && buf[scan + 1] === 45 && buf[scan + 2] === 45) {
      closeStart = scan;
      closeEnd = lEnd < end ? lEnd + 1 : end;
      break;
    }
    if (lEnd >= end) break;
    scan = lEnd + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };

  const data = {};
  let p = start + 4;
  let lineNum = 2;
  while (p < closeStart) {
    const lEnd = findNl(buf, p, closeStart);
    const c0 = p < lEnd ? buf[p] : -1;
    if (c0 === 35) {
      p = lEnd + 1;
      lineNum++;
      continue;
    }
    if (c0 === -1 || c0 === 32 || c0 === 9) {
      let onlyWs = true;
      for (let k = p; k < lEnd; k++) {
        const ch = buf[k];
        if (ch !== 32 && ch !== 9) {
          onlyWs = false;
          break;
        }
      }
      if (onlyWs) {
        p = lEnd + 1;
        lineNum++;
        continue;
      }
    }

    let kEnd = p;
    while (kEnd < lEnd) {
      const ch = buf[kEnd];
      if ((ch >= 97 && ch <= 122) || ch === 95) kEnd++;
      else break;
    }
    if (kEnd === p || kEnd >= lEnd || buf[kEnd] !== 58) {
      return { error: `line ${lineNum} is not "key: value"` };
    }

    let raw = '';
    if (kEnd + 1 < lEnd) {
      if (buf[kEnd + 1] !== 32) {
        return { error: `line ${lineNum} is not "key: value"` };
      }
      let rEnd = lEnd;
      while (rEnd > kEnd + 2) {
        const ch = buf[rEnd - 1];
        if (ch === 32 || ch === 9) rEnd--;
        else break;
      }
      raw = buf.toString('utf8', kEnd + 2, rEnd);
    }

    const key = buf.toString('latin1', p, kEnd);
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

    p = lEnd + 1;
    lineNum++;
  }

  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, bodyStart: closeEnd };
}

// ---------------------------------------------------------------- Markdown -> mdArena

function renderInlineToArena(buf, from, to, env) {
  let plainStart = from;
  let i = from;
  const sp = INLINE_SPECIAL;
  const lim4 = to - 3;
  while (i < to) {
    while (i < lim4 && (sp[buf[i]] | sp[buf[i + 1]] | sp[buf[i + 2]] | sp[buf[i + 3]]) === 0) {
      i += 4;
    }
    while (i < to && sp[buf[i]] === 0) {
      i++;
    }
    if (i >= to) break;
    const c = buf[i];
    if (c === 92) {
      if (i + 1 < to) {
        const next = buf[i + 1];
        if (ESCAPABLE[next] !== 0) {
          if (plainStart < i) mdCopyFast(buf, plainStart, i);
          if (next === 62) mdWriteAscii('&gt;');
          else mdArena[mdPos++] = next;
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
        const ch = buf[x];
        if (ch === 96) {
          j = x;
          break;
        }
        if (HTML_SPECIAL[ch] !== 0) clean = false;
      }
      if (j > i + 1) {
        if (plainStart < i) mdCopyFast(buf, plainStart, i);
        mdWriteAscii('<code>');
        if (clean) mdCopyFast(buf, i + 1, j);
        else mdWriteEscapeSpan(buf, i + 1, j);
        mdWriteAscii('</code>');
        i = j + 1;
        plainStart = i;
      } else {
        i++;
      }
      continue;
    }
    if (c === 42) {
      if (i + 1 < to && buf[i + 1] === 42) {
        let j = -1;
        let clean = true;
        const limit = to - 2;
        for (let x = i + 2; x <= limit; x++) {
          const ch = buf[x];
          if (sp[ch] !== 0) {
            if (ch === 42 && buf[x + 1] === 42) {
              j = x;
              break;
            }
            clean = false;
            if (ch === 92 && x + 1 < to) {
              if (ESCAPABLE[buf[x + 1]] !== 0) x++;
            }
          }
        }
        if (j > i + 2) {
          if (plainStart < i) mdCopyFast(buf, plainStart, i);
          mdWriteAscii('<strong>');
          if (clean) mdCopyFast(buf, i + 2, j);
          else renderInlineToArena(buf, i + 2, j, env);
          mdWriteAscii('</strong>');
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
        const ch = buf[x];
        if (sp[ch] !== 0) {
          if (ch === 42) {
            if (x + 1 < to && buf[x + 1] === 42) {
              clean = false;
              x++;
              continue;
            }
            j = x;
            break;
          }
          clean = false;
          if (ch === 92 && x + 1 < to) {
            if (ESCAPABLE[buf[x + 1]] !== 0) x++;
          }
        }
      }
      if (j > i + 1) {
        if (plainStart < i) mdCopyFast(buf, plainStart, i);
        mdWriteAscii('<em>');
        if (clean) mdCopyFast(buf, i + 1, j);
        else renderInlineToArena(buf, i + 1, j, env);
        mdWriteAscii('</em>');
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
        const ch = buf[x];
        if (sp[ch] !== 0) {
          cleanText = false;
          if (ch === 92 && x + 1 < to) {
            if (ESCAPABLE[buf[x + 1]] !== 0) {
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
      if (k !== -1 && k + 1 < to && buf[k + 1] === 40) {
        let m = -1;
        let hasWs = false;
        for (let x = k + 2; x < to; x++) {
          const ch = buf[x];
          if (ch === 41) {
            m = x;
            break;
          }
          if (ch < 128) {
            if (WS_ASCII[ch] !== 0) {
              hasWs = true;
              break;
            }
          } else {
            if (unicodeSpaceByteLen(buf, x, to) !== 0) {
              hasWs = true;
              break;
            }
          }
        }
        if (m > k + 2 && !hasWs) {
          if (plainStart < i) mdCopyFast(buf, plainStart, i);
          mdWriteAscii('<a href="');
          env.writeEscapedLink(buf, k + 2, m);
          ensureMd((to - i) * 8 + 256);
          mdWriteAscii('">');
          if (cleanText) mdCopyFast(buf, i + 1, k);
          else renderInlineToArena(buf, i + 1, k, env);
          mdWriteAscii('</a>');
          i = m + 1;
          plainStart = i;
          continue;
        }
      }
      i++;
      continue;
    }
    if (plainStart < i) mdCopyFast(buf, plainStart, i);
    if (c === 38) mdWriteAscii('&amp;');
    else if (c === 60) mdWriteAscii('&lt;');
    else if (c === 62) mdWriteAscii('&gt;');
    else if (c === 34) mdWriteAscii('&quot;');
    else mdWriteAscii('&#39;');
    i++;
    plainStart = i;
  }
  if (plainStart < to) mdCopyFast(buf, plainStart, to);
}

let _tStart = 0;
let _tEnd = 0;
function trimRange(buf, start, end) {
  while (start < end) {
    const c = buf[start];
    if (c === 32 || c === 9) start++;
    else break;
  }
  while (end > start) {
    const c = buf[end - 1];
    if (c === 32 || c === 9) end--;
    else break;
  }
  _tStart = start;
  _tEnd = end;
}

function isBlankRange(buf, start, end) {
  for (let i = start; i < end; i++) {
    const c = buf[i];
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

let _langStart = 0;
let _langEnd = 0;
function parseFenceOpen(buf, start, end) {
  if (end - start < 3 || buf[start] !== 96 || buf[start + 1] !== 96 || buf[start + 2] !== 96) {
    return false;
  }
  let p = start + 3;
  while (p < end) {
    const c = buf[p];
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) {
      p++;
    } else break;
  }
  const langEnd = p;
  while (p < end) {
    const c = buf[p];
    if (c !== 32 && c !== 9) return false;
    p++;
  }
  _langStart = start + 3;
  _langEnd = langEnd;
  return true;
}

function isFenceClose(buf, start, end) {
  if (end - start < 3 || buf[start] !== 96 || buf[start + 1] !== 96 || buf[start + 2] !== 96) {
    return false;
  }
  for (let p = start + 3; p < end; p++) {
    const c = buf[p];
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

let _hDepth = 0;
let _hStart = 0;
let _hEnd = 0;
function matchHeading(buf, start, end) {
  if (start >= end || buf[start] !== 35) return false;
  let depth = 1;
  while (depth <= 6 && start + depth < end && buf[start + depth] === 35) depth++;
  if (depth > 6) return false;
  let p = start + depth;
  if (p >= end) return false;
  const firstWs = buf[p];
  if (firstWs !== 32 && firstWs !== 9) return false;
  while (p < end) {
    const c = buf[p];
    if (c === 32 || c === 9) p++;
    else break;
  }
  let tEnd = end;
  while (tEnd > p) {
    const c = buf[tEnd - 1];
    if (c === 32 || c === 9) tEnd--;
    else break;
  }
  if (tEnd <= p) return false;
  _hDepth = depth;
  _hStart = p;
  _hEnd = tEnd;
  return true;
}

function isHr(buf, start, end) {
  if (end - start < 3) return false;
  const c = buf[start];
  if (c !== 45 && c !== 42) return false;
  if (buf[start + 1] !== c || buf[start + 2] !== c) return false;
  for (let p = start + 3; p < end; p++) {
    const ch = buf[p];
    if (ch !== 32 && ch !== 9) return false;
  }
  return true;
}

function isContinued(buf, start, end) {
  if (end - start < 3 || buf[start] !== 32 || buf[start + 1] !== 32) return false;
  let p = start + 2;
  while (p < end && buf[p] === 32) p++;
  if (p >= end) return false;
  const c = buf[p];
  if (c < 128) return WS_ASCII[c] === 0;
  return unicodeSpaceByteLen(buf, p, end) === 0;
}

function matchOrdered(buf, start, end) {
  let p = start;
  const maxD = end < start + 9 ? end : start + 9;
  while (p < maxD) {
    const c = buf[p];
    if (c >= 48 && c <= 57) p++;
    else break;
  }
  if (p === start || p + 1 >= end) return -1;
  if (buf[p] !== 46 || buf[p + 1] !== 32) return -1;
  return p + 2;
}

function scratchAppendTrimmed(scratchPos, buf, start, end) {
  trimRange(buf, start, end);
  const s = _tStart;
  const e = _tEnd;
  const len = e - s;
  if (scratchPos + len + 1 > scratchArena.length) ensureScratch(scratchPos + len + 1);
  if (len > 0) {
    buf.copy(scratchArena, scratchPos, s, e);
    scratchPos += len;
  }
  return scratchPos;
}

function renderMarkdownToArena(buf, startPos, len, env, slugifyBuf) {
  const fLen = len - startPos;
  ensureMd(fLen * 8 + 8192);
  const htmlStart = mdPos;
  const ids = new Set();
  const toc = [];
  let excerptStart = -1;
  let excerptEnd = -1;

  let pos = startPos;
  while (pos < len) {
    const end = findNl(buf, pos, len);
    const hasNl = end < len;
    const nextPos = hasNl ? end + 1 : len;

    if (pos === end) {
      pos = nextPos;
      continue;
    }

    const c0 = buf[pos];
    if ((c0 === 32 || c0 === 9) && isBlankRange(buf, pos, end)) {
      pos = nextPos;
      continue;
    }

    // Fence
    if (c0 === 96 && parseFenceOpen(buf, pos, end)) {
      const lStart = _langStart;
      const lEnd = _langEnd;
      const bodyStart = hasNl ? end + 1 : len + 1;
      pos = bodyStart;
      let bodyEnd = bodyStart;
      let hasLines = false;
      let trailingNl = false;
      let closed = false;
      while (pos <= len) {
        if (pos === len) {
          if (len > startPos && buf[len - 1] === 10) trailingNl = true;
          pos = len + 1;
          break;
        }
        const fend = findNl(buf, pos, len);
        const fHasNl = fend < len;
        if (buf[pos] === 96 && isFenceClose(buf, pos, fend)) {
          pos = fHasNl ? fend + 1 : len;
          closed = true;
          break;
        }
        hasLines = true;
        bodyEnd = fend;
        pos = fHasNl ? fend + 1 : len + 1;
      }
      if (closed && pos > len) pos = len;
      mdWriteAscii('<pre><code');
      if (lEnd > lStart) {
        mdWriteAscii(' class="language-');
        mdWriteEscapeSpan(buf, lStart, lEnd);
        mdWriteAscii('"');
      }
      mdWriteAscii('>');
      if (hasLines) {
        mdWriteEscapeSpan(buf, bodyStart, bodyEnd);
        if (mdPos + 1 > mdArena.length) ensureMd(1);
        mdArena[mdPos++] = 10;
      }
      if (trailingNl) {
        if (mdPos + 1 > mdArena.length) ensureMd(1);
        mdArena[mdPos++] = 10;
      }
      mdWriteAscii('</code></pre>\n');
      continue;
    }

    // Heading
    if (c0 === 35 && matchHeading(buf, pos, end)) {
      const depth = _hDepth;
      const hStart = _hStart;
      const hEnd = _hEnd;
      const id = uniqueSlug(slugifyBuf(buf, hStart, hEnd), ids);
      if (mdPos + 12 > mdArena.length) ensureMd(12);
      mdArena[mdPos++] = 60; // <
      mdArena[mdPos++] = 104; // h
      mdArena[mdPos++] = 48 + depth;
      mdWriteAscii(' id="');
      mdWriteAscii(id);
      mdWriteAscii('">');
      const hHtmlStart = mdPos;
      renderInlineToArena(buf, hStart, hEnd, env);
      const hHtmlEnd = mdPos;
      if (mdPos + 6 > mdArena.length) ensureMd(6);
      mdArena[mdPos++] = 60; // <
      mdArena[mdPos++] = 47; // /
      mdArena[mdPos++] = 104; // h
      mdArena[mdPos++] = 48 + depth;
      mdArena[mdPos++] = 62; // >
      mdArena[mdPos++] = 10; // \n
      if (depth === 2 || depth === 3) {
        toc.push({ level: depth, id, htmlStart: hHtmlStart, htmlEnd: hHtmlEnd });
      }
      pos = nextPos;
      continue;
    }

    // HR
    if ((c0 === 45 || c0 === 42) && isHr(buf, pos, end)) {
      mdWriteAscii('<hr>\n');
      pos = nextPos;
      continue;
    }

    // Blockquote
    if (c0 === 62) {
      let lineCount = 0;
      let singleStart = 0;
      let singleEnd = 0;
      let scPos = 0;
      while (pos < len && buf[pos] === 62) {
        const qend = findNl(buf, pos, len);
        const qHasNl = qend < len;
        let qStart = pos + 1;
        if (qStart < qend && buf[qStart] === 32) qStart++;
        trimRange(buf, qStart, qend);
        const curS = _tStart;
        const curE = _tEnd;
        if (curE > curS) {
          if (lineCount === 0) {
            singleStart = curS;
            singleEnd = curE;
            lineCount = 1;
          } else {
            if (lineCount === 1) {
              scPos = scratchAppendTrimmed(0, buf, singleStart, singleEnd);
            }
            if (scPos + 1 > scratchArena.length) ensureScratch(scPos + 1);
            scratchArena[scPos++] = 10;
            scPos = scratchAppendTrimmed(scPos, buf, curS, curE);
            lineCount++;
          }
        }
        pos = qHasNl ? qend + 1 : len;
      }
      if (lineCount === 0) {
        mdWriteAscii('<blockquote>\n</blockquote>\n');
      } else if (lineCount === 1) {
        mdWriteAscii('<blockquote>\n<p>');
        renderInlineToArena(buf, singleStart, singleEnd, env);
        mdWriteAscii('</p>\n</blockquote>\n');
      } else {
        mdWriteAscii('<blockquote>\n<p>');
        renderInlineToArena(scratchArena, 0, scPos, env);
        mdWriteAscii('</p>\n</blockquote>\n');
      }
      continue;
    }

    // Bullet list
    if ((c0 === 45 || c0 === 42) && pos + 1 < end && buf[pos + 1] === 32) {
      mdWriteAscii('<ul>\n');
      trimRange(buf, pos + 2, end);
      let itemStart = _tStart;
      let itemEnd = _tEnd;
      let itemInScratch = false;
      let scPos = 0;
      pos = nextPos;
      while (pos < len) {
        const lend = findNl(buf, pos, len);
        const lHasNl = lend < len;
        const lc0 = pos < lend ? buf[pos] : -1;
        if ((lc0 === 45 || lc0 === 42) && pos + 1 < lend && buf[pos + 1] === 32) {
          mdWriteAscii('<li>');
          if (itemInScratch) renderInlineToArena(scratchArena, 0, scPos, env);
          else renderInlineToArena(buf, itemStart, itemEnd, env);
          mdWriteAscii('</li>\n');
          trimRange(buf, pos + 2, lend);
          itemStart = _tStart;
          itemEnd = _tEnd;
          itemInScratch = false;
          pos = lHasNl ? lend + 1 : len;
        } else if (lc0 === 32 && isContinued(buf, pos, lend)) {
          if (!itemInScratch) {
            scPos = itemEnd - itemStart;
            if (scPos > scratchArena.length) ensureScratch(scPos);
            if (scPos > 0) buf.copy(scratchArena, 0, itemStart, itemEnd);
            itemInScratch = true;
          }
          if (scPos + 1 > scratchArena.length) ensureScratch(scPos + 1);
          scratchArena[scPos++] = 10;
          scPos = scratchAppendTrimmed(scPos, buf, pos, lend);
          pos = lHasNl ? lend + 1 : len;
        } else {
          break;
        }
      }
      mdWriteAscii('<li>');
      if (itemInScratch) renderInlineToArena(scratchArena, 0, scPos, env);
      else renderInlineToArena(buf, itemStart, itemEnd, env);
      mdWriteAscii('</li>\n</ul>\n');
      continue;
    }

    // Ordered list
    if (c0 >= 48 && c0 <= 57) {
      const oStart = matchOrdered(buf, pos, end);
      if (oStart !== -1) {
        let startNum = 0;
        for (let k = pos; k < oStart - 2; k++) startNum = startNum * 10 + (buf[k] - 48);
        if (startNum !== 1) {
          mdWriteAscii('<ol start="');
          mdWriteUint(startNum);
          mdWriteAscii('">\n');
        } else {
          mdWriteAscii('<ol>\n');
        }
        trimRange(buf, oStart, end);
        let itemStart = _tStart;
        let itemEnd = _tEnd;
        let itemInScratch = false;
        let scPos = 0;
        pos = nextPos;
        while (pos < len) {
          const lend = findNl(buf, pos, len);
          const lHasNl = lend < len;
          const lc0 = pos < lend ? buf[pos] : -1;
          if (lc0 >= 48 && lc0 <= 57) {
            const mo = matchOrdered(buf, pos, lend);
            if (mo !== -1) {
              mdWriteAscii('<li>');
              if (itemInScratch) renderInlineToArena(scratchArena, 0, scPos, env);
              else renderInlineToArena(buf, itemStart, itemEnd, env);
              mdWriteAscii('</li>\n');
              trimRange(buf, mo, lend);
              itemStart = _tStart;
              itemEnd = _tEnd;
              itemInScratch = false;
              pos = lHasNl ? lend + 1 : len;
              continue;
            }
          }
          if (lc0 === 32 && isContinued(buf, pos, lend)) {
            if (!itemInScratch) {
              scPos = itemEnd - itemStart;
              if (scPos > scratchArena.length) ensureScratch(scPos);
              if (scPos > 0) buf.copy(scratchArena, 0, itemStart, itemEnd);
              itemInScratch = true;
            }
            if (scPos + 1 > scratchArena.length) ensureScratch(scPos + 1);
            scratchArena[scPos++] = 10;
            scPos = scratchAppendTrimmed(scPos, buf, pos, lend);
            pos = lHasNl ? lend + 1 : len;
          } else {
            break;
          }
        }
        mdWriteAscii('<li>');
        if (itemInScratch) renderInlineToArena(scratchArena, 0, scPos, env);
        else renderInlineToArena(buf, itemStart, itemEnd, env);
        mdWriteAscii('</li>\n</ol>\n');
        continue;
      }
    }

    // Paragraph (contiguous zero-copy fast path + scratch fallback if trimmed multi-line)
    let pStart = pos;
    let pEnd = end;
    while (pStart < pEnd && (buf[pStart] === 32 || buf[pStart] === 9)) pStart++;
    while (pEnd > pStart && (buf[pEnd - 1] === 32 || buf[pEnd - 1] === 9)) pEnd--;
    const contigStart = pStart;
    let contigEnd = pEnd;
    let useScratch = false;
    let scPos = 0;
    const firstHadTrailing = pEnd < end;
    pos = nextPos;

    while (pos < len) {
      const pend = findNl(buf, pos, len);
      const pHasNl = pend < len;
      if (pos === pend) break;
      const pc0 = buf[pos];
      if (pc0 < 128 && PARA_STOP_FIRST[pc0] !== 0) {
        if ((pc0 === 32 || pc0 === 9) && isBlankRange(buf, pos, pend)) break;
        if (pc0 === 96 && parseFenceOpen(buf, pos, pend)) break;
        if (pc0 === 35 && matchHeading(buf, pos, pend)) break;
        if ((pc0 === 45 || pc0 === 42) && isHr(buf, pos, pend)) break;
      }

      const pcLast = buf[pend - 1];
      const needsTrim = pc0 === 32 || pc0 === 9 || pcLast === 32 || pcLast === 9;
      if (!useScratch) {
        if (!firstHadTrailing && !needsTrim) {
          contigEnd = pend;
          pos = pHasNl ? pend + 1 : len;
          continue;
        }
        const firstLen = contigEnd - contigStart;
        if (firstLen > scratchArena.length) ensureScratch(firstLen);
        if (firstLen > 0) buf.copy(scratchArena, 0, contigStart, contigEnd);
        scPos = firstLen;
        useScratch = true;
      }
      if (scPos + 1 > scratchArena.length) ensureScratch(scPos + 1);
      scratchArena[scPos++] = 10;
      scPos = scratchAppendTrimmed(scPos, buf, pos, pend);
      pos = pHasNl ? pend + 1 : len;
    }

    mdWriteAscii('<p>');
    const inlineStart = mdPos;
    if (!useScratch) {
      renderInlineToArena(buf, contigStart, contigEnd, env);
    } else {
      renderInlineToArena(scratchArena, 0, scPos, env);
    }
    const inlineEnd = mdPos;
    mdWriteAscii('</p>\n');
    if (excerptStart === -1) {
      excerptStart = inlineStart;
      excerptEnd = inlineEnd;
    }
  }

  return { htmlStart, htmlEnd: mdPos, toc, excerptStart, excerptEnd };
}

// ---------------------------------------------------------------- Templates & Bytecode VM

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

// Compile-time path lookup helper (object chain, span awareness)
// Path descriptors in VM:
// srcKind: 0 = root property (`_r[rootKey]`), 1 = loop binding slot (`loopSlots[slot]`), 2 = `loop` object (`activeLoopTop`)
// spanKind: 0 = none, 1 = mdArena content (`htmlStart/htmlEnd`), 2 = mdArena excerpt (`excerptStart/excerptEnd`)
const SAFE_STR_PROPS = new Set(['date', 'date_long', 'slug']);
const SAFE_URL_PROPS = new Set(['url', 'newer_url', 'older_url']);
const NUM_PROPS = new Set(['reading_minutes', 'count', 'number', 'total']);

const ROLE_ABSENT = {
  page: new Set(['tag', 'posts', 'pager']),
  index: new Set(['page', 'tag']),
  tag: new Set(['page', 'posts', 'pager']),
  tags: new Set(['page', 'tag', 'posts', 'pager']),
  card: new Set(['page', 'tag', 'posts', 'pager']),
  site: new Set(['page', 'tag', 'posts', 'pager', 'p']),
};
const ROLE_PRESENT_OBJ = {
  page: new Set(['page']),
  index: new Set(['pager']),
  tag: new Set(['tag']),
  tags: new Set(),
  card: new Set(['p']),
  site: new Set(),
};

// VM Opcodes
const OP_BYTES = 1;     // [off, len] -> copy from tplArena
const OP_VAR_ESC = 2;   // [pathId]
const OP_VAR_RAW = 3;   // [pathId]
const OP_IF = 4;        // [pathId, notFlag, elsePc]
const OP_JUMP = 5;      // [targetPc]
const OP_FOR_INIT = 6;  // [pathId, slotIdx, endPc]
const OP_FOR_NEXT = 7;  // [slotIdx, bodyPc]
const OP_CARD_LOOP = 8; // [pathId, cardTplIdx]
const OP_LOOP_PROP = 9; // [propKind] 0=index,1=first,2=last,3=length

// Special sentinel returned by path resolver when value lives in mdArena
const SPAN_SENTINEL = {};
let _spanStart = 0;
let _spanEnd = 0;

function createTemplateEngine(templatesMap, siteGlobals, baseSafe, totalPosts) {
  tplPos = 0;
  cardPos = 0;

  const compiledPrograms = new Map();
  const staticPartials = new Map(); // pKey -> { off, len } inside tplArena
  const freeVarsCache = new Map();
  const cardPrograms = []; // cardTplKey -> { idx, prog }
  const cardProgByName = new Map();
  // Per-post cached card spans [start, end] per cardTplIdx (lazy)
  const cardStarts = [];
  const cardEnds = [];

  const loopElem = new Array(16);
  const loopArr = new Array(16);
  const loopK = new Int32Array(16);
  const loopLen = new Int32Array(16);
  const activeLoopStack = new Int32Array(16);
  let activeLoopTop = -1;

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

  function isSafeNoEscapePath(path) {
    if (path.length < 2) return false;
    const last = path[path.length - 1];
    if (SAFE_STR_PROPS.has(last) || NUM_PROPS.has(last)) return true;
    if (baseSafe && SAFE_URL_PROPS.has(last)) return true;
    return false;
  }

  function compileEntry(name, baseDepth, role) {
    const cacheKey = `${name}@${baseDepth}@${role}`;
    const cached = compiledPrograms.get(cacheKey);
    if (cached !== undefined) return cached;
    const ast = templatesMap.get(name);
    if (ast === undefined) return null;

    const absentRoots = ROLE_ABSENT[role];
    const presentRoots = ROLE_PRESENT_OBJ[role];

    const code = [];
    const paths = [];
    let nextSlot = 0;

    let textRunStart = -1; // inside tplArena
    const startTextRun = () => {
      if (textRunStart === -1) textRunStart = tplPos;
    };
    const appendTextStr = (s) => {
      if (s === '') return;
      startTextRun();
      const len = s.length;
      if (tplPos + len * 3 > tplArena.length) ensureTpl(len * 3);
      tplPos += tplArena.utf8Write(s, tplPos);
    };
    const appendTplBytes = (off, len) => {
      if (len === 0) return;
      startTextRun();
      if (tplPos + len > tplArena.length) ensureTpl(len);
      tplArena.copy(tplArena, tplPos, off, off + len);
      tplPos += len;
    };
    const flushText = () => {
      if (textRunStart !== -1) {
        const len = tplPos - textRunStart;
        if (len > 0) code.push(OP_BYTES, textRunStart, len);
        textRunStart = -1;
      }
    };

    function isShadowed(rootKey, bindings) {
      for (let i = bindings.length - 1; i >= 0; i--) {
        if (bindings[i].name === rootKey) return true;
      }
      return false;
    }

    function tryStaticPath(path, bindings) {
      const rootKey = path[0];
      if (isShadowed(rootKey, bindings)) return null;
      if (rootKey === 'site') {
        return { found: true, val: resolveStaticValue(siteGlobals.site, path, 1) };
      }
      if (absentRoots.has(rootKey)) {
        return { found: true, val: undefined };
      }
      return null;
    }

    function makePathDesc(path, bindings) {
      const rootKey = path[0];
      let srcKind = 0; // root
      let srcId = rootKey;
      for (let i = bindings.length - 1; i >= 0; i--) {
        if (rootKey === 'loop') {
          srcKind = 2;
          srcId = 0;
          break;
        }
        if (bindings[i].name === rootKey) {
          srcKind = 1; // slot
          srcId = bindings[i].slot;
          break;
        }
      }
      const last = path[path.length - 1];
      let spanKind = 0; // 1: htmlStart/End, 2: excerptStart/End
      if (path.length >= 2) {
        if (last === 'content' || last === 'html') spanKind = 1;
        else if (last === 'excerpt') spanKind = 2;
      }
      const id = paths.length;
      paths.push({ srcKind, srcId, segs: path, len: path.length, spanKind });
      return id;
    }

    function isSiteOnlyInclude(incName, depth, bindings) {
      if (depth > INCLUDE_DEPTH || !templatesMap.has(incName)) return false;
      const free = getFreeVars(incName, depth);
      for (const k of free) {
        if (k === 'site' || k === 'tags' || k === 'recent') continue;
        if (!isShadowed(k, bindings) && absentRoots.has(k)) continue;
        return false;
      }
      return true;
    }

    function getCardIdx(incName, incDepth) {
      const ck = `${incName}@${incDepth}`;
      let idx = cardProgByName.get(ck);
      if (idx === undefined) {
        idx = cardPrograms.length;
        cardProgByName.set(ck, idx);
        const prog = compileEntry(incName, incDepth, 'card');
        cardPrograms.push(prog);
        cardStarts.push(new Int32Array(totalPosts).fill(-1));
        cardEnds.push(new Int32Array(totalPosts));
      }
      return idx;
    }

    function emitNodes(nodes, bindings, depth) {
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        switch (n.kind) {
          case 'text':
            appendTextStr(n.text);
            break;
          case 'var':
          case 'raw': {
            const st = tryStaticPath(n.path, bindings);
            if (st !== null) {
              const s = textOf(st.val);
              appendTextStr(n.kind === 'var' ? escapeHtml(s) : s);
              break;
            }
            flushText();
            if (n.path[0] === 'loop' && n.path.length === 2 && bindings.length > 0) {
              const p1 = n.path[1];
              if (p1 === 'index') { code.push(OP_LOOP_PROP, 0); break; }
              if (p1 === 'first') { code.push(OP_LOOP_PROP, 1); break; }
              if (p1 === 'last') { code.push(OP_LOOP_PROP, 2); break; }
              if (p1 === 'length') { code.push(OP_LOOP_PROP, 3); break; }
            }
            const pid = makePathDesc(n.path, bindings);
            if (n.kind === 'raw' || isSafeNoEscapePath(n.path)) {
              code.push(OP_VAR_RAW, pid);
            } else {
              code.push(OP_VAR_ESC, pid);
            }
            break;
          }
          case 'if': {
            const st = tryStaticPath(n.path, bindings);
            if (st !== null) {
              const v = st.val;
              const truth = Array.isArray(v) ? v.length > 0 : (v !== undefined && v !== null && v !== false && v !== '' && v !== 0);
              const branch = truth !== n.not ? n.then : n.else;
              if (branch !== null) emitNodes(branch, bindings, depth);
              break;
            }
            if (n.path.length === 1 && !isShadowed(n.path[0], bindings) && presentRoots.has(n.path[0])) {
              const branch = !n.not ? n.then : n.else;
              if (branch !== null) emitNodes(branch, bindings, depth);
              break;
            }
            flushText();
            const pid = makePathDesc(n.path, bindings);
            const ifIdx = code.length;
            code.push(OP_IF, pid, n.not ? 1 : 0, 0);
            emitNodes(n.then, bindings, depth);
            flushText();
            if (n.else !== null) {
              const jmpIdx = code.length;
              code.push(OP_JUMP, 0);
              code[ifIdx + 3] = code.length;
              emitNodes(n.else, bindings, depth);
              flushText();
              code[jmpIdx + 1] = code.length;
            } else {
              code[ifIdx + 3] = code.length;
            }
            break;
          }
          case 'for': {
            const st = tryStaticPath(n.path, bindings);
            if (st !== null && !Array.isArray(st.val)) break;
            flushText();
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
                  const pid = makePathDesc(n.path, bindings);
                  const cIdx = getCardIdx(incName, depth + 1);
                  code.push(OP_CARD_LOOP, pid, cIdx);
                  break;
                }
              }
            }
            const pid = makePathDesc(n.path, bindings);
            const slot = nextSlot++;
            const initIdx = code.length;
            code.push(OP_FOR_INIT, pid, slot, 0);
            const bodyPc = code.length;
            bindings.push({ name: n.name, slot });
            emitNodes(n.body, bindings, depth);
            flushText();
            bindings.pop();
            code.push(OP_FOR_NEXT, slot, bodyPc);
            code[initIdx + 3] = code.length;
            break;
          }
          case 'include': {
            const inc = templatesMap.get(n.name);
            if (inc !== undefined && depth < INCLUDE_DEPTH) {
              const shadowed = isShadowed('site', bindings) || isShadowed('tags', bindings) || isShadowed('recent', bindings);
              if (!shadowed && isSiteOnlyInclude(n.name, depth + 1, bindings)) {
                const pKey = `${n.name}@${depth + 1}@${role}`;
                let slice = staticPartials.get(pKey);
                if (slice === undefined) {
                  flushText();
                  const subProg = compileEntry(n.name, depth + 1, role);
                  const savedBuf = vmBuf;
                  const savedPos = vmPos;
                  const savedIsCard = vmIsCard;
                  const baseOut = outPos;
                  vmBuf = outArena;
                  vmPos = baseOut;
                  vmIsCard = false;
                  execProg(subProg, siteGlobals);
                  const len = vmPos - baseOut;
                  const tOff = tplPos;
                  if (len > 0) {
                    if (tplPos + len > tplArena.length) ensureTpl(len);
                    outArena.copy(tplArena, tOff, baseOut, vmPos);
                    tplPos += len;
                    textRunStart = tOff;
                  }
                  outPos = baseOut;
                  vmBuf = savedBuf;
                  vmPos = savedPos;
                  vmIsCard = savedIsCard;
                  slice = { off: tOff, len };
                  staticPartials.set(pKey, slice);
                } else {
                  appendTplBytes(slice.off, slice.len);
                }
              } else {
                flushText();
                emitNodes(inc, bindings, depth + 1);
              }
            }
            break;
          }
        }
      }
    }

    emitNodes(ast, [], baseDepth);
    flushText();
    const prog = { ops: Int32Array.from(code), paths };
    compiledPrograms.set(cacheKey, prog);
    return prog;
  }

  function resolvePath(desc, vars) {
    const segs = desc.segs;
    const slen = desc.len;
    let cur;
    if (desc.srcKind === 1) {
      cur = loopElem[desc.srcId];
    } else if (desc.srcKind === 0) {
      const k = segs[0];
      cur = Object.hasOwn(vars, k) ? vars[k] : undefined;
    } else {
      if (activeLoopTop < 0) cur = undefined;
      else {
        const s = activeLoopStack[activeLoopTop];
        cur = {
          index: loopK[s] + 1,
          first: loopK[s] === 0,
          last: loopK[s] === loopLen[s] - 1,
          length: loopLen[s],
        };
      }
    }

    if (slen === 1) return cur;

    const lastIdx = slen - 1;
    for (let i = 1; i < lastIdx; i++) {
      if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
      const seg = segs[i];
      cur = Object.hasOwn(cur, seg) ? cur[seg] : undefined;
    }

    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    const lastSeg = segs[lastIdx];

    if (desc.spanKind !== 0) {
      if (desc.spanKind === 1) {
        if (cur._htmlEnd !== undefined) {
          _spanStart = cur._htmlStart;
          _spanEnd = cur._htmlEnd;
          return SPAN_SENTINEL;
        }
      } else {
        if (cur._excerptEnd !== undefined) {
          _spanStart = cur._excerptStart;
          _spanEnd = cur._excerptEnd;
          return SPAN_SENTINEL;
        }
      }
    }

    return Object.hasOwn(cur, lastSeg) ? cur[lastSeg] : undefined;
  }

  const cardVars = { site: siteGlobals.site, tags: siteGlobals.tags, recent: siteGlobals.recent, p: null };

  function execProg(prog, vars) {
    const ops = prog.ops;
    const opsLen = ops.length;
    const paths = prog.paths;
    let pc = 0;

    while (pc < opsLen) {
      const op = ops[pc++];
      switch (op) {
        case OP_BYTES: {
          const off = ops[pc++];
          const len = ops[pc++];
          vmWriteBytes(tplArena, off, off + len);
          break;
        }
        case OP_VAR_ESC: {
          const v = resolvePath(paths[ops[pc++]], vars);
          if (v === SPAN_SENTINEL) {
            if (_spanEnd > _spanStart) vmWriteEscapeSpan(mdArena, _spanStart, _spanEnd);
          } else if (typeof v === 'string') {
            vmWriteStrEscaped(v);
          } else if (typeof v === 'number') {
            vmWriteInt(v);
          } else if (typeof v === 'boolean') {
            vmWriteStrRaw(v ? 'true' : 'false');
          } else if (Array.isArray(v)) {
            vmWriteStrEscaped(textOf(v));
          }
          break;
        }
        case OP_VAR_RAW: {
          const v = resolvePath(paths[ops[pc++]], vars);
          if (v === SPAN_SENTINEL) {
            if (_spanEnd > _spanStart) vmWriteBytes(mdArena, _spanStart, _spanEnd);
          } else if (typeof v === 'string') {
            vmWriteStrRaw(v);
          } else if (typeof v === 'number') {
            vmWriteInt(v);
          } else if (typeof v === 'boolean') {
            vmWriteStrRaw(v ? 'true' : 'false');
          } else if (Array.isArray(v)) {
            vmWriteStrRaw(textOf(v));
          }
          break;
        }
        case OP_LOOP_PROP: {
          const pk = ops[pc++];
          const s = activeLoopStack[activeLoopTop];
          if (pk === 0) vmWriteInt(loopK[s] + 1);
          else if (pk === 1) vmWriteStrRaw(loopK[s] === 0 ? 'true' : 'false');
          else if (pk === 2) vmWriteStrRaw(loopK[s] === loopLen[s] - 1 ? 'true' : 'false');
          else vmWriteInt(loopLen[s]);
          break;
        }
        case OP_IF: {
          const v = resolvePath(paths[ops[pc++]], vars);
          const notF = ops[pc++] !== 0;
          const elsePc = ops[pc++];
          let truth;
          if (v === SPAN_SENTINEL) {
            truth = _spanEnd > _spanStart;
          } else if (Array.isArray(v)) {
            truth = v.length > 0;
          } else {
            truth = v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
          }
          if (truth === notF) pc = elsePc;
          break;
        }
        case OP_JUMP: {
          pc = ops[pc];
          break;
        }
        case OP_FOR_INIT: {
          const arr = resolvePath(paths[ops[pc++]], vars);
          const slot = ops[pc++];
          const endPc = ops[pc++];
          if (!Array.isArray(arr) || arr.length === 0) {
            pc = endPc;
          } else {
            loopArr[slot] = arr;
            loopLen[slot] = arr.length;
            loopK[slot] = 0;
            loopElem[slot] = arr[0];
            activeLoopStack[++activeLoopTop] = slot;
          }
          break;
        }
        case OP_FOR_NEXT: {
          const slot = ops[pc++];
          const bodyPc = ops[pc++];
          const nk = loopK[slot] + 1;
          if (nk < loopLen[slot]) {
            loopK[slot] = nk;
            loopElem[slot] = loopArr[slot][nk];
            pc = bodyPc;
          } else {
            activeLoopTop--;
          }
          break;
        }
        case OP_CARD_LOOP: {
          const arr = resolvePath(paths[ops[pc++]], vars);
          const cIdx = ops[pc++];
          if (Array.isArray(arr) && arr.length > 0) {
            const cStarts = cardStarts[cIdx];
            const cEnds = cardEnds[cIdx];
            const cProg = cardPrograms[cIdx];
            for (let j = 0; j < arr.length; j++) {
              const p = arr[j];
              const pId = p._postId;
              if (pId !== undefined) {
                let cs = cStarts[pId];
                let ce;
                if (cs === -1) {
                  const savedBuf = vmBuf;
                  const savedPos = vmPos;
                  const savedIsCard = vmIsCard;
                  const savedLoopTop = activeLoopTop;
                  cs = cardPos;
                  vmBuf = cardArena;
                  vmPos = cs;
                  vmIsCard = true;
                  activeLoopTop = -1;
                  cardVars.p = p;
                  execProg(cProg, cardVars);
                  ce = vmPos;
                  cardPos = ce;
                  vmBuf = savedBuf;
                  vmPos = savedPos;
                  vmIsCard = savedIsCard;
                  activeLoopTop = savedLoopTop;
                  cStarts[pId] = cs;
                  cEnds[pId] = ce;
                } else {
                  ce = cEnds[pId];
                }
                vmWriteBytes(cardArena, cs, ce);
              } else {
                // Edge fallback if non-post array used in `for p in ...` + card include
                const savedTop = activeLoopTop;
                activeLoopTop = -1;
                cardVars.p = p;
                execProg(cProg, cardVars);
                activeLoopTop = savedTop;
              }
            }
          }
          break;
        }
      }
    }
  }

  function renderToOutArena(prog, vars) {
    const start = outPos;
    vmBuf = outArena;
    vmPos = start;
    vmIsCard = false;
    activeLoopTop = -1;
    execProg(prog, vars);
    outPos = vmPos;
    return start;
  }

  return { compileEntry, renderToOutArena };
}

// ---------------------------------------------------------------- Site Builder Core

function buildSiteCore(input, emitPage, emitStatic) {
  srcPos = 0;
  mdPos = 0;
  outPos = 0;

  const { slugifyStr, slugifyBuf } = createSlugifier();

  // 1. Parse templates
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

  // 2. Sort files by path in code-unit order, split & ingest .md into srcArena
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f.path.endsWith('.md')) {
      const content = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      const sStart = srcPos;
      ensureSrc(content.length * 3 + 16);
      const nb = srcArena.utf8Write(content, sStart);
      const sEnd = sStart + nb;
      srcPos = sEnd;
      sources.push({ path: f.path, sStart, sEnd });
    } else {
      statics.push(f);
    }
  }

  // 3. Front matter & refusals/drafts
  const kept = [];
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const fm = parseFrontMatterBytes(srcArena, s.sStart, s.sEnd);
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
    s.bodyStart = fm.bodyStart;
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
    const slug = uniqueSlug(s.data.slug ?? slugifyStr(s.data.title), tSet);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 5. Markdown -> mdArena
  const staticPaths = new Set();
  for (let i = 0; i < statics.length; i++) staticPaths.add(statics[i].path);
  const broken = new Set();
  const resolveDirCaches = new Map();
  const extEscCache = new Map();
  const dirEscLinkCaches = new Map();

  linkPos = 0;

  const allocLinkSlice = (str) => {
    const maxB = str.length * 3;
    ensureLink(maxB);
    const off = linkPos;
    const nb = linkArena.utf8Write(str, off);
    linkPos = off + nb;
    ensureMd(nb + 4096);
    return off * 65536 + nb;
  };

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
      writeEscapedLink(buf, start, end) {
        const target = buf.toString('utf8', start, end);
        let packed = dirEscCache.get(target);
        if (packed !== undefined) {
          const lLen = packed & 65535;
          const lOff = (packed - lLen) / 65536;
          mdCopySpan(linkArena, lOff, lOff + lLen);
          return;
        }

        const c0 = target.charCodeAt(0);
        if (c0 === 47 || c0 === 35 || hasUrlScheme(target)) {
          let pExt = extEscCache.get(target);
          if (pExt === undefined) {
            pExt = allocLinkSlice(escapeHtml(target));
            extEscCache.set(target, pExt);
          }
          dirEscCache.set(target, pExt);
          const lLen = pExt & 65535;
          const lOff = (pExt - lLen) / 65536;
          mdCopySpan(linkArena, lOff, lOff + lLen);
          return;
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
            const pRel = allocLinkSlice(escapeHtml(frag === '' ? resolvedUrl : `${resolvedUrl}${frag}`));
            dirEscCache.set(target, pRel);
            const lLen = pRel & 65535;
            const lOff = (pRel - lLen) / 65536;
            mdCopySpan(linkArena, lOff, lOff + lLen);
            return;
          }
        }
        broken.add(`broken-link ${s.path} -> ${target}`);
        let pExt = extEscCache.get(target);
        if (pExt === undefined) {
          pExt = allocLinkSlice(escapeHtml(target));
          extEscCache.set(target, pExt);
        }
        const lLen = pExt & 65535;
        const lOff = (pExt - lLen) / 65536;
        mdCopySpan(linkArena, lOff, lOff + lLen);
      },
    };
    const md = renderMarkdownToArena(srcArena, s.bodyStart, s.sEnd, env, slugifyBuf);
    s.htmlStart = md.htmlStart;
    s.htmlEnd = md.htmlEnd;
    s.toc = md.toc;
    s.excerptStart = md.excerptStart === -1 ? 0 : md.excerptStart;
    s.excerptEnd = md.excerptEnd === -1 ? 0 : md.excerptEnd;
  }

  // Wrap ToC items with _htmlStart/_htmlEnd for uniform resolvePath span access
  for (let i = 0; i < kept.length; i++) {
    const toc = kept[i].toc;
    for (let j = 0; j < toc.length; j++) {
      const h = toc[j];
      h._htmlStart = h.htmlStart;
      h._htmlEnd = h.htmlEnd;
    }
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
        const slug = slugifyStr(name);
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
        const slug = slugifyStr(name);
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

  const cardOf = (s, postId) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: fmtDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: '',
    reading_minutes: Math.max(1, Math.ceil(countWordsBytes(srcArena, s.bodyStart, s.sEnd) / 200)),
    tags: s.tagRefs,
    _excerptStart: s.excerptStart,
    _excerptEnd: s.excerptEnd,
    _postId: postId,
  });

  const postCards = new Array(posts.length);
  for (let i = 0; i < posts.length; i++) {
    const c = cardOf(posts[i], i);
    posts[i]._card = c;
    postCards[i] = c;
  }

  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recentCount = Math.min(input.site.recent, posts.length);
  const recent = new Array(recentCount);
  for (let i = 0; i < recentCount; i++) recent[i] = postCards[i];

  const baseSafe = escapeHtml(base) === base;
  const siteGlobals = { site, tags: allTags, recent };
  const engine = createTemplateEngine(templates, siteGlobals, baseSafe, posts.length);

  const builtSet = new Set();
  const reusePage = {
    title: '',
    url: '',
    date: '',
    date_long: '',
    summary: '',
    excerpt: '',
    reading_minutes: 1,
    tags: null,
    slug: '',
    content: '',
    toc: null,
    newer: null,
    older: null,
    is_post: false,
    _htmlStart: 0,
    _htmlEnd: 0,
    _excerptStart: 0,
    _excerptEnd: 0,
  };
  const pageVars = { site, tags: allTags, recent, page: reusePage };

  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const prog = engine.compileEntry(s.layout, 0, 'page');
    const c = s.post ? s._card : cardOf(s, undefined);
    reusePage.title = c.title;
    reusePage.url = c.url;
    reusePage.date = c.date;
    reusePage.date_long = c.date_long;
    reusePage.summary = c.summary;
    reusePage.reading_minutes = c.reading_minutes;
    reusePage.tags = c.tags;
    reusePage.slug = s.slug;
    reusePage.toc = s.toc;
    reusePage.newer = linkOf(s.newer ?? null);
    reusePage.older = linkOf(s.older ?? null);
    reusePage.is_post = s.post;
    reusePage._htmlStart = s.htmlStart;
    reusePage._htmlEnd = s.htmlEnd;
    reusePage._excerptStart = s.excerptStart;
    reusePage._excerptEnd = s.excerptEnd;
    const pStart = engine.renderToOutArena(prog, pageVars);
    const outPath = `${s.outDir}/index.html`;
    builtSet.add(outPath);
    emitPage(outPath, pStart, outPos);
  }

  const indexProg = engine.compileEntry('index', 0, 'index');
  if (indexProg !== null) {
    const per = input.site.per_page;
    const pages = Math.max(1, Math.ceil(posts.length / per));
    const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
    const reusePager = { number: 1, total: pages, url: '', newer_url: '', older_url: '' };
    const indexVars = { site, tags: allTags, recent, posts: null, pager: reusePager };
    for (let k = 1; k <= pages; k++) {
      const start = (k - 1) * per;
      const end = Math.min(k * per, posts.length);
      const pagePosts = new Array(Math.max(0, end - start));
      for (let j = start; j < end; j++) pagePosts[j - start] = postCards[j];
      reusePager.number = k;
      reusePager.url = indexUrl(k);
      reusePager.newer_url = k === 1 ? '' : indexUrl(k - 1);
      reusePager.older_url = k === pages ? '' : indexUrl(k + 1);
      indexVars.posts = pagePosts;
      const pStart = engine.renderToOutArena(indexProg, indexVars);
      const outPath = k === 1 ? 'index.html' : `page/${k}/index.html`;
      builtSet.add(outPath);
      emitPage(outPath, pStart, outPos);
    }
  }

  const tagProg = engine.compileEntry('tag', 0, 'tag');
  if (tagProg !== null) {
    const reuseTag = { name: '', slug: '', url: '', count: 0, posts: null };
    const tagVars = { site, tags: allTags, recent, tag: reuseTag };
    for (let i = 0; i < tags.length; i++) {
      const t = tags[i];
      const tPosts = new Array(t.posts.length);
      for (let j = 0; j < t.posts.length; j++) tPosts[j] = t.posts[j]._card;
      reuseTag.name = t.name;
      reuseTag.slug = t.slug;
      reuseTag.url = t.url;
      reuseTag.count = t.posts.length;
      reuseTag.posts = tPosts;
      const pStart = engine.renderToOutArena(tagProg, tagVars);
      const outPath = `tags/${t.slug}/index.html`;
      builtSet.add(outPath);
      emitPage(outPath, pStart, outPos);
    }
  }

  const tagsProg = engine.compileEntry('tags', 0, 'tags');
  if (tagsProg !== null) {
    const pStart = engine.renderToOutArena(tagsProg, { site, tags: allTags, recent });
    builtSet.add('tags/index.html');
    emitPage('tags/index.html', pStart, outPos);
  }

  for (let i = 0; i < statics.length; i++) {
    const f = statics[i];
    if (builtSet.has(f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else emitStatic(f.path, f.content);
  }

  // 9. Report
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.length - posts.length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  emitStatic(REPORT_FILE, `${lines.join('\n')}\n`);
}

// ---------------------------------------------------------------- JSON Arena Escaper

function jsonWriteAscii(str) {
  const len = str.length;
  if (jsonPos + len > jsonArena.length) ensureJson(len);
  const dst = jsonArena;
  let p = jsonPos;
  for (let i = 0; i < len; i++) dst[p++] = str.charCodeAt(i);
  jsonPos = p;
}

function jsonWriteQuotedBytes(src, start, end) {
  const len = end - start;
  if (jsonPos + len * 6 + 2 > jsonArena.length) ensureJson(len * 6 + 2);
  const dst = jsonArena;
  let p = jsonPos;
  dst[p++] = 34; // "
  let i = start;

  // Fast 4-byte aligned SWAR scan when src is outArena (4-byte aligned backing)
  if (len >= 16 && src === outArena) {
    while (i < end && (i & 3) !== 0) {
      const c = src[i++];
      if (JSON_SPECIAL[c] !== 0) {
        if (c === 34) { dst[p++] = 92; dst[p++] = 34; }
        else if (c === 92) { dst[p++] = 92; dst[p++] = 92; }
        else if (c === 10) { dst[p++] = 92; dst[p++] = 110; }
        else if (c === 13) { dst[p++] = 92; dst[p++] = 114; }
        else if (c === 9) { dst[p++] = 92; dst[p++] = 116; }
        else if (c === 8) { dst[p++] = 92; dst[p++] = 98; }
        else if (c === 12) { dst[p++] = 92; dst[p++] = 102; }
        else {
          dst[p++] = 92; dst[p++] = 117; dst[p++] = 48; dst[p++] = 48;
          dst[p++] = HEX_LO.charCodeAt(c >> 4);
          dst[p++] = HEX_LO.charCodeAt(c & 15);
        }
      } else {
        dst[p++] = c;
      }
    }
    const u32 = outU32;
    let wi = i >>> 2;
    const wEnd = end >>> 2;
    while (wi < wEnd) {
      const w = u32[wi];
      const lt32 = ~((w & 0x7f7f7f7f) + 0x60606060) & ~w & 0x80808080;
      const xq = w ^ 0x22222222;
      const eq34 = (xq - 0x01010101) & ~xq & 0x80808080;
      const xb = w ^ 0x5c5c5c5c;
      const eq92 = (xb - 0x01010101) & ~xb & 0x80808080;
      if ((lt32 | eq34 | eq92) === 0) {
        dst[p] = w & 255;
        dst[p + 1] = (w >>> 8) & 255;
        dst[p + 2] = (w >>> 16) & 255;
        dst[p + 3] = w >>> 24;
        p += 4;
        wi++;
      } else {
        const j = wi << 2;
        for (let k = 0; k < 4; k++) {
          const c = src[j + k];
          if (JSON_SPECIAL[c] !== 0) {
            if (c === 34) { dst[p++] = 92; dst[p++] = 34; }
            else if (c === 92) { dst[p++] = 92; dst[p++] = 92; }
            else if (c === 10) { dst[p++] = 92; dst[p++] = 110; }
            else if (c === 13) { dst[p++] = 92; dst[p++] = 114; }
            else if (c === 9) { dst[p++] = 92; dst[p++] = 116; }
            else if (c === 8) { dst[p++] = 92; dst[p++] = 98; }
            else if (c === 12) { dst[p++] = 92; dst[p++] = 102; }
            else {
              dst[p++] = 92; dst[p++] = 117; dst[p++] = 48; dst[p++] = 48;
              dst[p++] = HEX_LO.charCodeAt(c >> 4);
              dst[p++] = HEX_LO.charCodeAt(c & 15);
            }
          } else {
            dst[p++] = c;
          }
        }
        wi++;
      }
    }
    i = wEnd << 2;
  }

  while (i < end) {
    const c = src[i++];
    if (JSON_SPECIAL[c] !== 0) {
      if (c === 34) { dst[p++] = 92; dst[p++] = 34; }
      else if (c === 92) { dst[p++] = 92; dst[p++] = 92; }
      else if (c === 10) { dst[p++] = 92; dst[p++] = 110; }
      else if (c === 13) { dst[p++] = 92; dst[p++] = 114; }
      else if (c === 9) { dst[p++] = 92; dst[p++] = 116; }
      else if (c === 8) { dst[p++] = 92; dst[p++] = 98; }
      else if (c === 12) { dst[p++] = 92; dst[p++] = 102; }
      else {
        dst[p++] = 92; dst[p++] = 117; dst[p++] = 48; dst[p++] = 48;
        dst[p++] = HEX_LO.charCodeAt(c >> 4);
        dst[p++] = HEX_LO.charCodeAt(c & 15);
      }
    } else {
      dst[p++] = c;
    }
  }
  dst[p++] = 34; // "
  jsonPos = p;
}

function jsonWriteQuotedStr(str) {
  const nb = Buffer.byteLength(str);
  ensureScratch(nb);
  scratchArena.utf8Write(str, 0);
  jsonWriteQuotedBytes(scratchArena, 0, nb);
}

// ---------------------------------------------------------------- Exports

export function run(input) {
  const output = {};
  buildSiteCore(
    input,
    (path, start, end) => {
      output[path] = outArena.toString('utf8', start, end);
    },
    (path, str) => {
      output[path] = str;
    },
  );
  return output;
}

export function runCasesToBuffer(cases) {
  jsonPos = 0;
  if (jsonArena.length < 2) ensureJson(2);
  jsonArena[jsonPos++] = 91; // [
  for (let i = 0; i < cases.length; i++) {
    if (i > 0) {
      if (jsonPos + 1 > jsonArena.length) ensureJson(1);
      jsonArena[jsonPos++] = 44; // ,
    }
    if (jsonPos + 1 > jsonArena.length) ensureJson(1);
    jsonArena[jsonPos++] = 123; // {
    let firstProp = true;
    buildSiteCore(
      cases[i].input,
      (path, start, end) => {
        if (!firstProp) {
          if (jsonPos + 1 > jsonArena.length) ensureJson(1);
          jsonArena[jsonPos++] = 44;
        }
        firstProp = false;
        jsonWriteQuotedStr(path);
        if (jsonPos + 1 > jsonArena.length) ensureJson(1);
        jsonArena[jsonPos++] = 58; // :
        jsonWriteQuotedBytes(outArena, start, end);
      },
      (path, str) => {
        if (!firstProp) {
          if (jsonPos + 1 > jsonArena.length) ensureJson(1);
          jsonArena[jsonPos++] = 44;
        }
        firstProp = false;
        jsonWriteQuotedStr(path);
        if (jsonPos + 1 > jsonArena.length) ensureJson(1);
        jsonArena[jsonPos++] = 58; // :
        jsonWriteQuotedStr(str);
      },
    );
    if (jsonPos + 1 > jsonArena.length) ensureJson(1);
    jsonArena[jsonPos++] = 125; // }
  }
  if (jsonPos + 1 > jsonArena.length) ensureJson(1);
  jsonArena[jsonPos++] = 93; // ]
  return jsonArena.subarray(0, jsonPos);
}
