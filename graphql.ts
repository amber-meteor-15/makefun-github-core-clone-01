// The GraphQL surface: a small but honest implementation — a lexer and parser for the query
// language (operations, variables, aliases, fragments, directives, input literals), an executor
// over the same store the REST API uses, and enough schema data for the introspection queries
// clients actually send. Unknown fields resolve to null with an error naming the field, the way
// GitHub reports them, instead of failing the whole operation.

import type { Store, Repo, IssueRec, PullRec, CommentRec } from './store.ts';
import { VIEWER, isoOfSeq } from './store.ts';
import type { Ctx, Result } from './types.ts';
import { jsonValue } from './types.ts';
import { createIssueRecord, createPullRecord, mergePullRecord, pullMergeable, pullFiles } from './rest.ts';

// ---------------------------------------------------------------------------
// lexer

interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread' | 'eof';
  value: string;
}

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1] ?? '';
          const escapes: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (esc === 'u') {
            value += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            value += escapes[esc] ?? esc;
            j += 2;
          }
        } else {
          value += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      const match = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(source.slice(i));
      if (match === null) throw new Error(`bad number at offset ${i}`);
      const text = match[0];
      tokens.push({ kind: text.includes('.') || /[eE]/.test(text) ? 'float' : 'int', value: text });
      i += text.length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} at offset ${i}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------
// parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int' | 'float' | 'string' | 'enum'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface DirectiveNode {
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
}

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Array<{ name: string; value: ValueNode }>;
  directives: DirectiveNode[];
  selectionSet: SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { kind: 'spread'; name: string; directives: DirectiveNode[] }
  | { kind: 'inline'; typeCondition: string | null; directives: DirectiveNode[]; selectionSet: SelectionNode[] };

interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  variableDefaults: Map<string, ValueNode>;
  selectionSet: SelectionNode[];
}

interface FragmentNode {
  typeCondition: string;
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected '${value}', found '${token.value}'`);
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, found '${token.value}'`);
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, variableDefaults: new Map(), selectionSet: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.expectName();
      if (keyword === 'query' || keyword === 'mutation') {
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        const variableDefaults = new Map<string, ValueNode>();
        if (this.skipPunct('(')) {
          while (!this.skipPunct(')')) {
            this.expectPunct('$');
            const varName = this.expectName();
            this.expectPunct(':');
            this.parseType();
            if (this.skipPunct('=')) variableDefaults.set(varName, this.parseValue());
            this.parseDirectives();
          }
        }
        this.parseDirectives();
        operations.push({ type: keyword, name, variableDefaults, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (keyword === 'fragment') {
        const fragName = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error(`expected 'on' in fragment definition`);
        const typeCondition = this.expectName();
        this.parseDirectives();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unexpected definition '${keyword}'`);
    }
    return { operations, fragments };
  }

  private parseType(): void {
    if (this.skipPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.skipPunct('!');
  }

  private parseDirectives(): DirectiveNode[] {
    const directives: DirectiveNode[] = [];
    while (this.skipPunct('@')) {
      const name = this.expectName();
      const args: DirectiveNode['args'] = [];
      if (this.skipPunct('(')) {
        while (!this.skipPunct(')')) {
          const argName = this.expectName();
          this.expectPunct(':');
          args.push({ name: argName, value: this.parseValue() });
        }
      }
      directives.push({ name, args });
    }
    return directives;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.skipPunct('}')) {
      if (this.peek().kind === 'spread') {
        this.next();
        if (this.peek().kind === 'name' && this.peek().value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          const directives = this.parseDirectives();
          selections.push({ kind: 'inline', typeCondition, directives, selectionSet: this.parseSelectionSet() });
        } else if (this.peek().kind === 'punct' && this.peek().value === '@') {
          const directives = this.parseDirectives();
          selections.push({ kind: 'inline', typeCondition: null, directives, selectionSet: this.parseSelectionSet() });
        } else {
          const name = this.expectName();
          const directives = this.parseDirectives();
          selections.push({ kind: 'spread', name, directives });
        }
        continue;
      }
      let name = this.expectName();
      let alias: string | null = null;
      if (this.skipPunct(':')) {
        alias = name;
        name = this.expectName();
      }
      const args: FieldNode['args'] = [];
      if (this.skipPunct('(')) {
        while (!this.skipPunct(')')) {
          const argName = this.expectName();
          this.expectPunct(':');
          args.push({ name: argName, value: this.parseValue() });
        }
      }
      const directives = this.parseDirectives();
      const selectionSet = this.peek().kind === 'punct' && this.peek().value === '{' ? this.parseSelectionSet() : null;
      selections.push({ kind: 'field', name, alias, args, directives, selectionSet });
    }
    return selections;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.skipPunct(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.skipPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'int' || token.kind === 'float') return { kind: token.kind, value: token.value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token '${token.value}'`);
  }
}

// ---------------------------------------------------------------------------
// global ids

function gid(raw: string): string {
  return Buffer.from(raw, 'utf8').toString('base64');
}

function decodeGid(id: string): string[] {
  try {
    return Buffer.from(id, 'base64').toString('utf8').split(':');
  } catch {
    return [];
  }
}

const repoGid = (repo: Repo): string => gid(`Repository:${repo.id}`);
const issueGid = (repo: Repo, issue: IssueRec): string => gid(`Issue:${repo.id}:${issue.number}`);
const pullGid = (repo: Repo, pull: PullRec): string => gid(`PullRequest:${repo.id}:${pull.number}`);
const commentGid = (repo: Repo, number: number, comment: CommentRec): string => gid(`IssueComment:${repo.id}:${number}:${comment.id}`);

// ---------------------------------------------------------------------------
// schema (for introspection and field tables)

interface TypeDef {
  kind: 'OBJECT' | 'ENUM' | 'INPUT_OBJECT' | 'SCALAR' | 'INTERFACE';
  fields?: Record<string, { type: string; args?: Record<string, string> }>;
  enumValues?: string[];
  inputFields?: Record<string, string>;
}

const SCHEMA: Record<string, TypeDef> = {
  Query: {
    kind: 'OBJECT',
    fields: {
      viewer: { type: 'User' },
      repository: { type: 'Repository', args: { owner: 'String', name: 'String' } },
      node: { type: 'Node', args: { id: 'ID' } },
      __type: { type: '__Type', args: { name: 'String' } },
      __schema: { type: '__Schema' },
    },
  },
  Mutation: {
    kind: 'OBJECT',
    fields: {
      createIssue: { type: 'CreateIssuePayload', args: { input: 'CreateIssueInput' } },
      closeIssue: { type: 'CloseIssuePayload', args: { input: 'CloseIssueInput' } },
      reopenIssue: { type: 'ReopenIssuePayload', args: { input: 'ReopenIssueInput' } },
      createPullRequest: { type: 'CreatePullRequestPayload', args: { input: 'CreatePullRequestInput' } },
      mergePullRequest: { type: 'MergePullRequestPayload', args: { input: 'MergePullRequestInput' } },
      addComment: { type: 'AddCommentPayload', args: { input: 'AddCommentInput' } },
    },
  },
  Node: { kind: 'INTERFACE', fields: { id: { type: 'ID' } } },
  User: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID' },
      databaseId: { type: 'Int' },
      login: { type: 'String' },
      name: { type: 'String' },
      email: { type: 'String' },
    },
  },
  Repository: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID' },
      databaseId: { type: 'Int' },
      name: { type: 'String' },
      nameWithOwner: { type: 'String' },
      owner: { type: 'User' },
      description: { type: 'String' },
      isPrivate: { type: 'Boolean' },
      defaultBranchRef: { type: 'Ref' },
      viewerPermission: { type: 'RepositoryPermission' },
      hasIssuesEnabled: { type: 'Boolean' },
      createdAt: { type: 'String' },
      issue: { type: 'Issue', args: { number: 'Int' } },
      issues: { type: 'IssueConnection', args: { first: 'Int', after: 'String', states: '[IssueState]', orderBy: 'IssueOrder' } },
      pullRequest: { type: 'PullRequest', args: { number: 'Int' } },
      pullRequests: { type: 'PullRequestConnection', args: { first: 'Int', after: 'String', states: '[PullRequestState]' } },
    },
  },
  Ref: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID' },
      name: { type: 'String' },
      prefix: { type: 'String' },
      target: { type: 'Commit' },
    },
  },
  Commit: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID' },
      oid: { type: 'ID' },
      message: { type: 'String' },
    },
  },
  Issue: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID' },
      databaseId: { type: 'Int' },
      number: { type: 'Int' },
      title: { type: 'String' },
      state: { type: 'IssueState' },
      body: { type: 'String' },
      author: { type: 'User' },
      repository: { type: 'Repository' },
      labels: { type: 'LabelConnection', args: { first: 'Int' } },
      comments: { type: 'IssueCommentConnection', args: { first: 'Int', after: 'String' } },
      createdAt: { type: 'String' },
      updatedAt: { type: 'String' },
      closedAt: { type: 'String' },
    },
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID' },
      databaseId: { type: 'Int' },
      number: { type: 'Int' },
      title: { type: 'String' },
      body: { type: 'String' },
      state: { type: 'PullRequestState' },
      merged: { type: 'Boolean' },
      mergedAt: { type: 'String' },
      mergeCommit: { type: 'Commit' },
      headRefName: { type: 'String' },
      baseRefName: { type: 'String' },
      headRef: { type: 'Ref' },
      baseRef: { type: 'Ref' },
      mergeable: { type: 'MergeableState' },
      files: { type: 'PullRequestFilesConnection', args: { first: 'Int', after: 'String' } },
      author: { type: 'User' },
      repository: { type: 'Repository' },
      comments: { type: 'IssueCommentConnection', args: { first: 'Int', after: 'String' } },
      createdAt: { type: 'String' },
      updatedAt: { type: 'String' },
    },
  },
  IssueComment: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID' },
      body: { type: 'String' },
      author: { type: 'User' },
      createdAt: { type: 'String' },
      updatedAt: { type: 'String' },
    },
  },
  Label: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID' },
      name: { type: 'String' },
      color: { type: 'String' },
      description: { type: 'String' },
    },
  },
  PullRequestFile: {
    kind: 'OBJECT',
    fields: {
      path: { type: 'String' },
      additions: { type: 'Int' },
      deletions: { type: 'Int' },
      changeType: { type: 'FileChangeType' },
    },
  },
  PageInfo: {
    kind: 'OBJECT',
    fields: {
      hasNextPage: { type: 'Boolean' },
      hasPreviousPage: { type: 'Boolean' },
      startCursor: { type: 'String' },
      endCursor: { type: 'String' },
    },
  },
  IssueConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: '[Issue]' },
      edges: { type: '[IssueEdge]' },
      pageInfo: { type: 'PageInfo' },
      totalCount: { type: 'Int' },
    },
  },
  IssueEdge: { kind: 'OBJECT', fields: { node: { type: 'Issue' }, cursor: { type: 'String' } } },
  PullRequestConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: '[PullRequest]' },
      edges: { type: '[PullRequestEdge]' },
      pageInfo: { type: 'PageInfo' },
      totalCount: { type: 'Int' },
    },
  },
  PullRequestEdge: { kind: 'OBJECT', fields: { node: { type: 'PullRequest' }, cursor: { type: 'String' } } },
  IssueCommentConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: '[IssueComment]' },
      edges: { type: '[IssueCommentEdge]' },
      pageInfo: { type: 'PageInfo' },
      totalCount: { type: 'Int' },
    },
  },
  IssueCommentEdge: { kind: 'OBJECT', fields: { node: { type: 'IssueComment' }, cursor: { type: 'String' } } },
  LabelConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: '[Label]' },
      edges: { type: '[LabelEdge]' },
      pageInfo: { type: 'PageInfo' },
      totalCount: { type: 'Int' },
    },
  },
  LabelEdge: { kind: 'OBJECT', fields: { node: { type: 'Label' }, cursor: { type: 'String' } } },
  PullRequestFilesConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: '[PullRequestFile]' },
      edges: { type: '[PullRequestFileEdge]' },
      pageInfo: { type: 'PageInfo' },
      totalCount: { type: 'Int' },
    },
  },
  PullRequestFileEdge: { kind: 'OBJECT', fields: { node: { type: 'PullRequestFile' }, cursor: { type: 'String' } } },
  CreateIssuePayload: { kind: 'OBJECT', fields: { issue: { type: 'Issue' }, clientMutationId: { type: 'String' } } },
  CloseIssuePayload: { kind: 'OBJECT', fields: { issue: { type: 'Issue' }, clientMutationId: { type: 'String' } } },
  ReopenIssuePayload: { kind: 'OBJECT', fields: { issue: { type: 'Issue' }, clientMutationId: { type: 'String' } } },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: { pullRequest: { type: 'PullRequest' }, clientMutationId: { type: 'String' } } },
  MergePullRequestPayload: { kind: 'OBJECT', fields: { pullRequest: { type: 'PullRequest' }, clientMutationId: { type: 'String' } } },
  AddCommentPayload: { kind: 'OBJECT', fields: { commentEdge: { type: 'IssueCommentEdge' }, clientMutationId: { type: 'String' } } },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  FileChangeType: { kind: 'ENUM', enumValues: ['ADDED', 'DELETED', 'MODIFIED', 'RENAMED', 'COPIED', 'CHANGED'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'] },
  CreateIssueInput: { kind: 'INPUT_OBJECT', inputFields: { repositoryId: 'ID', title: 'String', body: 'String', clientMutationId: 'String' } },
  CloseIssueInput: { kind: 'INPUT_OBJECT', inputFields: { issueId: 'ID', clientMutationId: 'String' } },
  ReopenIssueInput: { kind: 'INPUT_OBJECT', inputFields: { issueId: 'ID', clientMutationId: 'String' } },
  CreatePullRequestInput: {
    kind: 'INPUT_OBJECT',
    inputFields: { repositoryId: 'ID', baseRefName: 'String', headRefName: 'String', title: 'String', body: 'String', clientMutationId: 'String' },
  },
  MergePullRequestInput: { kind: 'INPUT_OBJECT', inputFields: { pullRequestId: 'ID', mergeMethod: 'PullRequestMergeMethod', clientMutationId: 'String' } },
  AddCommentInput: { kind: 'INPUT_OBJECT', inputFields: { subjectId: 'ID', body: 'String', clientMutationId: 'String' } },
  IssueOrder: { kind: 'INPUT_OBJECT', inputFields: { field: 'IssueOrderField', direction: 'OrderDirection' } },
  String: { kind: 'SCALAR' },
  Int: { kind: 'SCALAR' },
  Float: { kind: 'SCALAR' },
  Boolean: { kind: 'SCALAR' },
  ID: { kind: 'SCALAR' },
  __Schema: {
    kind: 'OBJECT',
    fields: {
      queryType: { type: '__Type' },
      mutationType: { type: '__Type' },
      subscriptionType: { type: '__Type' },
      types: { type: '[__Type]' },
      directives: { type: '[__Directive]' },
    },
  },
  __Type: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String' },
      kind: { type: 'String' },
      description: { type: 'String' },
      fields: { type: '[__Field]', args: { includeDeprecated: 'Boolean' } },
      enumValues: { type: '[__EnumValue]', args: { includeDeprecated: 'Boolean' } },
      inputFields: { type: '[__InputValue]' },
      possibleTypes: { type: '[__Type]' },
      interfaces: { type: '[__Type]' },
      specifiedByURL: { type: 'String' },
      isOneOf: { type: 'Boolean' },
    },
  },
  __Field: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String' },
      description: { type: 'String' },
      args: { type: '[__InputValue]' },
      type: { type: '__Type' },
      isDeprecated: { type: 'Boolean' },
      deprecationReason: { type: 'String' },
    },
  },
  __EnumValue: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String' },
      description: { type: 'String' },
      isDeprecated: { type: 'Boolean' },
      deprecationReason: { type: 'String' },
    },
  },
  __InputValue: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String' },
      description: { type: 'String' },
      type: { type: '__Type' },
      defaultValue: { type: 'String' },
    },
  },
  __Directive: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String' },
      description: { type: 'String' },
      locations: { type: '[String]' },
      args: { type: '[__InputValue]' },
    },
  },
};

// ---------------------------------------------------------------------------
// executor

/** A resolved GraphQL object: its type name plus the underlying value the resolvers read. */
interface Obj {
  type: string;
  value: unknown;
}

const obj = (type: string, value: unknown): Obj => ({ type, value });

interface ExecCtx {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: Array<{ message: string; path?: string[] }>;
}

type Resolver = (source: Obj, args: Record<string, unknown>, ec: ExecCtx) => unknown;

function valueOf(node: ValueNode, ec: ExecCtx): unknown {
  switch (node.kind) {
    case 'variable':
      return ec.variables[node.name];
    case 'int':
      return Number.parseInt(node.value, 10);
    case 'float':
      return Number.parseFloat(node.value);
    case 'string':
    case 'enum':
      return node.value;
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((value) => valueOf(value, ec));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, ec);
      return out;
    }
  }
}

function argsOf(node: FieldNode, ec: ExecCtx): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const arg of node.args) args[arg.name] = valueOf(arg.value, ec);
  return args;
}

function directivesAllow(directives: DirectiveNode[], ec: ExecCtx): boolean {
  for (const directive of directives) {
    const ifArg = directive.args.find((arg) => arg.name === 'if');
    const flag = ifArg !== undefined ? valueOf(ifArg.value, ec) : undefined;
    if (directive.name === 'skip' && flag === true) return false;
    if (directive.name === 'include' && flag === false) return false;
  }
  return true;
}

interface CollectedField {
  node: FieldNode;
  selections: SelectionNode[];
}

function collectFields(source: Obj, selections: SelectionNode[], ec: ExecCtx, into: Map<string, CollectedField>): void {
  for (const selection of selections) {
    if (selection.kind === 'field') {
      if (!directivesAllow(selection.directives, ec)) continue;
      const key = selection.alias ?? selection.name;
      const existing = into.get(key);
      if (existing !== undefined) {
        if (selection.selectionSet !== null) existing.selections.push(...selection.selectionSet);
      } else {
        into.set(key, { node: selection, selections: selection.selectionSet !== null ? [...selection.selectionSet] : [] });
      }
      continue;
    }
    if (!directivesAllow(selection.directives, ec)) continue;
    if (selection.kind === 'spread') {
      const fragment = ec.fragments.get(selection.name);
      if (fragment === undefined) continue;
      if (fragment.typeCondition !== source.type && SCHEMA[fragment.typeCondition]?.kind !== 'INTERFACE') continue;
      collectFields(source, fragment.selectionSet, ec, into);
      continue;
    }
    if (selection.typeCondition !== null && selection.typeCondition !== source.type && SCHEMA[selection.typeCondition]?.kind !== 'INTERFACE') continue;
    collectFields(source, selection.selectionSet, ec, into);
  }
}

function completeValue(value: unknown, selections: SelectionNode[], ec: ExecCtx, path: string[]): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item, index) => completeValue(item, selections, ec, [...path, String(index)]));
  if (typeof value === 'object' && '__gql' in (value as Record<string, unknown>)) {
    const wrapped = (value as { __gql: Obj }).__gql;
    if (selections.length === 0) return {};
    return executeSet(wrapped, selections, ec, path);
  }
  return value;
}

/** Wrap an Obj so completeValue can tell it apart from a plain scalar record. */
function wrap(wrapped: Obj): unknown {
  return { __gql: wrapped };
}

function executeSet(source: Obj, selections: SelectionNode[], ec: ExecCtx, path: string[]): Record<string, unknown> {
  const fields = new Map<string, CollectedField>();
  collectFields(source, selections, ec, fields);
  const out: Record<string, unknown> = {};
  for (const [key, collected] of fields) {
    const fieldName = collected.node.name;
    const fieldPath = [...path, key];
    if (fieldName === '__typename') {
      out[key] = source.type;
      continue;
    }
    const resolver = RESOLVERS[source.type]?.[fieldName];
    if (resolver === undefined) {
      ec.errors.push({ message: `Field '${fieldName}' doesn't exist on type '${source.type}'`, path: fieldPath });
      out[key] = null;
      continue;
    }
    try {
      const raw = resolver(source, argsOf(collected.node, ec), ec);
      out[key] = completeValue(raw, collected.selections, ec, fieldPath);
    } catch (error) {
      ec.errors.push({ message: error instanceof Error ? error.message : String(error), path: fieldPath });
      out[key] = null;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// object wrappers for store records

const userObj = (): Obj => obj('User', { login: VIEWER.login });
const repoObj = (repo: Repo): Obj => obj('Repository', repo);
const issueObj = (repo: Repo, issue: IssueRec): Obj => obj('Issue', { repo, issue });
const pullObj = (repo: Repo, pull: PullRec): Obj => obj('PullRequest', { repo, pull });
const commentObj = (repo: Repo, number: number, comment: CommentRec): Obj => obj('IssueComment', { repo, number, comment });

function nodeById(store: Store, id: string): Obj | null {
  const parts = decodeGid(id);
  const [type, ...rest] = parts;
  if (type === 'Repository') {
    const repo = store.repoById(Number.parseInt(rest[0] ?? '', 10));
    return repo !== null ? repoObj(repo) : null;
  }
  if (type === 'Issue' || type === 'PullRequest') {
    const repo = store.repoById(Number.parseInt(rest[0] ?? '', 10));
    const number = Number.parseInt(rest[1] ?? '', 10);
    if (repo === null) return null;
    if (type === 'Issue') {
      const issue = repo.issues.get(number);
      return issue !== undefined ? issueObj(repo, issue) : null;
    }
    const pull = repo.pulls.get(number);
    return pull !== undefined ? pullObj(repo, pull) : null;
  }
  if (type === 'User') return userObj();
  return null;
}

// ---------------------------------------------------------------------------
// connections

const cursorOf = (offset: number): string => Buffer.from(String(offset), 'utf8').toString('base64');

function offsetOf(cursor: unknown): number {
  if (typeof cursor !== 'string') return 0;
  const parsed = Number.parseInt(Buffer.from(cursor, 'base64').toString('utf8'), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

interface ConnectionSpec<T> {
  type: string;
  edgeType: string;
  items: T[];
  wrapItem: (item: T) => Obj;
}

function connection<T>(spec: ConnectionSpec<T>, args: Record<string, unknown>): Obj {
  const first = typeof args.first === 'number' ? Math.max(0, args.first) : 100;
  const start = offsetOf(args.after);
  const slice = spec.items.slice(start, start + first);
  const hasNextPage = start + slice.length < spec.items.length;
  const pageInfo = obj('PageInfo', {
    hasNextPage,
    hasPreviousPage: start > 0,
    startCursor: slice.length > 0 ? cursorOf(start + 1) : null,
    endCursor: slice.length > 0 ? cursorOf(start + slice.length) : null,
  });
  return obj(spec.type, {
    nodes: slice.map((item) => wrap(spec.wrapItem(item))),
    edges: slice.map((item, index) =>
      wrap(obj(spec.edgeType, { node: wrap(spec.wrapItem(item)), cursor: cursorOf(start + index + 1) })),
    ),
    pageInfo: wrap(pageInfo),
    totalCount: spec.items.length,
  });
}

function connectionFields(type: string): Record<string, Resolver> {
  return {
    nodes: (source) => (source.value as { nodes: unknown[] }).nodes,
    edges: (source) => (source.value as { edges: unknown[] }).edges,
    pageInfo: (source) => (source.value as { pageInfo: unknown }).pageInfo,
    totalCount: (source) => (source.value as { totalCount: number }).totalCount,
  };
}

// ---------------------------------------------------------------------------
// resolvers

function inputOf(args: Record<string, unknown>): Record<string, unknown> {
  const input = args.input;
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) return input as Record<string, unknown>;
  return args;
}

function repoFromInput(store: Store, input: Record<string, unknown>): Repo {
  const id = input.repositoryId;
  if (typeof id !== 'string') throw new Error('repositoryId is required');
  const parts = decodeGid(id);
  const repo = parts[0] === 'Repository' ? store.repoById(Number.parseInt(parts[1] ?? '', 10)) : null;
  if (repo === null) throw new Error('repository not found');
  return repo;
}

function subjectFromInput(store: Store, input: Record<string, unknown>, key: string): { repo: Repo; issue?: IssueRec; pull?: PullRec } {
  const id = input[key];
  if (typeof id !== 'string') throw new Error(`${key} is required`);
  const parts = decodeGid(id);
  const repo = store.repoById(Number.parseInt(parts[1] ?? '', 10));
  const number = Number.parseInt(parts[2] ?? '', 10);
  if (repo === null) throw new Error('subject not found');
  if (parts[0] === 'Issue') {
    const issue = repo.issues.get(number);
    if (issue === undefined) throw new Error('issue not found');
    return { repo, issue };
  }
  if (parts[0] === 'PullRequest') {
    const pull = repo.pulls.get(number);
    if (pull === undefined) throw new Error('pull request not found');
    return { repo, pull };
  }
  throw new Error('subject not found');
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => wrap(userObj()),
    repository: (source, args, ec) => {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const name = typeof args.name === 'string' ? args.name : '';
      const repo = ec.store.repoFor(owner, name);
      return repo !== null ? wrap(repoObj(repo)) : null;
    },
    node: (source, args, ec) => {
      const found = typeof args.id === 'string' ? nodeById(ec.store, args.id) : null;
      return found !== null ? wrap(found) : null;
    },
    __type: (source, args) => {
      const name = typeof args.name === 'string' ? args.name : '';
      return SCHEMA[name] !== undefined ? wrap(obj('__Type', name)) : null;
    },
    __schema: () => wrap(obj('__Schema', null)),
  },
  Mutation: {
    createIssue: (source, args, ec) => {
      const input = inputOf(args);
      const repo = repoFromInput(ec.store, input);
      const title = typeof input.title === 'string' ? input.title : '';
      if (title === '') throw new Error('title is required');
      const issue = createIssueRecord(ec.store, repo, { title, body: typeof input.body === 'string' ? input.body : '' });
      return wrap(obj('CreateIssuePayload', { issue: wrap(issueObj(repo, issue)), clientMutationId: input.clientMutationId ?? null }));
    },
    closeIssue: (source, args, ec) => {
      const input = inputOf(args);
      const { repo, issue } = subjectFromInput(ec.store, input, 'issueId');
      if (issue === undefined) throw new Error('issue not found');
      issue.state = 'closed';
      return wrap(obj('CloseIssuePayload', { issue: wrap(issueObj(repo, issue)), clientMutationId: input.clientMutationId ?? null }));
    },
    reopenIssue: (source, args, ec) => {
      const input = inputOf(args);
      const { repo, issue } = subjectFromInput(ec.store, input, 'issueId');
      if (issue === undefined) throw new Error('issue not found');
      issue.state = 'open';
      return wrap(obj('ReopenIssuePayload', { issue: wrap(issueObj(repo, issue)), clientMutationId: input.clientMutationId ?? null }));
    },
    createPullRequest: (source, args, ec) => {
      const input = inputOf(args);
      const repo = repoFromInput(ec.store, input);
      const pull = createPullRecord(ec.store, repo, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        head: typeof input.headRefName === 'string' ? input.headRefName : '',
        base: typeof input.baseRefName === 'string' ? input.baseRefName : '',
      });
      return wrap(obj('CreatePullRequestPayload', { pullRequest: wrap(pullObj(repo, pull)), clientMutationId: input.clientMutationId ?? null }));
    },
    mergePullRequest: (source, args, ec) => {
      const input = inputOf(args);
      const { repo, pull } = subjectFromInput(ec.store, input, 'pullRequestId');
      if (pull === undefined) throw new Error('pull request not found');
      const outcome = mergePullRecord(ec.store, repo, pull);
      if (!outcome.ok) throw new Error(outcome.message);
      return wrap(obj('MergePullRequestPayload', { pullRequest: wrap(pullObj(repo, pull)), clientMutationId: input.clientMutationId ?? null }));
    },
    addComment: (source, args, ec) => {
      const input = inputOf(args);
      const body = typeof input.body === 'string' ? input.body : '';
      const subject = subjectFromInput(ec.store, input, 'subjectId');
      const target = subject.issue ?? subject.pull;
      if (target === undefined) throw new Error('subject not found');
      const comment: CommentRec = { id: ec.store.nextId(), body, seq: ec.store.nextSeq() };
      target.comments.push(comment);
      const number = target.number;
      const edge = obj('IssueCommentEdge', { node: wrap(commentObj(subject.repo, number, comment)), cursor: cursorOf(0) });
      return wrap(obj('AddCommentPayload', { commentEdge: wrap(edge), clientMutationId: input.clientMutationId ?? null }));
    },
  },
  User: {
    id: () => gid(`User:${VIEWER.id}`),
    databaseId: () => VIEWER.id,
    login: () => VIEWER.login,
    name: () => VIEWER.name,
    email: () => VIEWER.email,
  },
  Repository: {
    id: (source) => repoGid(source.value as Repo),
    databaseId: (source) => (source.value as Repo).id,
    name: (source) => (source.value as Repo).name,
    nameWithOwner: (source) => `${VIEWER.login}/${(source.value as Repo).name}`,
    owner: () => wrap(userObj()),
    description: (source) => (source.value as Repo).description,
    isPrivate: (source) => (source.value as Repo).isPrivate,
    defaultBranchRef: (source) => {
      const repo = source.value as Repo;
      return wrap(obj('Ref', { repo, name: repo.defaultBranch }));
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    createdAt: (source) => isoOfSeq((source.value as Repo).createdSeq),
    issue: (source, args) => {
      const repo = source.value as Repo;
      const issue = typeof args.number === 'number' ? repo.issues.get(args.number) : undefined;
      return issue !== undefined ? wrap(issueObj(repo, issue)) : null;
    },
    issues: (source, args) => {
      const repo = source.value as Repo;
      let issues = [...repo.issues.values()];
      const states = Array.isArray(args.states) ? (args.states as unknown[]).map(String) : null;
      if (states !== null) issues = issues.filter((issue) => states.includes(issue.state.toUpperCase()));
      const orderBy = args.orderBy !== null && typeof args.orderBy === 'object' ? (args.orderBy as Record<string, unknown>) : null;
      if (orderBy !== null) {
        const direction = orderBy.direction === 'ASC' ? 1 : -1;
        issues.sort((a, b) => direction * (a.seq - b.seq) || direction * (a.number - b.number));
      } else {
        issues.sort((a, b) => a.seq - b.seq);
      }
      return wrap(connection({ type: 'IssueConnection', edgeType: 'IssueEdge', items: issues, wrapItem: (issue) => issueObj(repo, issue) }, args));
    },
    pullRequest: (source, args) => {
      const repo = source.value as Repo;
      const pull = typeof args.number === 'number' ? repo.pulls.get(args.number) : undefined;
      return pull !== undefined ? wrap(pullObj(repo, pull)) : null;
    },
    pullRequests: (source, args) => {
      const repo = source.value as Repo;
      let pulls = [...repo.pulls.values()];
      const states = Array.isArray(args.states) ? (args.states as unknown[]).map(String) : null;
      if (states !== null) {
        pulls = pulls.filter((pull) => {
          const state = pull.merged ? 'MERGED' : pull.state.toUpperCase();
          return states.includes(state);
        });
      }
      pulls.sort((a, b) => a.seq - b.seq);
      return wrap(connection({ type: 'PullRequestConnection', edgeType: 'PullRequestEdge', items: pulls, wrapItem: (pull) => pullObj(repo, pull) }, args));
    },
  },
  Ref: {
    id: (source) => {
      const value = source.value as { repo: Repo; name: string };
      return gid(`Ref:${value.repo.id}:${value.name}`);
    },
    name: (source) => (source.value as { name: string }).name,
    prefix: () => 'refs/heads/',
    target: (source, args, ec) => {
      const value = source.value as { repo: Repo; name: string };
      const tip = value.repo.refs.get(`refs/heads/${value.name}`);
      return tip !== undefined ? wrap(obj('Commit', tip)) : null;
    },
  },
  Commit: {
    id: (source) => gid(`Commit:${source.value as string}`),
    oid: (source) => source.value as string,
    message: (source, args, ec) => ec.store.commitOf(source.value as string)?.message.replace(/\n$/, '') ?? '',
  },
  Issue: {
    id: (source) => {
      const value = source.value as { repo: Repo; issue: IssueRec };
      return issueGid(value.repo, value.issue);
    },
    databaseId: (source) => (source.value as { issue: IssueRec }).issue.id,
    number: (source) => (source.value as { issue: IssueRec }).issue.number,
    title: (source) => (source.value as { issue: IssueRec }).issue.title,
    body: (source) => (source.value as { issue: IssueRec }).issue.body,
    state: (source) => (source.value as { issue: IssueRec }).issue.state.toUpperCase(),
    author: () => wrap(userObj()),
    repository: (source) => wrap(repoObj((source.value as { repo: Repo }).repo)),
    createdAt: (source) => isoOfSeq((source.value as { issue: IssueRec }).issue.seq),
    updatedAt: (source) => isoOfSeq((source.value as { issue: IssueRec }).issue.seq),
    closedAt: (source) => {
      const issue = (source.value as { issue: IssueRec }).issue;
      return issue.state === 'closed' ? isoOfSeq(issue.seq) : null;
    },
    labels: (source, args) => {
      const value = source.value as { repo: Repo; issue: IssueRec };
      const labels = value.issue.labels
        .map((name) => value.repo.labels.get(name))
        .filter((label) => label !== undefined)
        .map((label) => obj('Label', label));
      return wrap(
        connection(
          { type: 'LabelConnection', edgeType: 'LabelEdge', items: labels, wrapItem: (label) => label },
          args,
        ),
      );
    },
    comments: (source, args) => {
      const value = source.value as { repo: Repo; issue: IssueRec };
      const comments = [...value.issue.comments].sort((a, b) => a.seq - b.seq);
      return wrap(
        connection(
          { type: 'IssueCommentConnection', edgeType: 'IssueCommentEdge', items: comments, wrapItem: (comment) => commentObj(value.repo, value.issue.number, comment) },
          args,
        ),
      );
    },
  },
  PullRequest: {
    id: (source) => {
      const value = source.value as { repo: Repo; pull: PullRec };
      return pullGid(value.repo, value.pull);
    },
    databaseId: (source) => (source.value as { pull: PullRec }).pull.id,
    number: (source) => (source.value as { pull: PullRec }).pull.number,
    title: (source) => (source.value as { pull: PullRec }).pull.title,
    body: (source) => (source.value as { pull: PullRec }).pull.body,
    state: (source) => {
      const pull = (source.value as { pull: PullRec }).pull;
      return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    },
    merged: (source) => (source.value as { pull: PullRec }).pull.merged,
    mergedAt: (source) => {
      const pull = (source.value as { pull: PullRec }).pull;
      return pull.merged ? isoOfSeq(pull.mergedSeq ?? pull.seq) : null;
    },
    mergeCommit: (source) => {
      const pull = (source.value as { pull: PullRec }).pull;
      return pull.mergeCommitSha !== null ? wrap(obj('Commit', pull.mergeCommitSha)) : null;
    },
    headRefName: (source) => (source.value as { pull: PullRec }).pull.headRef,
    baseRefName: (source) => (source.value as { pull: PullRec }).pull.baseRef,
    headRef: (source) => {
      const value = source.value as { repo: Repo; pull: PullRec };
      return wrap(obj('Ref', { repo: value.repo, name: value.pull.headRef }));
    },
    baseRef: (source) => {
      const value = source.value as { repo: Repo; pull: PullRec };
      return wrap(obj('Ref', { repo: value.repo, name: value.pull.baseRef }));
    },
    mergeable: (source, args, ec) => {
      const value = source.value as { repo: Repo; pull: PullRec };
      return pullMergeable(ec.store, value.repo, value.pull);
    },
    files: (source, args, ec) => {
      const value = source.value as { repo: Repo; pull: PullRec };
      const files = pullFiles(ec.store, value.repo, value.pull).map((change) =>
        obj('PullRequestFile', {
          path: change.path,
          additions: change.additions,
          deletions: change.deletions,
          changeType: change.status.toUpperCase(),
        }),
      );
      return wrap(
        connection({ type: 'PullRequestFilesConnection', edgeType: 'PullRequestFileEdge', items: files, wrapItem: (file) => file }, args),
      );
    },
    author: () => wrap(userObj()),
    repository: (source) => wrap(repoObj((source.value as { repo: Repo }).repo)),
    comments: (source, args) => {
      const value = source.value as { repo: Repo; pull: PullRec };
      const comments = [...value.pull.comments].sort((a, b) => a.seq - b.seq);
      return wrap(
        connection(
          { type: 'IssueCommentConnection', edgeType: 'IssueCommentEdge', items: comments, wrapItem: (comment) => commentObj(value.repo, value.pull.number, comment) },
          args,
        ),
      );
    },
    createdAt: (source) => isoOfSeq((source.value as { pull: PullRec }).pull.seq),
    updatedAt: (source) => isoOfSeq((source.value as { pull: PullRec }).pull.seq),
  },
  IssueComment: {
    id: (source) => {
      const value = source.value as { repo: Repo; number: number; comment: CommentRec };
      return commentGid(value.repo, value.number, value.comment);
    },
    body: (source) => (source.value as { comment: CommentRec }).comment.body,
    author: () => wrap(userObj()),
    createdAt: (source) => isoOfSeq((source.value as { comment: CommentRec }).comment.seq),
    updatedAt: (source) => isoOfSeq((source.value as { comment: CommentRec }).comment.seq),
  },
  Label: {
    id: (source) => gid(`Label:${(source.value as { id: number }).id}`),
    name: (source) => (source.value as { name: string }).name,
    color: (source) => (source.value as { color: string }).color,
    description: (source) => (source.value as { description: string | null }).description,
  },
  PullRequestFile: {
    path: (source) => (source.value as { path: string }).path,
    additions: (source) => (source.value as { additions: number }).additions,
    deletions: (source) => (source.value as { deletions: number }).deletions,
    changeType: (source) => (source.value as { changeType: string }).changeType,
  },
  PageInfo: {
    hasNextPage: (source) => (source.value as { hasNextPage: boolean }).hasNextPage,
    hasPreviousPage: (source) => (source.value as { hasPreviousPage: boolean }).hasPreviousPage,
    startCursor: (source) => (source.value as { startCursor: string | null }).startCursor,
    endCursor: (source) => (source.value as { endCursor: string | null }).endCursor,
  },
  IssueConnection: connectionFields('IssueConnection'),
  PullRequestConnection: connectionFields('PullRequestConnection'),
  IssueCommentConnection: connectionFields('IssueCommentConnection'),
  LabelConnection: connectionFields('LabelConnection'),
  PullRequestFilesConnection: connectionFields('PullRequestFilesConnection'),
  IssueEdge: { node: (source) => (source.value as { node: unknown }).node, cursor: (source) => (source.value as { cursor: string }).cursor },
  PullRequestEdge: { node: (source) => (source.value as { node: unknown }).node, cursor: (source) => (source.value as { cursor: string }).cursor },
  IssueCommentEdge: { node: (source) => (source.value as { node: unknown }).node, cursor: (source) => (source.value as { cursor: string }).cursor },
  LabelEdge: { node: (source) => (source.value as { node: unknown }).node, cursor: (source) => (source.value as { cursor: string }).cursor },
  PullRequestFileEdge: { node: (source) => (source.value as { node: unknown }).node, cursor: (source) => (source.value as { cursor: string }).cursor },
  CreateIssuePayload: {
    issue: (source) => (source.value as { issue: unknown }).issue,
    clientMutationId: (source) => (source.value as { clientMutationId: unknown }).clientMutationId,
  },
  CloseIssuePayload: {
    issue: (source) => (source.value as { issue: unknown }).issue,
    clientMutationId: (source) => (source.value as { clientMutationId: unknown }).clientMutationId,
  },
  ReopenIssuePayload: {
    issue: (source) => (source.value as { issue: unknown }).issue,
    clientMutationId: (source) => (source.value as { clientMutationId: unknown }).clientMutationId,
  },
  CreatePullRequestPayload: {
    pullRequest: (source) => (source.value as { pullRequest: unknown }).pullRequest,
    clientMutationId: (source) => (source.value as { clientMutationId: unknown }).clientMutationId,
  },
  MergePullRequestPayload: {
    pullRequest: (source) => (source.value as { pullRequest: unknown }).pullRequest,
    clientMutationId: (source) => (source.value as { clientMutationId: unknown }).clientMutationId,
  },
  AddCommentPayload: {
    commentEdge: (source) => (source.value as { commentEdge: unknown }).commentEdge,
    clientMutationId: (source) => (source.value as { clientMutationId: unknown }).clientMutationId,
  },
  __Schema: {
    queryType: () => wrap(obj('__Type', 'Query')),
    mutationType: () => wrap(obj('__Type', 'Mutation')),
    subscriptionType: () => null,
    types: () => Object.keys(SCHEMA).filter((name) => !name.startsWith('__')).map((name) => wrap(obj('__Type', name))),
    directives: () => [],
  },
  __Type: {
    name: (source) => source.value as string,
    kind: (source) => (SCHEMA[source.value as string]?.kind ?? 'OBJECT'),
    description: () => null,
    fields: (source) => {
      const def = SCHEMA[source.value as string];
      if (def?.fields === undefined) return null;
      return Object.entries(def.fields).map(([name, field]) => wrap(obj('__Field', { name, type: field.type, args: field.args ?? {} })));
    },
    enumValues: (source) => {
      const def = SCHEMA[source.value as string];
      if (def?.enumValues === undefined) return null;
      return def.enumValues.map((name) => wrap(obj('__EnumValue', name)));
    },
    inputFields: (source) => {
      const def = SCHEMA[source.value as string];
      if (def?.inputFields === undefined) return null;
      return Object.entries(def.inputFields).map(([name, type]) => wrap(obj('__InputValue', { name, type })));
    },
    possibleTypes: () => null,
    interfaces: () => [],
    specifiedByURL: () => null,
    isOneOf: () => false,
  },
  __Field: {
    name: (source) => (source.value as { name: string }).name,
    description: () => null,
    args: (source) => {
      const value = source.value as { args: Record<string, string> };
      return Object.entries(value.args).map(([name, type]) => wrap(obj('__InputValue', { name, type })));
    },
    type: (source) => wrap(obj('__TypeRef', (source.value as { type: string }).type)),
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __EnumValue: {
    name: (source) => source.value as string,
    description: () => null,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __InputValue: {
    name: (source) => (source.value as { name: string }).name,
    description: () => null,
    type: (source) => wrap(obj('__TypeRef', (source.value as { type: string }).type)),
    defaultValue: () => null,
  },
  __TypeRef: {
    name: (source) => {
      const raw = (source.value as string).replace(/[[\]!]/g, '');
      return raw;
    },
    kind: (source) => {
      const raw = (source.value as string).replace(/[[\]!]/g, '');
      return SCHEMA[raw]?.kind ?? 'SCALAR';
    },
    ofType: () => null,
  },
  __Directive: {
    name: (source) => source.value as string,
    description: () => null,
    locations: () => [],
    args: () => [],
  },
};

// ---------------------------------------------------------------------------
// entry point

function executeOperation(store: Store, document: DocumentNode, operationName: string | null, variables: Record<string, unknown>): Record<string, unknown> {
  const operation =
    document.operations.find((candidate) => operationName === null || candidate.name === operationName) ?? document.operations[0];
  if (operation === undefined) return { data: null, errors: [{ message: 'no operation in document' }] };
  const mergedVariables: Record<string, unknown> = {};
  const ec: ExecCtx = { store, variables: mergedVariables, fragments: document.fragments, errors: [] };
  for (const [name, defaultNode] of operation.variableDefaults) mergedVariables[name] = valueOf(defaultNode, ec);
  for (const [name, value] of Object.entries(variables)) {
    if (value !== undefined) mergedVariables[name] = value;
  }
  const root = obj(operation.type === 'mutation' ? 'Mutation' : 'Query', null);
  const data = executeSet(root, operation.selectionSet, ec, []);
  const out: Record<string, unknown> = { data };
  if (ec.errors.length > 0) out.errors = ec.errors;
  return out;
}

/** Handle one POST /api/graphql request: a single operation or a batch array. */
export function handleGraphql(ctx: Ctx): Result {
  const parsed = jsonValue(ctx);
  if (!parsed.ok) return { status: 400, json: { errors: [{ message: 'request body is not valid JSON' }] } };
  const runOne = (entry: unknown): Record<string, unknown> => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { data: null, errors: [{ message: 'operation must be an object' }] };
    }
    const record = entry as Record<string, unknown>;
    const query = typeof record.query === 'string' ? record.query : '';
    if (query === '') return { data: null, errors: [{ message: 'query is required' }] };
    let document: DocumentNode;
    try {
      document = new Parser(lex(query)).parseDocument();
    } catch (error) {
      return { data: null, errors: [{ message: error instanceof Error ? error.message : 'parse error' }] };
    }
    const variables =
      record.variables !== null && typeof record.variables === 'object' && !Array.isArray(record.variables)
        ? (record.variables as Record<string, unknown>)
        : {};
    const operationName = typeof record.operationName === 'string' ? record.operationName : null;
    return executeOperation(ctx.store, document, operationName, variables);
  };
  if (Array.isArray(parsed.value)) {
    return { status: 200, json: parsed.value.map(runOne) };
  }
  return { status: 200, json: runOne(parsed.value) };
}
