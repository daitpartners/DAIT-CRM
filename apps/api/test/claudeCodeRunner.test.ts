import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeRunError, createClaudeCodeRunner, type ClaudeRunRequest } from '../src/research/providers';

// A fake `claude` executable: records its argv, environment, cwd and stdin to a file, then behaves as told.
type Behaviour =
  | { stdout: string; code?: number }
  | { hang: true; ignoreTerm?: boolean }
  | { flood: true };

let dir: string;
let n = 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fake-claude-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

async function fakeClaude(behaviour: Behaviour): Promise<{ bin: string; record: string }> {
  n += 1;
  const bin = join(dir, `claude-${n}`);
  const record = join(dir, `record-${n}.json`);
  const script = `#!${process.execPath}
const fs = require('node:fs');
const behaviour = ${JSON.stringify(behaviour)};
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { stdin += c; });
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd(), stdin, pid: process.pid }));
  if (behaviour.hang) {
    if (behaviour.ignoreTerm) process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
    return;
  }
  if (behaviour.flood) {
    const chunk = 'x'.repeat(64 * 1024);
    const write = () => { while (process.stdout.write(chunk)) {} process.stdout.once('drain', write); };
    write();
    return;
  }
  process.stdout.write(behaviour.stdout, () => process.exit(behaviour.code ?? 0));
});
`;
  await writeFile(bin, script);
  await chmod(bin, 0o755);
  return { bin, record };
}

type Recorded = { argv: string[]; env: Record<string, string>; cwd: string; stdin: string; pid: number };
const recorded = async (path: string): Promise<Recorded> => JSON.parse(await readFile(path, 'utf8')) as Recorded;

const schema = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false };
const request = (over: Partial<ClaudeRunRequest> = {}): ClaudeRunRequest => ({
  system: 'You research companies.', prompt: 'Company: Acme\n<page url="https://acme.example/">We build widgets.</page>',
  schema, webSearch: false, model: 'sonnet', signal: new AbortController().signal, ...over,
});
const success = (structured: unknown) =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '', structured_output: structured });
const TOKEN = 'sk-ant-oat01-test-token-0123456789';

const errorOf = async (p: Promise<unknown>): Promise<ClaudeRunError> => {
  try {
    await p;
  } catch (err) {
    return err as ClaudeRunError;
  }
  throw new Error('expected the run to fail');
};

describe('createClaudeCodeRunner', () => {
  test('passes only HOME, PATH and the token, the fixed flags with no tools, and the prompt on stdin', async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://secret@localhost/crm');
    vi.stubEnv('SESSION_SECRET', 'session-secret-value');
    const { bin, record } = await fakeClaude({ stdout: success({ summary: 'Acme makes widgets.' }) });
    const res = await createClaudeCodeRunner({ bin, token: TOKEN })(request());
    expect(res).toEqual({ output: { summary: 'Acme makes widgets.' } });

    const r = await recorded(record);
    // macOS may add __CF_USER_TEXT_ENCODING to a child's environment; nothing else is allowed.
    expect(Object.keys(r.env).filter((k) => k !== '__CF_USER_TEXT_ENCODING').sort()).toEqual(['CLAUDE_CODE_OAUTH_TOKEN', 'HOME', 'PATH']);
    expect(r.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN, PATH: '/usr/bin:/bin', HOME: process.env.HOME });
    expect(r.env.DATABASE_URL).toBeUndefined();
    expect(r.argv).toEqual([
      '-p', '--output-format', 'json', '--json-schema', JSON.stringify(schema), '--model', 'sonnet',
      '--system-prompt', 'You research companies.', '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence',
      '--tools', '',
    ]);
    // Page text only on stdin, never in argv.
    expect(r.stdin).toBe(request().prompt);
    expect(r.argv.join(' ')).not.toContain('We build widgets.');
    // A fresh temp directory, removed afterwards.
    expect(r.cwd).toContain('dait-claude-');
    expect(existsSync(r.cwd)).toBe(false);
  });

  test('with web search on: WebSearch is the only tool, and the only one allowed', async () => {
    const { bin, record } = await fakeClaude({ stdout: success({ summary: 'x' }) });
    await createClaudeCodeRunner({ bin, token: TOKEN })(request({ webSearch: true, model: 'opus' }));
    const { argv } = await recorded(record);
    expect(argv.slice(-4)).toEqual(['--tools', 'WebSearch', '--allowedTools', 'WebSearch']);
    expect(argv[argv.indexOf('--model') + 1]).toBe('opus');
  });

  test('not logged in / expired token is told apart from other failures', async () => {
    for (const result of ['Not logged in · Please run /login', 'OAuth token has expired', 'Failed to authenticate. API Error: 401']) {
      const { bin } = await fakeClaude({ stdout: JSON.stringify({ is_error: true, result }), code: 1 });
      const err = await errorOf(createClaudeCodeRunner({ bin, token: TOKEN })(request()));
      expect(err).toBeInstanceOf(ClaudeRunError);
      expect(err.message).toBe('Claude Code is not logged in on the server');
    }
    const { bin } = await fakeClaude({ stdout: JSON.stringify({ is_error: true, result: 'Rate limit reached' }), code: 1 });
    expect((await errorOf(createClaudeCodeRunner({ bin, token: TOKEN })(request()))).message).toBe('Claude Code failed');
  });

  test('bad JSON, a non-zero exit and a missing binary fail with "Claude Code failed"; the temp dir is removed', async () => {
    const bad = await fakeClaude({ stdout: 'Error: something broke' });
    const err = await errorOf(createClaudeCodeRunner({ bin: bad.bin, token: TOKEN })(request()));
    expect(err).toBeInstanceOf(ClaudeRunError);
    expect(err.message).toBe('Claude Code failed');
    expect(existsSync((await recorded(bad.record)).cwd)).toBe(false);

    const exit = await fakeClaude({ stdout: success({ summary: 'x' }), code: 2 });
    expect((await errorOf(createClaudeCodeRunner({ bin: exit.bin, token: TOKEN })(request()))).message).toBe('Claude Code failed');

    const missing = await errorOf(createClaudeCodeRunner({ bin: join(dir, 'no-such-claude'), token: TOKEN })(request()));
    expect(missing.message).toBe('Claude Code failed');
  });

  test('error messages never carry the token or the CLI output', async () => {
    const { bin } = await fakeClaude({ stdout: JSON.stringify({ is_error: true, result: `bad token ${TOKEN}` }), code: 1 });
    const err = await errorOf(createClaudeCodeRunner({ bin, token: TOKEN })(request()));
    expect(err.message).toBe('Claude Code failed');
    expect(JSON.stringify({ ...err, message: err.message })).not.toContain(TOKEN);
  });

  test('a timeout kills the child (SIGKILL when it ignores SIGTERM)', async () => {
    const { bin, record } = await fakeClaude({ hang: true, ignoreTerm: true });
    const started = Date.now();
    const err = await errorOf(createClaudeCodeRunner({ bin, token: TOKEN, timeoutMs: 3000 })(request()));
    expect(err.message).toBe('Claude took too long');
    expect(Date.now() - started).toBeLessThan(10_000);
    const { pid, cwd } = await recorded(record);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(existsSync(cwd)).toBe(false);
  });

  test('an abort (the step deadline) kills the child', async () => {
    const { bin, record } = await fakeClaude({ hang: true });
    const ctrl = new AbortController();
    const pending = createClaudeCodeRunner({ bin, token: TOKEN })(request({ signal: ctrl.signal }));
    await vi.waitFor(() => expect(existsSync(record)).toBe(true));
    ctrl.abort();
    expect((await errorOf(pending)).message).toBe('Claude took too long');
    const { pid } = await recorded(record);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  test('output beyond the cap kills the child', async () => {
    const { bin } = await fakeClaude({ flood: true });
    const err = await errorOf(createClaudeCodeRunner({ bin, token: TOKEN })(request()));
    expect(err.message).toBe('Claude Code failed');
  });
});
