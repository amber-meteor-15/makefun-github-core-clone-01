// The forge's store: every object, repository, issue and pull request lives in memory in this one
// process. The git object model (SHA-1 ids, trees, commits, tags, packfiles) is implemented here on
// node:crypto and node:zlib alone — the trial pod has no git binary, so the forge is its own plumbing.
//
// Determinism: nothing here reads the wall clock. Commits the API creates take their timestamps from
// a per-repository logical counter, so the same request sequence always builds the same bytes.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

/** The one tenant this forge serves: the login the trial's bearer token names. */
export const VIEWER = Object.freeze({
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

export const ZERO_OID = '0'.repeat(40);
export const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export interface TagView {
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: string;
  message: string;
}

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** git's object id: SHA-1 over `<type> <size>\0` + the object's bytes. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** Parse a tree object into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object's bytes from entries (sorted the way git sorts them). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a commit object. */
export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const lines = data.subarray(0, headerEnd).toString('utf8').split('\n');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  let current: { key: string; value: string } | null = null;
  const flush = (): void => {
    if (current === null) return;
    if (current.key === 'tree') tree = current.value;
    else if (current.key === 'parent') parents.push(current.value);
    else if (current.key === 'author') author = current.value;
    else if (current.key === 'committer') committer = current.value;
    current = null;
  };
  for (const line of lines) {
    if (line.startsWith(' ') && current !== null) {
      current.value += `\n${line.slice(1)}`;
      continue;
    }
    flush();
    const space = line.indexOf(' ');
    if (space < 0) continue;
    current = { key: line.slice(0, space), value: line.slice(space + 1) };
  }
  flush();
  return { tree, parents, author, committer, message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8') };
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    const space = line.indexOf(' ');
    if (space > 0) headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const type = headers.get('type') ?? '';
  return {
    object: headers.get('object') ?? '',
    type: (type === 'commit' || type === 'tree' || type === 'blob' || type === 'tag' ? type : 'commit') as GitObjectType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

/** An `author`/`committer` line split into name, email and unix seconds. */
export function parseIdentity(line: string): { name: string; email: string; epochSec: number } {
  const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line);
  if (match === null) return { name: line, email: '', epochSec: 0 };
  return { name: match[1] ?? '', email: match[2] ?? '', epochSec: Number(match[3] ?? 0) };
}

// ---------------------------------------------------------------------------
// packfiles

/** Encode one object's pack header: the type/size varint the pack format uses. */
function packObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas): correct and fast enough for this forge's loads. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start] ?? 0;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset] ?? 0;
    offset += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start] ?? 0;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset] ?? 0;
    offset += 1;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past the stream. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  if (!result.engine.bytesWritten || result.engine.bytesWritten <= 0) throw new Error('zlib stream consumed no bytes');
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

/** Apply a git delta (the copy/insert instruction stream) to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] ?? 0;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] ?? 0;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset += (delta[offset] ?? 0) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          copySize += (delta[offset] ?? 0) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

/**
 * Read a packfile and resolve every object, including OFS_DELTA and REF_DELTA entries (a REF_DELTA
 * base the pack leaves out is looked up in `external`, the objects the forge already holds).
 * Returns the resolved objects by id. Throws on any structural problem.
 */
export function readPack(pack: Buffer, external: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32) throw new Error('pack is too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack checksum mismatch');

  interface RawEntry {
    offset: number;
    typeCode: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (CODE_TYPE[typeCode] === undefined) {
      throw new Error(`pack entry has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): GitObject => {
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    let object: GitObject;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset ?? -1);
      if (baseEntry === undefined) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else if (entry.typeCode === 7) {
      const baseEntry = resolvedByOid.get(entry.baseOid ?? '');
      let base: GitObject;
      if (baseEntry !== undefined) base = resolve(baseEntry);
      else {
        const found = external(entry.baseOid ?? '');
        if (found === undefined) throw new Error('ref-delta base is not available');
        base = found;
      }
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      object = { type: CODE_TYPE[entry.typeCode] as GitObjectType, data: entry.data };
    }
    resolving.delete(entry.offset);
    const oid = hashObject(object.type, object.data);
    resolvedByOid.set(oid, entry);
    if (!objects.has(oid)) objects.set(oid, object);
    return object;
  };
  for (const entry of raw) resolve(entry);
  return objects;
}

// ---------------------------------------------------------------------------
// records

export interface LabelRec {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface CommentRec {
  id: number;
  body: string;
  seq: number;
}

export interface IssueRec {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  seq: number;
}

export interface PullRec {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedSeq: number | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  comments: CommentRec[];
  seq: number;
}

export interface Repo {
  id: number;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  nextNumber: number;
  commitSeq: number;
  createdSeq: number;
}

/** The base of the forge's deterministic clock: 2025-01-01T00:00:00Z. */
const EPOCH_BASE_SEC = 1_735_689_600;

/** An ISO timestamp for a logical sequence number (never the wall clock). */
export function isoOfSeq(seq: number): string {
  return new Date((EPOCH_BASE_SEC + seq * 37) * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// the store

export class Store {
  readonly objects = new Map<string, GitObject>();
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextRecordId = 1;
  private nextLabelId = 1;
  private globalSeq = 0;

  /** A fresh logical sequence number (timestamps, creation order). */
  nextSeq(): number {
    this.globalSeq += 1;
    return this.globalSeq;
  }

  /** A fresh database id for an issue, pull request or comment record. */
  nextId(): number {
    const id = this.nextRecordId;
    this.nextRecordId += 1;
    return id;
  }

  nextLabelIdValue(): number {
    const id = this.nextLabelId;
    this.nextLabelId += 1;
    return id;
  }

  // ----- objects

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  /** Store an object's bytes (idempotent) and answer its id. */
  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  putExisting(oid: string, object: GitObject): void {
    if (!this.objects.has(oid)) this.objects.set(oid, object);
  }

  // ----- repositories

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      description,
      isPrivate,
      defaultBranch: 'main',
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      commitSeq: 0,
      createdSeq: this.nextSeq(),
    };
    this.nextRepoId += 1;
    this.repos.set(name, repo);
    // The empty tree every repository can reference.
    this.putObject('tree', Buffer.alloc(0));
    return repo;
  }

  /** The repository `owner/name` for this token, or null (a foreign owner is a 404, never a 403). */
  repoFor(owner: string, name: string): Repo | null {
    if (owner !== VIEWER.login) return null;
    return this.repos.get(name) ?? null;
  }

  repoById(id: number): Repo | null {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return null;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(repo.name);
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }

  // ----- commits the API creates

  /** Build and store one commit object with the forge's deterministic identity and clock. */
  createCommit(repo: Repo, tree: string, parents: readonly string[], message: string): string {
    repo.commitSeq += 1;
    const epochSec = EPOCH_BASE_SEC + repo.commitSeq * 61;
    const who = `${VIEWER.name} <${VIEWER.email}> ${epochSec} +0000`;
    const lines = [`tree ${tree}`];
    for (const parent of parents) lines.push(`parent ${parent}`);
    lines.push(`author ${who}`, `committer ${who}`, '');
    const text = `${lines.join('\n')}\n${message.endsWith('\n') ? message : `${message}\n`}`;
    return this.putObject('commit', Buffer.from(text, 'utf8'));
  }

  /** Parse a stored commit, or null when the id is not a commit in the store. */
  commitOf(oid: string): CommitView | null {
    const object = this.objects.get(oid);
    if (object === undefined || object.type !== 'commit') return null;
    try {
      return parseCommit(object.data);
    } catch {
      return null;
    }
  }

  /** Follow tag objects to the commit they ultimately name, or null. */
  peelToCommit(oid: string): string | null {
    let current = oid;
    for (let hops = 0; hops < 16; hops += 1) {
      const object = this.objects.get(current);
      if (object === undefined) return null;
      if (object.type === 'commit') return current;
      if (object.type !== 'tag') return null;
      try {
        current = parseTag(object.data).object;
      } catch {
        return null;
      }
    }
    return null;
  }

  /** Follow tag objects to whatever non-tag object they name. */
  peelTag(oid: string): string {
    let current = oid;
    for (let hops = 0; hops < 16; hops += 1) {
      const object = this.objects.get(current);
      if (object === undefined || object.type !== 'tag') return current;
      try {
        current = parseTag(object.data).object;
      } catch {
        return current;
      }
    }
    return current;
  }

  /** True when `ancestor` is `descendant` itself or one of its commit ancestors. */
  isAncestor(ancestor: string, descendant: string): boolean {
    const from = this.peelToCommit(descendant);
    const target = this.peelToCommit(ancestor);
    if (from === null || target === null) return ancestor === descendant;
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (current === target) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      const commit = this.commitOf(current);
      if (commit !== null) for (const parent of commit.parents) stack.push(parent);
    }
    return false;
  }

  /** Every commit reachable from `tip`, tip first (a depth-first walk; histories here are near-linear). */
  historyFrom(tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (seen.has(current)) continue;
      const commit = this.commitOf(current);
      if (commit === null) continue;
      seen.add(current);
      out.push(current);
      for (let i = commit.parents.length - 1; i >= 0; i -= 1) stack.push(commit.parents[i] as string);
    }
    return out;
  }

  /** The best common ancestor of two commits, or null when they share no history. */
  mergeBase(a: string, b: string): string | null {
    const distances = new Map<string, number>();
    const queue: Array<readonly [string, number]> = [[a, 0]];
    while (queue.length > 0) {
      const [current, distance] = queue.shift() as readonly [string, number];
      if (distances.has(current)) continue;
      distances.set(current, distance);
      const commit = this.commitOf(current);
      if (commit !== null) for (const parent of commit.parents) queue.push([parent, distance + 1]);
    }
    const seen = new Set<string>();
    const fromB: Array<readonly [string, number]> = [[b, 0]];
    let best: string | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    while (fromB.length > 0) {
      const [current, distance] = fromB.shift() as readonly [string, number];
      if (seen.has(current)) continue;
      seen.add(current);
      const inA = distances.get(current);
      if (inA !== undefined && inA + distance < bestScore) {
        best = current;
        bestScore = inA + distance;
      }
      const commit = this.commitOf(current);
      if (commit !== null) for (const parent of commit.parents) fromB.push([parent, distance + 1]);
    }
    return best;
  }

  // ----- trees

  treeEntries(treeOid: string): TreeEntry[] {
    const object = this.objects.get(treeOid);
    if (object === undefined || object.type !== 'tree') return [];
    try {
      return parseTree(object.data);
    } catch {
      return [];
    }
  }

  /** The entry at `path` under `treeOid`: a file, a directory, or null. */
  treeLookup(treeOid: string, path: string): { kind: 'file' | 'dir'; oid: string; mode: string } | null {
    const segments = path.split('/').filter((segment) => segment !== '');
    let current = treeOid;
    for (let i = 0; i < segments.length; i += 1) {
      const entry = this.treeEntries(current).find((candidate) => candidate.name === segments[i]);
      if (entry === undefined) return null;
      if (i === segments.length - 1) {
        return entry.mode === '40000' ? { kind: 'dir', oid: entry.oid, mode: entry.mode } : { kind: 'file', oid: entry.oid, mode: entry.mode };
      }
      if (entry.mode !== '40000') return null;
      current = entry.oid;
    }
    return { kind: 'dir', oid: current, mode: '40000' };
  }

  /** Every file under a tree, flattened to path -> {oid, mode}. */
  flattenTree(treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, base: string): void => {
      for (const entry of this.treeEntries(oid)) {
        const path = base === '' ? entry.name : `${base}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, prefix);
    return out;
  }

  /**
   * Set (or, with `entry` null, remove) the file at `segments` under `treeOid`, creating intermediate
   * trees. Answers the new tree's id, or null when the subtree became empty (the caller at the root
   * turns that into the empty tree).
   */
  private treeSet(treeOid: string | null, segments: readonly string[], entry: { oid: string; mode: string } | null): string | null {
    const entries = treeOid === null ? [] : this.treeEntries(treeOid);
    const name = segments[0] as string;
    const kept = entries.filter((candidate) => candidate.name !== name);
    if (segments.length === 1) {
      if (entry !== null) kept.push({ mode: entry.mode, name, oid: entry.oid });
    } else {
      const existing = entries.find((candidate) => candidate.name === name);
      const subTree = existing !== undefined && existing.mode === '40000' ? existing.oid : null;
      const newSub = this.treeSet(subTree, segments.slice(1), entry);
      if (newSub !== null) kept.push({ mode: '40000', name, oid: newSub });
    }
    if (kept.length === 0) return null;
    return this.putObject('tree', buildTree(kept));
  }

  /** Set or remove one file in a tree; answers the new root tree id. */
  treeWithFile(treeOid: string, path: string, entry: { oid: string; mode: string } | null): string {
    const segments = path.split('/').filter((segment) => segment !== '');
    if (segments.length === 0) return treeOid;
    return this.treeSet(treeOid, segments, entry) ?? EMPTY_TREE_OID;
  }

  /** Build a tree from a flattened path map (used by merges). */
  treeFromFlat(files: ReadonlyMap<string, { oid: string; mode: string }>): string {
    let root: string | null = null;
    // Insert deepest paths last is unnecessary: treeSet builds intermediates in any order.
    for (const [path, entry] of files) {
      const segments = path.split('/');
      root = this.treeSet(root, segments, entry);
    }
    return root ?? EMPTY_TREE_OID;
  }
}

// ---------------------------------------------------------------------------
// merges and diffs (shared by REST and GraphQL)

export interface FileChange {
  path: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  oldOid: string | null;
  newOid: string | null;
}

function lineCount(data: Buffer): number {
  if (data.length === 0) return 0;
  let lines = 0;
  for (const byte of data) if (byte === 0x0a) lines += 1;
  if (data[data.length - 1] !== 0x0a) lines += 1;
  return lines;
}

/** The file-level changes between two trees (crude line counts: whole-file adds and removes). */
export function diffTrees(store: Store, fromTree: string | null, toTree: string | null): FileChange[] {
  const from = fromTree === null ? new Map<string, { oid: string; mode: string }>() : store.flattenTree(fromTree);
  const to = toTree === null ? new Map<string, { oid: string; mode: string }>() : store.flattenTree(toTree);
  const paths = new Set<string>([...from.keys(), ...to.keys()]);
  const changes: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const before = from.get(path);
    const after = to.get(path);
    if (before !== undefined && after !== undefined && before.oid === after.oid && before.mode === after.mode) continue;
    const oldData = before !== undefined ? store.getObject(before.oid)?.data : undefined;
    const newData = after !== undefined ? store.getObject(after.oid)?.data : undefined;
    changes.push({
      path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      additions: newData !== undefined ? lineCount(newData) : 0,
      deletions: oldData !== undefined ? lineCount(oldData) : 0,
      oldOid: before?.oid ?? null,
      newOid: after?.oid ?? null,
    });
  }
  return changes;
}

export interface MergeOutcome {
  ok: boolean;
  tree: string | null;
  conflictPath: string | null;
}

/**
 * A three-way tree merge: for every path, the side that changed it relative to the merge base wins;
 * both sides changing it differently is a conflict.
 */
export function mergeTrees(store: Store, baseTree: string, currentTree: string, headTree: string): MergeOutcome {
  const base = store.flattenTree(baseTree);
  const current = store.flattenTree(currentTree);
  const head = store.flattenTree(headTree);
  const paths = new Set<string>([...base.keys(), ...current.keys(), ...head.keys()]);
  const same = (a: { oid: string; mode: string } | undefined, b: { oid: string; mode: string } | undefined): boolean =>
    a === undefined && b === undefined ? true : a !== undefined && b !== undefined && a.oid === b.oid && a.mode === b.mode;
  const result = new Map<string, { oid: string; mode: string }>();
  for (const path of paths) {
    const inBase = base.get(path);
    const inCurrent = current.get(path);
    const inHead = head.get(path);
    let winner: { oid: string; mode: string } | undefined;
    if (same(inHead, inBase)) winner = inCurrent;
    else if (same(inCurrent, inBase)) winner = inHead;
    else if (same(inCurrent, inHead)) winner = inCurrent;
    else return { ok: false, tree: null, conflictPath: path };
    if (winner !== undefined) result.set(path, winner);
  }
  return { ok: true, tree: store.treeFromFlat(result), conflictPath: null };
}
