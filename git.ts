// The git smart-HTTP transport: reference discovery, protocol v2 commands (ls-refs, fetch), the
// protocol v0 upload-pack negotiation, and receive-pack. Everything speaks pkt-lines over the
// request/response bodies; the objects themselves come from the store in store.ts.

import type { Store, GitObject, Repo } from './store.ts';
import { ZERO_OID, isObjectId, readPack, writePack } from './store.ts';

export const AGENT = 'forge/1.0.0';

// ---------------------------------------------------------------------------
// pkt-lines

/** One pkt-line: a 4-hex-digit length (counting itself) plus the payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const size = data.length + 4;
  if (size > 0xffff) throw new Error('pkt-line payload too large');
  return Buffer.concat([Buffer.from(size.toString(16).padStart(4, '0'), 'ascii'), data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

export interface Pkt {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  data: Buffer;
}

/** Parse as many pkt-lines as `buffer` holds from `start`; stops cleanly at a truncated tail. */
export function parsePkts(buffer: Buffer, start = 0): { packets: Pkt[]; next: number } {
  const packets: Pkt[] = [];
  let offset = start;
  while (offset + 4 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', data: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', data: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end', data: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) break;
    packets.push({ kind: 'data', data: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, next: offset };
}

/** A sideband packet: band byte + payload, keeping the whole pkt-line within 65520 bytes. */
function sideband(band: number, data: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const MAX_PAYLOAD = 65515;
  if (data.length === 0) return [pktLine(Buffer.from([band]))];
  for (let offset = 0; offset < data.length; offset += MAX_PAYLOAD) {
    packets.push(pktLine(Buffer.concat([Buffer.from([band]), data.subarray(offset, offset + MAX_PAYLOAD)])));
  }
  return packets;
}

// ---------------------------------------------------------------------------
// ref advertisement

export interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
}

/** HEAD (when the repository has one or an unborn target) then every ref, sorted by name. */
export function advertisedRefs(store: Store, repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef);
  if (headOid !== undefined) lines.push({ oid: headOid, name: 'HEAD', symrefTarget: headRef });
  else lines.push({ oid: ZERO_OID, name: 'HEAD', symrefTarget: headRef });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const line: RefLine = { oid, name };
    const peeled = store.peelTag(oid);
    if (peeled !== oid) line.peeled = peeled;
    lines.push(line);
  }
  return lines;
}

const V0_UPLOAD_CAPS = [
  'multi_ack_detailed',
  'side-band-64k',
  'thin-pack',
  'ofs-delta',
  'shallow',
  'deepen-since',
  'deepen-not',
  `symref=HEAD:refs/heads/main`,
  `agent=${AGENT}`,
].join(' ');

const V0_RECEIVE_CAPS = ['report-status', 'side-band-64k', 'delete-refs', 'ofs-delta', `agent=${AGENT}`].join(' ');

/** The protocol v0 advertisement for upload-pack or receive-pack. */
export function advertiseV0(store: Store, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? V0_UPLOAD_CAPS : V0_RECEIVE_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = advertisedRefs(store, repo);
  const born = repo.refs.size > 0;
  refs.forEach((ref, index) => {
    if (ref.name === 'HEAD' && !born) {
      parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
      return;
    }
    const suffix = index === 0 ? `\0${caps}` : '';
    parts.push(pktLine(`${ref.oid} ${ref.name}${suffix}\n`));
    if (ref.peeled !== undefined) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
  });
  if (!born && refs.length === 0) parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** The protocol v2 capability advertisement. */
export function advertiseV2(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow wait-for-done\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ]);
}

/** The v2 ls-refs command: HEAD first (subject to ref-prefix filtering), then sorted refs. */
export function lsRefsV2(store: Store, repo: Repo, args: readonly string[]): Buffer {
  const prefixes: string[] = [];
  let peel = false;
  let symrefs = false;
  let unborn = false;
  for (const arg of args) {
    if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
    else if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  for (const ref of advertisedRefs(store, repo)) {
    if (ref.name === 'HEAD') {
      const target = ref.symrefTarget ?? '';
      const included = prefixes.length === 0 || prefixes.some((prefix) => 'HEAD'.startsWith(prefix));
      if (!included) continue;
      if (ref.oid === ZERO_OID) {
        if (!unborn) continue;
        parts.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${target}` : ''}\n`));
      } else {
        parts.push(pktLine(`${ref.oid} HEAD${symrefs ? ` symref-target:${target}` : ''}\n`));
      }
      continue;
    }
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// fetch object selection

export interface FetchSelection {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
  common: string[];
}

interface FetchWants {
  wants: string[];
  haves: string[];
  clientShallow: ReadonlySet<string>;
  depth: number | null;
}

/** Commits reachable from `tips` without expanding the parents of `boundary` commits. */
function reachableCommits(store: Store, tips: readonly string[], boundary: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [];
  for (const tip of tips) {
    const commit = store.peelToCommit(tip);
    if (commit !== null) stack.push(commit);
  }
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    if (boundary.has(current)) continue;
    const commit = store.commitOf(current);
    if (commit !== null) for (const parent of commit.parents) stack.push(parent);
  }
  return seen;
}

/**
 * Every object reachable from `roots` plus the given commit set — trees and blobs hang off commits,
 * tags peel, but a commit's parents are only followed when the parent is itself in the commit set.
 * That gate is what keeps a shallow fetch shallow and a have-closure inside the client's boundary.
 */
function objectClosure(store: Store, roots: readonly string[], commits: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = store.getObject(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = store.commitOf(oid);
      if (commit !== null) {
        stack.push(commit.tree);
        for (const parent of commit.parents) if (commits.has(parent)) stack.push(parent);
      }
    } else if (object.type === 'tree') {
      for (const entry of store.treeEntries(oid)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      const peeled = store.peelTag(oid);
      if (peeled !== oid) stack.push(peeled);
    }
  }
  return seen;
}

/**
 * Decide what a fetch sends: the objects reachable from the wants (limited to `depth` commit
 * generations when shallow) minus everything reachable from the haves, where the client's shallow
 * commits bound the have walk. Also computes the shallow/unshallow boundary lines.
 */
export function selectFetchObjects(store: Store, request: FetchWants): FetchSelection {
  const depth = request.depth !== null && request.depth > 0 ? request.depth : null;

  // Generations: shortest distance from any want, walking commits only.
  const generations = new Map<string, number>();
  const queue: Array<readonly [string, number]> = [];
  for (const want of request.wants) {
    const commit = store.peelToCommit(want);
    if (commit !== null && !generations.has(commit)) {
      generations.set(commit, 0);
      queue.push([commit, 0]);
    }
  }
  while (queue.length > 0) {
    const [current, generation] = queue.shift() as readonly [string, number];
    if (depth !== null && generation >= depth - 1) continue;
    const commit = store.commitOf(current);
    if (commit === null) continue;
    for (const parent of commit.parents) {
      if (!generations.has(parent)) {
        generations.set(parent, generation + 1);
        queue.push([parent, generation + 1]);
      }
    }
  }
  const wantedCommits = new Set<string>();
  for (const [commit, generation] of generations) {
    if (depth === null || generation < depth) wantedCommits.add(commit);
  }

  const haveCommits = reachableCommits(store, request.haves, request.clientShallow);
  const common = request.haves.filter((have) => store.getObject(have) !== undefined && store.peelToCommit(have) !== null);

  const haveObjects = objectClosure(store, [...haveCommits], haveCommits);
  // The closure of what the client is owed: the wanted commits, any non-commit wants, and the trees
  // and blobs hanging off the wanted commits.
  const owedRoots: string[] = [];
  for (const want of request.wants) {
    const object = store.getObject(want);
    if (object === undefined) continue;
    if (object.type === 'commit') {
      if (wantedCommits.has(want)) owedRoots.push(want);
    } else {
      owedRoots.push(want);
      const commit = store.peelToCommit(want);
      if (commit !== null && wantedCommits.has(commit)) owedRoots.push(commit);
    }
  }
  for (const commit of wantedCommits) owedRoots.push(commit);
  const owed = objectClosure(store, owedRoots, wantedCommits);

  const selected = new Set<string>();
  for (const oid of owed) if (!haveObjects.has(oid)) selected.add(oid);

  // The shallow boundary: included commits at the deepest generation that still have a parent in
  // the store; previously-shallow commits now included above the boundary become unshallow.
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== null) {
    for (const commit of wantedCommits) {
      const generation = generations.get(commit) ?? 0;
      const view = store.commitOf(commit);
      const hasParentInStore = view !== null && view.parents.some((parent) => store.getObject(parent) !== undefined);
      if (generation === depth - 1 && hasParentInStore) shallow.push(commit);
      else if (request.clientShallow.has(commit)) unshallow.push(commit);
    }
  } else {
    for (const commit of request.clientShallow) {
      if (wantedCommits.has(commit) || owed.has(commit)) unshallow.push(commit);
    }
  }

  const objects: GitObject[] = [];
  for (const oid of selected) {
    const object = store.getObject(oid);
    if (object !== undefined) objects.push(object);
  }
  return { objects, shallow, unshallow, common };
}

/** Pack the selection and frame it as sideband-1 packets plus a flush. */
function packSideband(objects: readonly GitObject[]): Buffer {
  const pack = writePack(objects);
  return Buffer.concat([...sideband(1, pack), PKT_FLUSH]);
}

// ---------------------------------------------------------------------------
// protocol v2 fetch

export interface V2FetchArgs {
  wants: string[];
  haves: string[];
  shallowLines: string[];
  depth: number | null;
  done: boolean;
}

export function parseV2FetchArgs(args: readonly string[]): V2FetchArgs {
  const parsed: V2FetchArgs = { wants: [], haves: [], shallowLines: [], depth: null, done: false };
  for (const arg of args) {
    if (arg.startsWith('want ')) parsed.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) parsed.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) parsed.shallowLines.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const value = Number.parseInt(arg.slice(7).trim(), 10);
      if (Number.isFinite(value) && value > 0) parsed.depth = value;
    } else if (arg === 'done') parsed.done = true;
  }
  return parsed;
}

/**
 * The v2 fetch response, shaped the way real git's state machine expects (verified against git
 * 2.43 packet traces): a request without `done` is a negotiation round and gets the
 * acknowledgments section only — no `ready` line, no pack. A request with `done` gets no
 * acknowledgments at all: shallow-info when the boundary moved, then the packfile section.
 */
export function fetchV2(store: Store, args: readonly string[]): Buffer {
  const parsed = parseV2FetchArgs(args);
  const selection = selectFetchObjects(store, {
    wants: parsed.wants.filter(isObjectId),
    haves: parsed.haves.filter(isObjectId),
    clientShallow: new Set(parsed.shallowLines.filter(isObjectId)),
    depth: parsed.depth,
  });
  if (!parsed.done) {
    const parts: Buffer[] = [pktLine('acknowledgments\n')];
    if (selection.common.length > 0) {
      for (const oid of selection.common) parts.push(pktLine(`ACK ${oid}\n`));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }
  const parts: Buffer[] = [];
  if (selection.shallow.length > 0 || selection.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(packSideband(selection.objects));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// protocol v0 upload-pack

export interface V0FetchOutcome {
  body: Buffer;
  /** True when the request carried `done` and the body holds the final pack response. */
  finished: boolean;
}

/**
 * The v0 negotiation is a loop over the request stream: wants arrive in the first batch, have
 * batches follow (each answered with ACK-common lines), and the batch carrying `done` is answered
 * with the shallow lines, the final ACK/NAK and the pack. Because the whole request arrives as one
 * HTTP body, the responses are concatenated in order.
 */
export function fetchV0(store: Store, body: Buffer): V0FetchOutcome {
  const { packets } = parsePkts(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow = new Set<string>();
  let depth: number | null = null;
  const out: Buffer[] = [];
  let batch: string[] = [];
  let finished = false;

  const runBatch = (lines: string[], isFirst: boolean): void => {
    let sawDone = false;
    for (const line of lines) {
      if (line.startsWith('want ')) wants.push(line.slice(5, 45));
      else if (line.startsWith('have ')) haves.push(line.slice(5, 45));
      else if (line.startsWith('shallow ')) clientShallow.add(line.slice(8, 48));
      else if (line.startsWith('deepen ')) {
        const value = Number.parseInt(line.slice(7).trim(), 10);
        if (Number.isFinite(value) && value > 0) depth = value;
      } else if (line === 'done') sawDone = true;
    }
    if (isFirst) return;
    const commonNow = haves.filter((have) => store.peelToCommit(have) !== null);
    if (!sawDone) {
      for (const oid of commonNow) out.push(pktLine(`ACK ${oid} common\n`));
      out.push(PKT_FLUSH);
      return;
    }
    const selection = selectFetchObjects(store, {
      wants: wants.filter(isObjectId),
      haves: haves.filter(isObjectId),
      clientShallow,
      depth,
    });
    for (const oid of selection.shallow) out.push(pktLine(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) out.push(pktLine(`unshallow ${oid}\n`));
    if (selection.common.length > 0) out.push(pktLine(`ACK ${selection.common[selection.common.length - 1]} ready\n`));
    else out.push(pktLine('NAK\n'));
    out.push(packSideband(selection.objects));
    finished = true;
  };

  let isFirst = true;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      runBatch(batch, isFirst);
      batch = [];
      isFirst = false;
      if (finished) break;
    } else if (packet.kind === 'data') {
      const text = packet.data.toString('utf8').replace(/\n$/, '');
      if (text !== '') batch.push(text);
    }
  }
  if (!finished && batch.length > 0) runBatch(batch, isFirst);
  if (!finished && out.length === 0) {
    // A request that never got past the wants still gets a well-formed answer.
    out.push(pktLine('NAK\n'), PKT_FLUSH);
  }
  return { body: Buffer.concat(out), finished };
}

// ---------------------------------------------------------------------------
// receive-pack

export interface RefUpdate {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface ReceiveOutcome {
  updates: RefUpdate[];
  report: Buffer;
}

/**
 * Process one receive-pack request body: store the pack (every object, even for refs that will be
 * refused), apply the ref updates that pass the forge's rules, and build the report-status reply.
 */
export function receivePack(store: Store, repo: Repo, body: Buffer): ReceiveOutcome {
  const { packets, next } = parsePkts(body);
  const updates: RefUpdate[] = [];
  let capabilities = '';
  let sawFlush = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      sawFlush = true;
      break;
    }
    if (packet.kind !== 'data') continue;
    let text = packet.data.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    if (nul >= 0) {
      capabilities = text.slice(nul + 1);
      text = text.slice(0, nul);
    }
    const parts = text.split(' ');
    if (parts.length >= 3 && isObjectId(parts[0] as string) && isObjectId(parts[1] as string)) {
      updates.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: (parts[2] as string) ?? '' });
    }
  }
  const packBytes = sawFlush ? body.subarray(next) : Buffer.alloc(0);

  let unpackLine = 'unpack ok\n';
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (oid) => store.getObject(oid));
      for (const [oid, object] of objects) store.putExisting(oid, object);
    } catch (error) {
      unpackLine = `unpack ${error instanceof Error ? error.message : 'corrupt pack'}\n`;
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const update of updates) {
    const { ref, oldOid, newOid } = update;
    if (!ref.startsWith('refs/')) {
      results.push({ ref, ok: false, reason: 'invalid refname' });
      continue;
    }
    const current = repo.refs.get(ref) ?? ZERO_OID;
    if (current !== oldOid) {
      results.push({ ref, ok: false, reason: 'stale info' });
      continue;
    }
    if (newOid === ZERO_OID) {
      if (oldOid === ZERO_OID) {
        results.push({ ref, ok: false, reason: 'reference does not exist' });
        continue;
      }
      repo.refs.delete(ref);
      results.push({ ref, ok: true, reason: '' });
      continue;
    }
    if (store.getObject(newOid) === undefined) {
      results.push({ ref, ok: false, reason: 'new object not found' });
      continue;
    }
    if (oldOid !== ZERO_OID && !store.isAncestor(oldOid, newOid)) {
      results.push({ ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(ref, newOid);
    results.push({ ref, ok: true, reason: '' });
  }

  const lines: string[] = [];
  if (unpackLine !== '') lines.push(unpackLine);
  for (const result of results) {
    lines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  const useSideband = capabilities.split(' ').includes('side-band-64k');
  // The report is a pkt-line stream of its own. When the client asked for side-band-64k that whole
  // stream — flush included — travels inside band-1 packets, and a bare flush ends the reply.
  const inner = Buffer.concat([...lines.map((line) => pktLine(line)), PKT_FLUSH]);
  if (useSideband) {
    return { updates, report: Buffer.concat([...sideband(1, inner), PKT_FLUSH]) };
  }
  return { updates, report: inner };
}
