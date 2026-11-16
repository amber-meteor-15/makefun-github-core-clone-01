// The REST v3 surface: users, repositories, contents, refs, branches, commits, labels, issues,
// comments and pull requests, serialized the way GitHub serializes them. The MCP tools and the
// GraphQL mutations reuse the record-creation helpers exported here, so every surface agrees on
// ids, numbering and state.

import type { Store, Repo, IssueRec, PullRec, LabelRec, CommentRec } from './store.ts';
import { VIEWER, ZERO_OID, EMPTY_TREE_OID, isObjectId, isoOfSeq, parseIdentity, diffTrees, mergeTrees } from './store.ts';
import type { Ctx, Result } from './types.ts';
import { HttpError, fail, jsonBody, asString, asBool, paginate } from './types.ts';

// ---------------------------------------------------------------------------
// serializers

export function userJson(login: string = VIEWER.login): Record<string, unknown> {
  return {
    login,
    id: login === VIEWER.login ? VIEWER.id : 0,
    node_id: Buffer.from(`User:${login === VIEWER.login ? VIEWER.id : 0}`).toString('base64'),
    type: 'User',
    site_admin: false,
  };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: Buffer.from(`Repository:${repo.id}`).toString('base64'),
    name: repo.name,
    full_name: `${VIEWER.login}/${repo.name}`,
    owner: userJson(),
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    created_at: isoOfSeq(repo.createdSeq),
    updated_at: isoOfSeq(repo.createdSeq),
    pushed_at: isoOfSeq(repo.createdSeq),
    default_branch: repo.defaultBranch,
    visibility: repo.isPrivate ? 'private' : 'public',
  };
}

export function labelJson(label: LabelRec): Record<string, unknown> {
  return {
    id: label.id,
    node_id: Buffer.from(`Label:${label.id}`).toString('base64'),
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
  };
}

export function issueJson(store: Store, repo: Repo, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: Buffer.from(`Issue:${repo.id}:${issue.number}`).toString('base64'),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label !== undefined ? labelJson(label) : { name };
    }),
    comments: issue.comments.length,
    user: userJson(),
    created_at: isoOfSeq(issue.seq),
    updated_at: isoOfSeq(issue.seq),
    closed_at: issue.state === 'closed' ? isoOfSeq(issue.seq) : null,
  };
}

export function commentJson(repo: Repo, issueNumber: number, comment: CommentRec): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: Buffer.from(`IssueComment:${repo.id}:${issueNumber}:${comment.id}`).toString('base64'),
    body: comment.body,
    user: userJson(),
    created_at: isoOfSeq(comment.seq),
    updated_at: isoOfSeq(comment.seq),
  };
}

export function branchTip(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

export function pullJson(store: Store, repo: Repo, pull: PullRec): Record<string, unknown> {
  const headSha = branchTip(repo, pull.headRef);
  const baseSha = branchTip(repo, pull.baseRef);
  return {
    id: pull.id,
    node_id: Buffer.from(`PullRequest:${repo.id}:${pull.number}`).toString('base64'),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    merged: pull.merged,
    merged_at: pull.merged ? isoOfSeq(pull.mergedSeq ?? pull.seq) : null,
    merge_commit_sha: pull.mergeCommitSha,
    draft: false,
    user: userJson(),
    head: { ref: pull.headRef, sha: headSha, label: `${VIEWER.login}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${VIEWER.login}:${pull.baseRef}` },
    created_at: isoOfSeq(pull.seq),
    updated_at: isoOfSeq(pull.seq),
  };
}

export function commitJson(store: Store, oid: string): Record<string, unknown> {
  const commit = store.commitOf(oid);
  if (commit === null) return { sha: oid };
  const author = parseIdentity(commit.author);
  const committer = parseIdentity(commit.committer);
  const stamp = (epochSec: number): string => new Date(epochSec * 1000).toISOString();
  return {
    sha: oid,
    node_id: Buffer.from(`Commit:${oid}`).toString('base64'),
    commit: {
      message: commit.message.replace(/\n$/, ''),
      author: { name: author.name, email: author.email, date: stamp(author.epochSec) },
      committer: { name: committer.name, email: committer.email, date: stamp(committer.epochSec) },
      tree: { sha: commit.tree },
    },
    author: userJson(),
    committer: userJson(),
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

// ---------------------------------------------------------------------------
// shared record creation (REST, GraphQL and MCP all land here)

export function createIssueRecord(store: Store, repo: Repo, input: { title: string; body: string; labels?: string[] }): IssueRec {
  const labels = input.labels ?? [];
  for (const name of labels) {
    if (!repo.labels.has(name)) fail(422, `Validation Failed: label '${name}' does not exist`);
  }
  const issue: IssueRec = {
    number: repo.nextNumber,
    id: store.nextId(),
    title: input.title,
    body: input.body,
    state: 'open',
    labels: [...labels],
    comments: [],
    seq: store.nextSeq(),
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

export function createPullRecord(store: Store, repo: Repo, input: { title: string; body: string; head: string; base: string }): PullRec {
  const head = input.head.includes(':') ? (input.head.split(':').pop() as string) : input.head;
  const base = input.base.includes(':') ? (input.base.split(':').pop() as string) : input.base;
  const headTip = branchTip(repo, head);
  const baseTip = branchTip(repo, base);
  if (headTip === null) fail(422, `Validation Failed: head branch '${head}' does not exist`);
  if (baseTip === null) fail(422, `Validation Failed: base branch '${base}' does not exist`);
  if (headTip === baseTip) fail(422, 'Validation Failed: no commits between the head and base branches');
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
      fail(422, `Validation Failed: a pull request already exists for ${head} -> ${base}`);
    }
  }
  const pull: PullRec = {
    number: repo.nextNumber,
    id: store.nextId(),
    title: input.title,
    body: input.body,
    state: 'open',
    merged: false,
    mergedSeq: null,
    mergeCommitSha: null,
    headRef: head,
    baseRef: base,
    comments: [],
    seq: store.nextSeq(),
  };
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  return pull;
}

export type MergeResult =
  | { ok: true; sha: string }
  | { ok: false; reason: 'conflict' | 'not-open' | 'missing-branch'; message: string };

/** Squash-merge a pull request onto its base branch: one commit, tree from the three-way merge. */
export function mergePullRecord(store: Store, repo: Repo, pull: PullRec): MergeResult {
  if (pull.state !== 'open') return { ok: false, reason: 'not-open', message: 'Pull Request is not open' };
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (headTip === null || baseTip === null) return { ok: false, reason: 'missing-branch', message: 'A branch for this pull request is gone' };
  const baseCommit = store.commitOf(baseTip);
  const headCommit = store.commitOf(headTip);
  if (baseCommit === null || headCommit === null) return { ok: false, reason: 'missing-branch', message: 'A branch tip is not a commit' };
  const mergeBase = store.mergeBase(baseTip, headTip);
  const baseTree = mergeBase !== null ? (store.commitOf(mergeBase)?.tree ?? EMPTY_TREE_OID) : EMPTY_TREE_OID;
  const merged = mergeTrees(store, baseTree, baseCommit.tree, headCommit.tree);
  if (!merged.ok || merged.tree === null) {
    return { ok: false, reason: 'conflict', message: `Merge conflict in ${merged.conflictPath ?? 'a file'}` };
  }
  const message = pull.body !== '' ? `${pull.title} (#${pull.number})\n\n${pull.body}` : `${pull.title} (#${pull.number})`;
  const sha = store.createCommit(repo, merged.tree, [baseTip], message);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedSeq = store.nextSeq();
  pull.mergeCommitSha = sha;
  return { ok: true, sha };
}

/** Whether a pull request's head would merge cleanly into its base right now. */
export function pullMergeable(store: Store, repo: Repo, pull: PullRec): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.state !== 'open') return 'UNKNOWN';
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (headTip === null || baseTip === null) return 'UNKNOWN';
  const baseCommit = store.commitOf(baseTip);
  const headCommit = store.commitOf(headTip);
  if (baseCommit === null || headCommit === null) return 'UNKNOWN';
  const mergeBase = store.mergeBase(baseTip, headTip);
  const baseTree = mergeBase !== null ? (store.commitOf(mergeBase)?.tree ?? EMPTY_TREE_OID) : EMPTY_TREE_OID;
  return mergeTrees(store, baseTree, baseCommit.tree, headCommit.tree).ok ? 'MERGEABLE' : 'CONFLICTING';
}

/** The file changes a pull request introduces: merge-base tree -> head tree. */
export function pullFiles(store: Store, repo: Repo, pull: PullRec) {
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (headTip === null || baseTip === null) return [];
  const headTree = store.commitOf(headTip)?.tree ?? null;
  const mergeBase = store.mergeBase(baseTip, headTip);
  const baseTree = mergeBase !== null ? (store.commitOf(mergeBase)?.tree ?? null) : null;
  return diffTrees(store, baseTree, headTree);
}

// ---------------------------------------------------------------------------
// helpers

function needRepo(ctx: Ctx, owner: string, name: string): Repo {
  const repo = ctx.store.repoFor(owner, name);
  if (repo === null) fail(404, 'Not Found');
  return repo as Repo;
}

function labelNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') names.push(item);
    else if (item !== null && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string') {
      names.push((item as { name: string }).name);
    }
  }
  return names;
}

/** Resolve a `ref` query parameter (branch name or object id) to a commit id. */
function resolveRef(store: Store, repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') return branchTip(repo, repo.defaultBranch);
  const byBranch = repo.refs.get(`refs/heads/${ref}`);
  if (byBranch !== undefined) return store.peelToCommit(byBranch);
  const byTag = repo.refs.get(`refs/tags/${ref}`);
  if (byTag !== undefined) return store.peelToCommit(byTag);
  if (isObjectId(ref)) return store.peelToCommit(ref);
  return null;
}

// ---------------------------------------------------------------------------
// repositories

function createRepo(ctx: Ctx): Result {
  const body = jsonBody(ctx);
  const name = asString(body.name);
  if (name === null || name === '' || !/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
    fail(422, 'Validation Failed: name is invalid');
  }
  if (ctx.store.repos.has(name as string)) {
    fail(422, `Validation Failed: name already exists on this account`);
  }
  const repo = ctx.store.createRepo(
    name as string,
    asString(body.description) ?? '',
    asBool(body.private) ?? false,
  );
  return { status: 201, json: repoJson(repo) };
}

function listOwnRepos(ctx: Ctx): Result {
  const { page, headers } = paginate(ctx, ctx.store.listRepos());
  return { status: 200, json: page.map(repoJson), headers };
}

// ---------------------------------------------------------------------------
// contents

function contentsPut(ctx: Ctx, repo: Repo, path: string): Result {
  const body = jsonBody(ctx);
  const message = asString(body.message);
  const content = asString(body.content);
  if (message === null || content === null) fail(422, 'Validation Failed: message and content are required');
  const cleaned = (content as string).replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned) || cleaned.length % 4 === 1) fail(422, 'Validation Failed: content is not valid base64');
  const bytes = Buffer.from(cleaned, 'base64');
  const branch = asString(body.branch) ?? repo.defaultBranch;
  const refName = `refs/heads/${branch}`;
  let tip = repo.refs.get(refName);
  if (tip === undefined && branch !== repo.defaultBranch) tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const tipCommit = tip !== undefined ? ctx.store.commitOf(tip) : null;
  const baseTree = tipCommit?.tree ?? EMPTY_TREE_OID;
  const existing = ctx.store.treeLookup(baseTree, path);
  const providedSha = asString(body.sha);
  let status = 201;
  if (existing !== null && existing.kind === 'file') {
    if (providedSha === null) fail(422, 'Validation Failed: sha is required when updating an existing file');
    if (providedSha !== existing.oid) fail(409, 'Conflict: the provided sha does not match the current file');
    status = 200;
  } else if (existing !== null && existing.kind === 'dir') {
    fail(422, 'Validation Failed: the path is a directory');
  }
  const blobOid = ctx.store.putObject('blob', bytes);
  const newTree = ctx.store.treeWithFile(baseTree, path, { oid: blobOid, mode: '100644' });
  const commitSha = ctx.store.createCommit(repo, newTree, tip !== undefined ? [tip] : [], message as string);
  repo.refs.set(refName, commitSha);
  return {
    status,
    json: {
      content: {
        name: path.split('/').pop() ?? path,
        path,
        sha: blobOid,
        size: bytes.length,
        type: 'file',
        encoding: 'base64',
        content: bytes.toString('base64'),
      },
      commit: { sha: commitSha, message, tree: { sha: newTree }, parents: tip !== undefined ? [{ sha: tip }] : [] },
    },
  };
}

function contentsGet(ctx: Ctx, repo: Repo, path: string): Result {
  const commit = resolveRef(ctx.store, repo, ctx.query.get('ref'));
  if (commit === null) fail(404, 'Not Found');
  const tree = ctx.store.commitOf(commit as string)?.tree;
  if (tree === undefined) fail(404, 'Not Found');
  if (path === '') {
    return { status: 200, json: dirListing(ctx.store, repo, tree as string, '') };
  }
  const found = ctx.store.treeLookup(tree as string, path);
  if (found === null) fail(404, 'Not Found');
  if (found.kind === 'dir') {
    return { status: 200, json: dirListing(ctx.store, repo, found.oid, path) };
  }
  const data = ctx.store.getObject(found.oid)?.data ?? Buffer.alloc(0);
  return {
    status: 200,
    json: {
      type: 'file',
      name: path.split('/').pop() ?? path,
      path,
      sha: found.oid,
      size: data.length,
      encoding: 'base64',
      content: data.toString('base64'),
    },
  };
}

function dirListing(store: Store, repo: Repo, treeOid: string, prefix: string): Record<string, unknown>[] {
  return store
    .treeEntries(treeOid)
    .map((entry) => ({
      type: entry.mode === '40000' ? 'dir' : 'file',
      name: entry.name,
      path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
      sha: entry.oid,
      size: 0,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function contentsDelete(ctx: Ctx, repo: Repo, path: string): Result {
  const body = jsonBody(ctx);
  const message = asString(body.message);
  const sha = asString(body.sha);
  if (message === null || sha === null) fail(422, 'Validation Failed: message and sha are required');
  const branch = asString(body.branch) ?? repo.defaultBranch;
  const refName = `refs/heads/${branch}`;
  const tip = repo.refs.get(refName);
  if (tip === undefined) fail(404, 'Not Found');
  const tipCommit = ctx.store.commitOf(tip);
  if (tipCommit === null) fail(404, 'Not Found');
  const existing = ctx.store.treeLookup(tipCommit.tree, path);
  if (existing === null || existing.kind !== 'file') fail(404, 'Not Found');
  if ((existing as { oid: string }).oid !== sha) fail(409, 'Conflict: the provided sha does not match the current file');
  const newTree = ctx.store.treeWithFile(tipCommit.tree, path, null);
  const commitSha = ctx.store.createCommit(repo, newTree, [tip], message as string);
  repo.refs.set(refName, commitSha);
  return { status: 200, json: { content: null, commit: { sha: commitSha, message } } };
}

// ---------------------------------------------------------------------------
// refs, branches, commits

function createRef(ctx: Ctx, repo: Repo): Result {
  const body = jsonBody(ctx);
  const ref = asString(body.ref);
  const sha = asString(body.sha);
  if (ref === null || !ref.startsWith('refs/') || sha === null || !isObjectId(sha)) {
    fail(422, 'Validation Failed: ref and sha are required');
  }
  const object = ctx.store.getObject(sha as string);
  if (object === undefined) fail(422, 'Validation Failed: sha does not name an object');
  if (repo.refs.has(ref as string)) fail(422, 'Validation Failed: reference already exists');
  repo.refs.set(ref as string, sha as string);
  return { status: 201, json: { ref, node_id: '', object: { sha, type: object.type } } };
}

function getRef(ctx: Ctx, repo: Repo, remainder: string): Result {
  const full = `refs/${remainder}`;
  const oid = repo.refs.get(full);
  if (oid === undefined) fail(404, 'Not Found');
  const object = ctx.store.getObject(oid as string);
  return { status: 200, json: { ref: full, node_id: '', object: { sha: oid, type: object?.type ?? 'commit' } } };
}

function listBranches(repo: Repo): Result {
  const branches = [...repo.refs.entries()]
    .filter(([name]) => name.startsWith('refs/heads/'))
    .map(([name, sha]) => ({ name: name.slice('refs/heads/'.length), commit: { sha }, protected: false }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { status: 200, json: branches };
}

function listCommits(ctx: Ctx, repo: Repo): Result {
  const ref = ctx.query.get('sha');
  const tip = resolveRef(ctx.store, repo, ref);
  if (tip === null) return { status: 200, json: [] };
  const history = ctx.store.historyFrom(tip as string).map((oid) => commitJson(ctx.store, oid));
  const { page, headers } = paginate(ctx, history);
  return { status: 200, json: page, headers };
}

// ---------------------------------------------------------------------------
// labels

function createLabel(ctx: Ctx, repo: Repo): Result {
  const body = jsonBody(ctx);
  const name = asString(body.name);
  if (name === null || name === '') fail(422, 'Validation Failed: name is required');
  if (repo.labels.has(name as string)) fail(422, 'Validation Failed: name has already been taken');
  const colorRaw = asString(body.color) ?? 'ededed';
  const label: LabelRec = {
    id: ctx.store.nextLabelIdValue(),
    name: name as string,
    color: colorRaw.replace(/^#/, '').toLowerCase(),
    description: asString(body.description),
  };
  repo.labels.set(label.name, label);
  return { status: 201, json: labelJson(label) };
}

// ---------------------------------------------------------------------------
// issues and comments

function createIssue(ctx: Ctx, repo: Repo): Result {
  const body = jsonBody(ctx);
  const title = asString(body.title);
  if (title === null || title === '') fail(422, 'Validation Failed: title is required');
  const issue = createIssueRecord(ctx.store, repo, {
    title: title as string,
    body: asString(body.body) ?? '',
    labels: labelNames(body.labels),
  });
  return { status: 201, json: issueJson(ctx.store, repo, issue) };
}

function listIssues(ctx: Ctx, repo: Repo): Result {
  const state = ctx.query.get('state') ?? 'open';
  const direction = ctx.query.get('direction') ?? 'desc';
  let issues = [...repo.issues.values()];
  if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
  const labelFilter = ctx.query.get('labels');
  if (labelFilter !== null && labelFilter !== '') {
    const wanted = labelFilter.split(',').map((name) => name.trim()).filter((name) => name !== '');
    issues = issues.filter((issue) => wanted.every((name) => issue.labels.includes(name)));
  }
  issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  const { page, headers } = paginate(ctx, issues);
  return { status: 200, json: page.map((issue) => issueJson(ctx.store, repo, issue)), headers };
}

/** The issue or pull request a number names (GitHub numbers them from one counter). */
function issueOrPull(repo: Repo, number: number): { issue: IssueRec } | { pull: PullRec } | null {
  const issue = repo.issues.get(number);
  if (issue !== undefined) return { issue };
  const pull = repo.pulls.get(number);
  if (pull !== undefined) return { pull };
  return null;
}

function getIssue(ctx: Ctx, repo: Repo, number: number): Result {
  const found = issueOrPull(repo, number);
  if (found === null) fail(404, 'Not Found');
  if ('issue' in (found as object)) {
    return { status: 200, json: issueJson(ctx.store, repo, (found as { issue: IssueRec }).issue) };
  }
  const pull = (found as { pull: PullRec }).pull;
  const json = pullJson(ctx.store, repo, pull);
  json.pull_request = { url: '' };
  return { status: 200, json };
}

function patchIssue(ctx: Ctx, repo: Repo, number: number): Result {
  const found = issueOrPull(repo, number);
  if (found === null || !('issue' in (found as object))) fail(404, 'Not Found');
  const issue = (found as { issue: IssueRec }).issue;
  const body = jsonBody(ctx);
  const title = asString(body.title);
  if (title !== null) issue.title = title;
  const text = asString(body.body);
  if (text !== null) issue.body = text;
  const state = asString(body.state);
  if (state === 'open' || state === 'closed') issue.state = state;
  if (body.labels !== undefined) {
    const names = labelNames(body.labels);
    for (const name of names) if (!repo.labels.has(name)) fail(422, `Validation Failed: label '${name}' does not exist`);
    issue.labels = names;
  }
  return { status: 200, json: issueJson(ctx.store, repo, issue) };
}

function commentsOf(found: { issue: IssueRec } | { pull: PullRec }): CommentRec[] {
  return 'issue' in found ? found.issue.comments : found.pull.comments;
}

function createComment(ctx: Ctx, repo: Repo, number: number): Result {
  const found = issueOrPull(repo, number);
  if (found === null) fail(404, 'Not Found');
  const body = jsonBody(ctx);
  const text = asString(body.body);
  if (text === null) fail(422, 'Validation Failed: body is required');
  const comment: CommentRec = { id: ctx.store.nextId(), body: text as string, seq: ctx.store.nextSeq() };
  commentsOf(found as { issue: IssueRec } | { pull: PullRec }).push(comment);
  return { status: 201, json: commentJson(repo, number, comment) };
}

function listComments(ctx: Ctx, repo: Repo, number: number): Result {
  const found = issueOrPull(repo, number);
  if (found === null) fail(404, 'Not Found');
  const comments = [...commentsOf(found as { issue: IssueRec } | { pull: PullRec })].sort((a, b) => a.seq - b.seq);
  const { page, headers } = paginate(ctx, comments);
  return { status: 200, json: page.map((comment) => commentJson(repo, number, comment)), headers };
}

// ---------------------------------------------------------------------------
// pull requests

function createPull(ctx: Ctx, repo: Repo): Result {
  const body = jsonBody(ctx);
  const title = asString(body.title);
  const head = asString(body.head);
  const base = asString(body.base);
  if (title === null || head === null || base === null) fail(422, 'Validation Failed: title, head and base are required');
  const pull = createPullRecord(ctx.store, repo, {
    title: title as string,
    body: asString(body.body) ?? '',
    head: head as string,
    base: base as string,
  });
  return { status: 201, json: pullJson(ctx.store, repo, pull) };
}

function listPulls(ctx: Ctx, repo: Repo): Result {
  const state = ctx.query.get('state') ?? 'open';
  let pulls = [...repo.pulls.values()];
  if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
  else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
  pulls.sort((a, b) => b.seq - a.seq);
  const { page, headers } = paginate(ctx, pulls);
  return { status: 200, json: page.map((pull) => pullJson(ctx.store, repo, pull)), headers };
}

function mergePull(ctx: Ctx, repo: Repo, number: number): Result {
  const pull = repo.pulls.get(number);
  if (pull === undefined) fail(404, 'Not Found');
  const body = ctx.body.length > 0 ? jsonBody(ctx) : {};
  const method = asString(body.merge_method) ?? 'squash';
  if (method !== 'squash' && method !== 'merge' && method !== 'rebase') {
    fail(405, 'Method Not Allowed: unknown merge method');
  }
  const outcome = mergePullRecord(ctx.store, repo, pull as PullRec);
  if (!outcome.ok) {
    if (outcome.reason === 'missing-branch') fail(404, outcome.message);
    fail(405, outcome.message);
  }
  return { status: 200, json: { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' } };
}

// ---------------------------------------------------------------------------
// the router

/** Handle one `/api/v3` request, or return null when the path is not REST. */
export function handleRest(ctx: Ctx): Result | null {
  const seg = ctx.segments;
  if (seg[0] !== 'api' || seg[1] !== 'v3') return null;
  const store = ctx.store;
  {
    if (seg.length === 2) {
      if (ctx.method === 'GET') {
        return {
          status: 200,
          json: { current_user_url: `${ctx.origin}/api/v3/user`, repository_url: `${ctx.origin}/api/v3/repos/{owner}/{repo}` },
          headers: { 'X-OAuth-Scopes': 'repo, read:org' },
        };
      }
      fail(404, 'Not Found');
    }
    if (seg[2] === 'meta' && seg.length === 3 && ctx.method === 'GET') {
      return {
        status: 200,
        json: {
          installed_version: '1.0.0',
          verifiable_password_authentication: false,
          github_services_sha: ZERO_OID,
        },
      };
    }
    if (seg[2] === 'user' && seg.length === 3) {
      if (ctx.method === 'GET') return { status: 200, json: userJson() };
      fail(404, 'Not Found');
    }
    if (seg[2] === 'user' && seg[3] === 'repos' && seg.length === 4) {
      if (ctx.method === 'POST') return createRepo(ctx);
      if (ctx.method === 'GET') return listOwnRepos(ctx);
      fail(404, 'Not Found');
    }
    if (seg[2] === 'repos' && seg.length >= 5) {
      const owner = seg[3] as string;
      const name = seg[4] as string;
      const rest = seg.slice(5);
      if (rest.length === 0) {
        if (ctx.method === 'GET') return { status: 200, json: repoJson(needRepo(ctx, owner, name)) };
        if (ctx.method === 'PATCH') {
          const repo = needRepo(ctx, owner, name);
          const body = jsonBody(ctx);
          const description = asString(body.description);
          if (description !== null) repo.description = description;
          const isPrivate = asBool(body.private);
          if (isPrivate !== null) repo.isPrivate = isPrivate;
          return { status: 200, json: repoJson(repo) };
        }
        if (ctx.method === 'DELETE') {
          const repo = needRepo(ctx, owner, name);
          store.deleteRepo(repo);
          return { status: 204 };
        }
        fail(404, 'Not Found');
      }
      const repo = needRepo(ctx, owner, name);
      if (rest[0] === 'contents') {
        const path = rest.slice(1).join('/');
        if (ctx.method === 'PUT') return contentsPut(ctx, repo, path);
        if (ctx.method === 'GET') return contentsGet(ctx, repo, path);
        if (ctx.method === 'DELETE') return contentsDelete(ctx, repo, path);
        fail(404, 'Not Found');
      }
      if (rest[0] === 'git' && rest[1] === 'refs' && rest.length === 2 && ctx.method === 'POST') return createRef(ctx, repo);
      if (rest[0] === 'git' && (rest[1] === 'refs' || rest[1] === 'ref') && rest.length > 2 && ctx.method === 'GET') {
        return getRef(ctx, repo, rest.slice(2).join('/'));
      }
      if (rest[0] === 'branches' && rest.length === 1 && ctx.method === 'GET') return listBranches(repo);
      if (rest[0] === 'branches' && rest.length > 1 && ctx.method === 'GET') {
        const branch = rest.slice(1).join('/');
        const sha = branchTip(repo, branch);
        if (sha === null) fail(404, 'Not Found');
        return { status: 200, json: { name: branch, commit: commitJson(store, sha as string), protected: false } };
      }
      if (rest[0] === 'commits' && rest.length === 1 && ctx.method === 'GET') return listCommits(ctx, repo);
      if (rest[0] === 'commits' && rest.length === 2 && ctx.method === 'GET') {
        const oid = rest[1] as string;
        if (!isObjectId(oid) || store.commitOf(oid) === null) fail(404, 'Not Found');
        return { status: 200, json: commitJson(store, oid) };
      }
      if (rest[0] === 'labels' && rest.length === 1) {
        if (ctx.method === 'GET') {
          const labels = [...repo.labels.values()].sort((a, b) => (a.name < b.name ? -1 : 1)).map(labelJson);
          const { page, headers } = paginate(ctx, labels);
          return { status: 200, json: page, headers };
        }
        if (ctx.method === 'POST') return createLabel(ctx, repo);
        fail(404, 'Not Found');
      }
      if (rest[0] === 'labels' && rest.length === 2) {
        const label = repo.labels.get(rest[1] as string);
        if (ctx.method === 'GET') {
          if (label === undefined) fail(404, 'Not Found');
          return { status: 200, json: labelJson(label as LabelRec) };
        }
        if (ctx.method === 'DELETE') {
          if (label === undefined) fail(404, 'Not Found');
          repo.labels.delete(rest[1] as string);
          return { status: 204 };
        }
        fail(404, 'Not Found');
      }
      if (rest[0] === 'issues' && rest.length === 1) {
        if (ctx.method === 'POST') return createIssue(ctx, repo);
        if (ctx.method === 'GET') return listIssues(ctx, repo);
        fail(404, 'Not Found');
      }
      if (rest[0] === 'issues' && rest.length >= 2 && /^\d+$/.test(rest[1] as string)) {
        const number = Number.parseInt(rest[1] as string, 10);
        if (rest.length === 2) {
          if (ctx.method === 'GET') return getIssue(ctx, repo, number);
          if (ctx.method === 'PATCH') return patchIssue(ctx, repo, number);
          fail(404, 'Not Found');
        }
        if (rest.length === 3 && rest[2] === 'comments') {
          if (ctx.method === 'POST') return createComment(ctx, repo, number);
          if (ctx.method === 'GET') return listComments(ctx, repo, number);
          fail(404, 'Not Found');
        }
        if (rest.length === 3 && rest[2] === 'labels' && ctx.method === 'POST') {
          const found = issueOrPull(repo, number);
          if (found === null || !('issue' in found)) fail(404, 'Not Found');
          const issue = (found as { issue: IssueRec }).issue;
          const labelBody = jsonBody(ctx);
          const names = labelNames(labelBody.labels ?? labelBody.names);
          for (const labelName of names) if (!repo.labels.has(labelName)) fail(422, `Validation Failed: label '${labelName}' does not exist`);
          for (const labelName of names) if (!issue.labels.includes(labelName)) issue.labels.push(labelName);
          return { status: 200, json: issue.labels.map((labelName) => labelJson(repo.labels.get(labelName) as LabelRec)) };
        }
        fail(404, 'Not Found');
      }
      if (rest[0] === 'pulls' && rest.length === 1) {
        if (ctx.method === 'POST') return createPull(ctx, repo);
        if (ctx.method === 'GET') return listPulls(ctx, repo);
        fail(404, 'Not Found');
      }
      if (rest[0] === 'pulls' && rest.length >= 2 && /^\d+$/.test(rest[1] as string)) {
        const number = Number.parseInt(rest[1] as string, 10);
        const pull = repo.pulls.get(number);
        if (rest.length === 2) {
          if (ctx.method === 'GET') {
            if (pull === undefined) fail(404, 'Not Found');
            return { status: 200, json: pullJson(store, repo, pull as PullRec) };
          }
          if (ctx.method === 'PATCH') {
            if (pull === undefined) fail(404, 'Not Found');
            const body = jsonBody(ctx);
            const title = asString(body.title);
            if (title !== null) (pull as PullRec).title = title;
            const text = asString(body.body);
            if (text !== null) (pull as PullRec).body = text;
            const state = asString(body.state);
            if (state === 'closed' && (pull as PullRec).state === 'open') (pull as PullRec).state = 'closed';
            if (state === 'open' && (pull as PullRec).state === 'closed' && !(pull as PullRec).merged) (pull as PullRec).state = 'open';
            return { status: 200, json: pullJson(store, repo, pull as PullRec) };
          }
          fail(404, 'Not Found');
        }
        if (pull === undefined) fail(404, 'Not Found');
        if (rest.length === 3 && rest[2] === 'files' && ctx.method === 'GET') {
          const files = pullFiles(store, repo, pull as PullRec).map((change) => ({
            filename: change.path,
            sha: change.newOid,
            status: change.status,
            additions: change.additions,
            deletions: change.deletions,
            changes: change.additions + change.deletions,
          }));
          const { page, headers } = paginate(ctx, files);
          return { status: 200, json: page, headers };
        }
        if (rest.length === 3 && rest[2] === 'merge' && ctx.method === 'PUT') return mergePull(ctx, repo, number);
        if (rest.length === 3 && rest[2] === 'commits' && ctx.method === 'GET') {
          const headTip = branchTip(repo, (pull as PullRec).headRef);
          const baseTip = branchTip(repo, (pull as PullRec).baseRef);
          if (headTip === null) return { status: 200, json: [] };
          const baseSet = new Set(baseTip !== null ? store.historyFrom(baseTip) : []);
          const commits = store.historyFrom(headTip).filter((oid) => !baseSet.has(oid)).map((oid) => commitJson(store, oid));
          const { page, headers } = paginate(ctx, commits);
          return { status: 200, json: page, headers };
        }
        fail(404, 'Not Found');
      }
      fail(404, 'Not Found');
    }
    fail(404, 'Not Found');
  }
  return null;
}
