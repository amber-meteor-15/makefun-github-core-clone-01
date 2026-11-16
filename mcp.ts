// The MCP surface: JSON-RPC 2.0 over POST /mcp, speaking both protocol eras (the stateless
// `server/discover` handshake and the classic `initialize`). The tools act on the same store as
// the REST API, so an issue created here is the same issue REST reads back, with the same id.

import type { Repo } from './store.ts';
import type { Ctx, Result } from './types.ts';
import { jsonValue } from './types.ts';
import { repoJson, issueJson, pullJson, createIssueRecord, createPullRecord, mergePullRecord } from './rest.ts';

const SERVER_INFO = { name: 'forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

/** The tool list is a fixed value: byte-identical across calls, as the protocol expects. */
const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch (squash).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
] as const;

const REQUIRED_ARGS: Readonly<Record<string, readonly string[]>> = {
  create_repo: ['name'],
  get_repo: ['owner', 'repo'],
  create_issue: ['owner', 'repo', 'title'],
  list_issues: ['owner', 'repo'],
  create_pull_request: ['owner', 'repo', 'title', 'head', 'base'],
  merge_pull_request: ['owner', 'repo', 'pull_number'],
};

interface RpcError {
  code: number;
  message: string;
}

type ToolOutcome = { ok: true; value: Record<string, unknown> } | { ok: false; message: string };

function needRepo(ctx: Ctx, args: Record<string, unknown>): Repo | null {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const name = typeof args.repo === 'string' ? args.repo : '';
  return ctx.store.repoFor(owner, name);
}

function runTool(ctx: Ctx, name: string, args: Record<string, unknown>): ToolOutcome {
  switch (name) {
    case 'create_repo': {
      const repoName = args.name as string;
      if (ctx.store.repos.has(repoName)) return { ok: false, message: `repository '${repoName}' already exists` };
      const repo = ctx.store.createRepo(
        repoName,
        typeof args.description === 'string' ? args.description : '',
        typeof args.private === 'boolean' ? args.private : false,
      );
      return { ok: true, value: repoJson(repo) };
    }
    case 'get_repo': {
      const repo = needRepo(ctx, args);
      if (repo === null) return { ok: false, message: 'repository not found' };
      return { ok: true, value: repoJson(repo) };
    }
    case 'create_issue': {
      const repo = needRepo(ctx, args);
      if (repo === null) return { ok: false, message: 'repository not found' };
      const issue = createIssueRecord(ctx.store, repo, {
        title: args.title as string,
        body: typeof args.body === 'string' ? args.body : '',
      });
      return { ok: true, value: issueJson(ctx.store, repo, issue) };
    }
    case 'list_issues': {
      const repo = needRepo(ctx, args);
      if (repo === null) return { ok: false, message: 'repository not found' };
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => a.seq - b.seq);
      return { ok: true, value: { issues: issues.map((issue) => issueJson(ctx.store, repo, issue)) } };
    }
    case 'create_pull_request': {
      const repo = needRepo(ctx, args);
      if (repo === null) return { ok: false, message: 'repository not found' };
      try {
        const pull = createPullRecord(ctx.store, repo, {
          title: args.title as string,
          body: typeof args.body === 'string' ? args.body : '',
          head: args.head as string,
          base: args.base as string,
        });
        return { ok: true, value: pullJson(ctx.store, repo, pull) };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : 'could not create the pull request' };
      }
    }
    case 'merge_pull_request': {
      const repo = needRepo(ctx, args);
      if (repo === null) return { ok: false, message: 'repository not found' };
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(String(args.pull_number ?? ''), 10);
      const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;
      if (pull === undefined) return { ok: false, message: 'pull request not found' };
      const outcome = mergePullRecord(ctx.store, repo, pull);
      if (!outcome.ok) return { ok: false, message: outcome.message };
      const value = pullJson(ctx.store, repo, pull);
      value.sha = outcome.sha;
      return { ok: true, value };
    }
    default:
      return { ok: false, message: `unknown tool '${name}'` };
  }
}

/** Process one JSON-RPC request object; returns the response object, or null for a notification. */
function processOne(ctx: Ctx, request: Record<string, unknown>): Record<string, unknown> | null {
  const isNotification = !('id' in request);
  const id = (request.id ?? null) as string | number | null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params =
    request.params !== null && typeof request.params === 'object' && !Array.isArray(request.params)
      ? (request.params as Record<string, unknown>)
      : {};
  const respond = (result: unknown): Record<string, unknown> | null =>
    isNotification ? null : { jsonrpc: '2.0', id, result };
  const respondError = (error: RpcError): Record<string, unknown> | null =>
    isNotification ? null : { jsonrpc: '2.0', id, error };

  switch (method) {
    case 'server/discover':
      return respond({
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize':
      return respond({
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case 'ping':
      return respond({});
    case 'tools/list':
      return respond({ tools: TOOLS });
    case 'resources/list':
      return respond({ resources: [] });
    case 'prompts/list':
      return respond({ prompts: [] });
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args =
        params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {};
      const required = REQUIRED_ARGS[toolName];
      if (required === undefined) return respondError({ code: -32602, message: `unknown tool '${toolName}'` });
      for (const key of required) {
        const value = args[key];
        if (value === undefined || value === null || (typeof value === 'string' && value === '')) {
          return respondError({ code: -32602, message: `missing required argument '${key}' for tool '${toolName}'` });
        }
      }
      const outcome = runTool(ctx, toolName, args);
      if (!outcome.ok) {
        return respond({
          content: [{ type: 'text', text: JSON.stringify({ error: outcome.message }) }],
          structuredContent: { error: outcome.message },
          isError: true,
        });
      }
      return respond({
        content: [{ type: 'text', text: JSON.stringify(outcome.value) }],
        structuredContent: outcome.value,
        isError: false,
      });
    }
    default:
      if (method.startsWith('notifications/')) return null;
      return respondError({ code: -32601, message: `method not found: ${method}` });
  }
}

/** Handle one POST /mcp request (auth has already been enforced by the app). */
export function handleMcp(ctx: Ctx): Result {
  const parsed = jsonValue(ctx);
  if (!parsed.ok) {
    return {
      status: 400,
      json: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }
  if (Array.isArray(parsed.value)) {
    const responses: Record<string, unknown>[] = [];
    for (const entry of parsed.value) {
      if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
        const response = processOne(ctx, entry as Record<string, unknown>);
        if (response !== null) responses.push(response);
      }
    }
    if (responses.length === 0) return { status: 202, raw: Buffer.alloc(0) };
    return { status: 200, json: responses };
  }
  if (parsed.value === null || typeof parsed.value !== 'object') {
    return {
      status: 400,
      json: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } },
    };
  }
  const response = processOne(ctx, parsed.value as Record<string, unknown>);
  if (response === null) return { status: 202, raw: Buffer.alloc(0) };
  return { status: 200, json: response };
}
