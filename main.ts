// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

/** An edit: applied to the tree, it returns the move it made, if it moved a file. */
type Edit = (tree: Tree) => { old: string; new: string } | void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

let STRICT = false;

/** A file split into lines: its line break, its lines, and whether it ends with one (SPEC.md section 3). */
interface FileState {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}

function joinFile(st: FileState): string {
  if (st.lines.length === 0) return '';
  return st.lines.join(st.br) + (st.final ? st.br : '');
}

function stateOf(tree: Tree, p: string): FileState | null {
  const t = tree.get(p);
  return t === null ? null : splitFile(t);
}

/** One line of a patch body: ctx marks a context line, present in both O and N. */
interface PatchLine {
  ctx: boolean;
  text: string;
  raw: string;
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  const t = s.replace(/[ \t]+$/, '');
  return tier === 1 ? t : t.replace(/^[ \t]+/, '');
}

function matchAt(o: string[], f: string[], i: number, tier: number): boolean {
  for (let j = 0; j < o.length; j++) {
    if (normLine(o[j]!, tier) !== normLine(f[i + j]!, tier)) return false;
  }
  return true;
}

/** The first tier at which O occurs in F (at or after `from`), with every position there, or null. */
function occurrencesAt(o: string[], f: string[], from: number): { tier: number; pos: number[] } | null {
  const tiers = STRICT ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos: number[] = [];
    for (let i = from; i + o.length <= f.length; i++) {
      if (matchAt(o, f, i, t)) pos.push(i);
    }
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** The first line at or after `from` equal to a single line, at the first tier with one, or null. */
function anchorAt(anchor: string, f: string[], from: number): number | null {
  const tiers = STRICT ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < f.length; i++) {
      if (normLine(anchor, t) === normLine(f[i]!, t)) return i;
    }
  }
  return null;
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function reindent(line: string, p: string, f: string): string {
  if (line === '' || line.trim() === '') return line;
  if (!line.startsWith(p)) return line;
  return f + line.slice(p.length);
}

/**
 * The lines that replace a matched run: a context line is the file's own matched line, every other
 * line of N is re-indented at tier 2 (SPEC.md section 5).
 */
function replacement(oItems: PatchLine[], nItems: PatchLine[], fileLines: string[], at: number, tier: number): string[] {
  const oCtx: number[] = [];
  oItems.forEach((it, idx) => {
    if (it.ctx) oCtx.push(idx);
  });
  let seen = 0;
  const f = tier === 2 && oItems.length > 0 ? leadingWs(fileLines[at] ?? '') : '';
  const p = tier === 2 && oItems.length > 0 ? leadingWs(oItems[0]!.text) : '';
  const out: string[] = [];
  for (const it of nItems) {
    if (it.ctx) {
      out.push(fileLines[at + oCtx[seen]!]!);
      seen += 1;
    } else if (tier === 2) {
      out.push(reindent(it.text, p, f));
    } else {
      out.push(it.text);
    }
  }
  return out;
}

/** Apply a section's hunks in order to a file's lines (SPEC.md section 6). */
function applyHunks(st: FileState, hunks: Hunk[], path: string): void {
  let d = 0;
  for (const h of hunks) {
    const oItems = h.items.filter((it) => it.ctx || it.raw.startsWith('-'));
    const nItems = h.items.filter((it) => it.ctx || it.raw.startsWith('+'));
    const o = oItems.map((it) => it.text);
    if (o.length > 0) {
      const found = occurrencesAt(o, st.lines, 0);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.pos[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.pos) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const repl = replacement(oItems, nItems, st.lines, best, found.tier);
      const toEnd = best + o.length === st.lines.length;
      st.lines.splice(best, o.length, ...repl);
      if (toEnd) st.final = !h.noBreak;
    } else {
      const at = Math.max(0, Math.min(h.a + d, st.lines.length));
      const atEnd = at === st.lines.length;
      st.lines.splice(at, 0, ...nItems.map((it) => it.text));
      if (atEnd) st.final = !h.noBreak;
    }
    d += nItems.length - oItems.length;
  }
}

interface Hunk {
  a: number;
  items: PatchLine[];
  noBreak: boolean;
}

interface USection {
  diffOld: string;
  diffNew: string;
  hdrOld: string | null;
  hdrNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@( .*)?$/;
const DIFF_RE = /^diff --git a\/(\S+) b\/(\S+)[ \t]*$/;

/** The path after `--- ` or `+++ `: up to the first tab, surrounding spaces removed, a/ or b/ stripped. */
function sectionPath(line: string): string {
  const p = line.slice(4).split('\t')[0]!.trim();
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

function unifiedEdits(lines: string[]): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { diffOld: m[1]!, diffNew: m[2]!, hdrOld: null, hdrNew: null, renameFrom: null, renameTo: null, newFile: false, delFile: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (m === null || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const items: PatchLine[] = [];
      i += 1;
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
          const kind = b === '' || b.startsWith(' ') ? ' ' : b[0]!;
          items.push({ ctx: kind === ' ', text: kind === ' ' ? b.slice(b === '' ? 0 : 1) : b.slice(1), raw: b });
          i += 1;
        } else break;
      }
      while (items.length > 0 && items[items.length - 1]!.raw === '') items.pop();
      let noBreak = false;
      for (let k = items.length - 1; k >= 0; k--) {
        const it = items[k]!;
        if (it.ctx || it.raw.startsWith('+')) {
          noBreak = k + 1 < items.length && items[k + 1]!.raw.startsWith('\\');
          break;
        }
      }
      cur.hunks.push({ a: Number(m[1]), items, noBreak });
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || !inHeader) {
        cur = { diffOld: sectionPath(line), diffNew: sectionPath(lines[i + 1]!), hdrOld: sectionPath(line), hdrNew: sectionPath(lines[i + 1]!), renameFrom: null, renameTo: null, newFile: false, delFile: false, hunks: [] };
        sections.push(cur);
      } else {
        cur.hdrOld = sectionPath(line);
        cur.hdrNew = sectionPath(lines[i + 1]!);
      }
      inHeader = true;
      i += 2;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ')) {
        cur.hdrNew = sectionPath(line);
        i += 1;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.newFile = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.delFile = true;
        i += 1;
        continue;
      }
    }
    i += 1;
  }
  return sections.map((s) => unifiedSectionEdit(s));
}

function unifiedSectionEdit(s: USection): Edit {
  const oldP = s.hdrOld ?? s.renameFrom ?? s.diffOld;
  const newP = s.hdrNew ?? s.renameTo ?? s.diffNew;
  const create = oldP === '/dev/null' || s.newFile;
  const del = !create && (newP === '/dev/null' || s.delFile);
  if (create) {
    return (tree) => {
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let noBreak = false;
      for (const h of s.hunks) {
        let lastPlus = -1;
        for (let k = 0; k < h.items.length; k++) {
          if (h.items[k]!.raw.startsWith('+')) lastPlus = k;
        }
        if (lastPlus >= 0) noBreak = lastPlus + 1 < h.items.length && h.items[lastPlus + 1]!.raw.startsWith('\\');
        for (const it of h.items) if (it.raw.startsWith('+')) plus.push(it.text);
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (noBreak ? '' : '\n'));
    };
  }
  if (del) {
    return (tree) => {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
    };
  }
  const move = oldP !== newP;
  return (tree) => {
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    if (move && !safe(newP)) throw new Fail('unsafe', newP);
    const cur = tree.get(oldP);
    if (cur === null) throw new Fail('missing', oldP);
    if (move && tree.get(newP) !== null) throw new Fail('exists', newP);
    const st = splitFile(cur);
    applyHunks(st, s.hunks, oldP);
    const text = joinFile(st);
    if (move) {
      tree.now.set(newP, text);
      tree.now.set(oldP, null);
      return { old: oldP, new: newP };
    }
    tree.now.set(oldP, text);
  };
}

/** One SEARCH/REPLACE block (SPEC.md section 7). */
function srEdit(path: string, oldLines: string[], newLines: string[]): Edit {
  const oItems: PatchLine[] = oldLines.map((t) => ({ ctx: false, text: t, raw: t }));
  const nItems: PatchLine[] = newLines.map((t) => ({ ctx: false, text: t, raw: t }));
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const st = stateOf(tree, path);
    if (st === null) throw new Fail('missing', path);
    const found = occurrencesAt(oldLines, st.lines, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const at = found.pos[0]!;
    const repl = replacement(oItems, nItems, st.lines, at, found.tier);
    st.lines.splice(at, oldLines.length, ...repl);
    tree.now.set(path, joinFile(st));
  };
}

function srEdits(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchLine = i + 1;
      let path: string | null = null;
      for (let j = i - 1; j > prevEnd; j--) {
        const t = lines[j]!.trim();
        if (t === '' || t.startsWith('```')) continue;
        path = t;
        break;
      }
      if (path === null) {
        if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
        path = prevPath;
      }
      let k = i + 1;
      while (k < lines.length && lines[k]!.trimEnd() !== '=======') k++;
      if (k >= lines.length) throw new Exit2(`error: parse ${searchLine}`);
      let m = k + 1;
      while (m < lines.length && lines[m]!.trimEnd() !== '>>>>>>> REPLACE') m++;
      if (m >= lines.length) throw new Exit2(`error: parse ${searchLine}`);
      edits.push(srEdit(path, lines.slice(i + 1, k), lines.slice(k + 1, m)));
      prevPath = path;
      prevEnd = m;
      i = m + 1;
    } else {
      i += 1;
    }
  }
  return edits;
}

interface VChunk {
  anchor: string | null;
  eof: boolean;
  items: PatchLine[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  line: number;
  moveTo: string | null;
  addLines: string[];
  chunks: VChunk[];
}

const V_ADD = '*** Add File: ';
const V_DEL = '*** Delete File: ';
const V_UPD = '*** Update File: ';
const V_MOVE = '*** Move to: ';

function v4aSectionEdit(s: VSection): Edit {
  if (s.kind === 'add') {
    return (tree) => {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, s.addLines.length === 0 ? '' : s.addLines.join('\n') + '\n');
    };
  }
  if (s.kind === 'delete') {
    return (tree) => {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
    };
  }
  const move = s.moveTo !== null;
  return (tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (move && !safe(s.moveTo!)) throw new Fail('unsafe', s.moveTo!);
    const st = stateOf(tree, s.path);
    if (st === null) throw new Fail('missing', s.path);
    if (move && tree.get(s.moveTo!) !== null) throw new Fail('exists', s.moveTo!);
    let cursor = 0;
    for (const chunk of s.chunks) {
      if (chunk.anchor !== null) {
        const at = anchorAt(chunk.anchor, st.lines, cursor);
        if (at === null) throw new Fail('no-match', s.path);
        cursor = at + 1;
      }
      const oItems = chunk.items.filter((it) => it.ctx || it.raw.startsWith('-'));
      const nItems = chunk.items.filter((it) => it.ctx || it.raw.startsWith('+'));
      const o = oItems.map((it) => it.text);
      if (o.length === 0) {
        const at = chunk.eof ? st.lines.length : cursor;
        st.lines.splice(at, 0, ...nItems.map((it) => it.text));
        cursor = at + nItems.length;
        continue;
      }
      let at = -1;
      let tier = 0;
      const tiers = STRICT ? [0] : [0, 1, 2];
      for (const t of tiers) {
        for (let p = cursor; p + o.length <= st.lines.length; p++) {
          if (chunk.eof && p + o.length !== st.lines.length) continue;
          if (matchAt(o, st.lines, p, t)) {
            at = p;
            tier = t;
            break;
          }
        }
        if (at >= 0) break;
      }
      if (at < 0) throw new Fail('no-match', s.path);
      const repl = replacement(oItems, nItems, st.lines, at, tier);
      st.lines.splice(at, o.length, ...repl);
      cursor = at + repl.length;
    }
    const text = joinFile(st);
    if (move) {
      tree.now.set(s.moveTo!, text);
      tree.now.set(s.path, null);
      return { old: s.path, new: s.moveTo! };
    }
    tree.now.set(s.path, text);
  };
}

function v4aEdits(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith(V_ADD) || line.startsWith(V_DEL) || line.startsWith(V_UPD)) {
      const kind = line.startsWith(V_ADD) ? 'add' : line.startsWith(V_DEL) ? 'delete' : 'update';
      const prefix = kind === 'add' ? V_ADD : kind === 'delete' ? V_DEL : V_UPD;
      const sec: VSection = { kind, path: line.slice(prefix.length).trim(), line: i + 1, moveTo: null, addLines: [], chunks: [] };
      sections.push(sec);
      i += 1;
      if (kind === 'delete') continue;
      if (kind === 'add') {
        const raw: Array<{ text: string; num: number }> = [];
        while (i < last) {
          const b = lines[i]!;
          if (b.startsWith(V_ADD) || b.startsWith(V_DEL) || b.startsWith(V_UPD) || b.trim() === '*** End Patch') break;
          raw.push({ text: b, num: i + 1 });
          i += 1;
        }
        while (raw.length > 0 && raw[raw.length - 1]!.text.trim() === '') raw.pop();
        for (const r of raw) {
          if (r.text === '') sec.addLines.push('');
          else if (r.text.startsWith('+')) sec.addLines.push(r.text.slice(1));
          else throw new Exit2(`error: parse ${r.num}`);
        }
        continue;
      }
      // update: optional Move to, then chunks
      if (i < last && lines[i]!.startsWith(V_MOVE)) {
        sec.moveTo = lines[i]!.slice(V_MOVE.length).trim();
        i += 1;
      }
      let chunk: VChunk | null = null;
      // Only a chunk that runs to the next section or End Patch loses its trailing blank lines:
      // blank lines at the end of a section are not part of it, blank lines before @@ are.
      const endChunk = (strip: boolean): void => {
        if (chunk !== null) {
          if (strip) while (chunk.items.length > 0 && chunk.items[chunk.items.length - 1]!.raw.trim() === '') chunk.items.pop();
          sec.chunks.push(chunk);
          chunk = null;
        }
      };
      while (i < last) {
        const b = lines[i]!;
        if (b.startsWith(V_ADD) || b.startsWith(V_DEL) || b.startsWith(V_UPD) || b.trim() === '*** End Patch') break;
        if (b.trim() === '*** End of File') {
          if (chunk === null) chunk = { anchor: null, eof: false, items: [] };
          chunk.eof = true;
          endChunk(false);
          i += 1;
          continue;
        }
        if (b.startsWith('@@')) {
          endChunk(false);
          const anchor = b.slice(2).trim();
          chunk = { anchor: anchor === '' ? null : anchor, eof: false, items: [] };
          i += 1;
          continue;
        }
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+')) {
          if (chunk === null) {
            if (sec.chunks.length > 0) throw new Exit2(`error: parse ${i + 1}`);
            chunk = { anchor: null, eof: false, items: [] };
          }
          const kind2 = b === '' || b.startsWith(' ') ? ' ' : b[0]!;
          chunk.items.push({ ctx: kind2 === ' ', text: kind2 === ' ' ? b.slice(b === '' ? 0 : 1) : b.slice(1), raw: b });
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      endChunk(true);
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.line}`);
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return sections.map((s) => v4aSectionEdit(s));
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  STRICT = strict;
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines) : kind === 'search-replace' ? srEdits(lines) : v4aEdits(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  const moves: Array<{ old: string; new: string }> = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      const mv = edit(tree);
      if (mv !== undefined) moves.push(mv);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const outRows: Array<{ key: string; line: string }> = [];
  const suppressed = new Set<string>();
  for (const m of moves) {
    if (tree.original(m.old) !== null && tree.get(m.old) === null && tree.original(m.new) === null && tree.get(m.new) !== null) {
      outRows.push({ key: m.new, line: `R ${m.old} -> ${m.new}` });
      suppressed.add(`D ${m.old}`);
      suppressed.add(`A ${m.new}`);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    const letter = was === null ? 'A' : now === null ? 'D' : 'M';
    if (!suppressed.has(`${letter} ${p}`)) outRows.push({ key: p, line: `${letter} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  outRows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = outRows.map((r) => r.line);
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
