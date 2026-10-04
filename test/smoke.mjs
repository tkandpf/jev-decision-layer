#!/usr/bin/env node
// Smoke tests for the Jev Decision Layer MCP server.
//   node test/smoke.mjs          offline: local mock of POST /v1/systemone (no network, fake key)
//   node test/smoke.mjs --live   live: real TypeSafe API, requires TYPESAFE_API_KEY in the environment
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const LIVE = process.argv.includes('--live');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'server', 'index.mjs');
// Obviously-fake placeholder used ONLY against the local mock server.
const FAKE_KEY = 'offline-test-placeholder';

let passed = 0;
const ok = (msg) => { passed++; console.log(`  ok - ${msg}`); };

// ---------- MCP client over stdio ----------
function startServer(env) {
  const child = spawn(process.execPath, [SERVER], { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  const pending = new Map();
  const stdoutLines = [];
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      stdoutLines.push(line);
      const msg = JSON.parse(line); // throws => non-JSON on stdout => test fails
      assert.equal(msg.jsonrpc, '2.0');
      pending.get(msg.id)?.(msg); pending.delete(msg.id);
    }
  });
  let nextId = 1;
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 60000);
    pending.set(id, (m) => { clearTimeout(t); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  const stop = () => new Promise((r) => { child.on('exit', r); child.stdin.end(); });
  return { request, notify, stop, stdoutLines, get stderr() { return stderr; } };
}

// ---------- Safe example per tool ----------
const EXAMPLES = [
  {
    tool: 'jev_route_worker',
    options: ['researcher', 'writer'],
    args: {
      objective: 'Write a short, accurate paragraph about the boiling point of water.',
      completed_work: 'none',
      blockers: 'We do not yet have a verified source for the boiling point at sea level.',
      available_workers: [
        { name: 'researcher', job_description: 'Finds and verifies facts and sources.' },
        { name: 'writer', job_description: 'Drafts prose from already-verified facts.' },
      ],
    },
  },
  {
    tool: 'jev_check_research',
    options: ['accept', 'verify_more', 'reject'],
    args: {
      claim: 'Water boils at 100°C at sea level',
      evidence: 'Standard physics references state pure water boils at 100°C (212°F) at 1 atm (101.325 kPa).',
      source_quality: 'Widely cited textbook / encyclopedia references.',
      known_conflicts: 'none',
    },
  },
  {
    tool: 'jev_review_completion',
    options: ['complete', 'verify_more', 'incomplete'],
    args: {
      original_objective: 'Create a file /tmp/hello.txt containing the text "hello".',
      required_outputs: '/tmp/hello.txt with content "hello".',
      completed_work: 'Created /tmp/hello.txt with content "hello".',
      verification: 'Ran `cat /tmp/hello.txt` and it printed "hello".',
      known_gaps: 'none',
    },
  },
  {
    tool: 'jev_guard_action',
    options: ['allow', 'confirm', 'human_review', 'deny'],
    args: {
      proposed_action: 'ls /tmp',
      target: 'Local /tmp directory listing on the agent sandbox',
      side_effects: 'none (read-only)',
      reversibility: 'read-only; nothing to reverse',
      existing_approval_policy: 'Read-only local commands may run without approval; writes, deletes and external sends need approval.',
    },
  },
];

// ---------- Mock TypeSafe server (mimics the documented SystemOneResponse) ----------
function startMock() {
  const seen = [];
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const rec = { method: req.method, url: req.url, auth: req.headers.authorization, ctype: req.headers['content-type'], body: JSON.parse(body || 'null') };
      seen.push(rec);
      if (req.method !== 'POST' || req.url !== '/v1/systemone') { res.writeHead(404); return res.end('{"detail":"Not Found"}'); }
      if (rec.auth !== `Bearer ${FAKE_KEY}`) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"detail":"bad key"}'); }
      const answers = {};
      for (const [qid, q] of Object.entries(rec.body.questions)) {
        const opts = Object.keys(q.criteria);
        const rest = opts.length > 1 ? 0.3 / (opts.length - 1) : 0;
        const probabilities = Object.fromEntries(opts.map((o, i) => [o, i === 0 ? 0.7 : rest]));
        answers[qid] = { type: 'choice', choice: opts[0], probabilities, confidence: 0.55 };
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'jev-mock', answers, usage: { input_tokens: 10, output_tokens: 1 } }));
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, seen, url: `http://127.0.0.1:${srv.address().port}` })));
}

function checkDecision(ex, res) {
  assert.equal(res.error, undefined, `JSON-RPC error: ${JSON.stringify(res.error)}`);
  const r = res.result;
  assert.equal(r.isError, false, `tool error: ${r.content?.[0]?.text}`);
  assert.match(r.content[0].text, /DECISION ONLY/);
  assert.match(r.content[0].text, /must not treat it as having executed anything/);
  const d = r.structuredContent;
  assert.equal(d.decision_only, true);
  assert.equal(d.tool, ex.tool);
  assert.ok(ex.options.includes(d.selected), `selected ${d.selected} not in options`);
  assert.deepEqual(Object.keys(d.probabilities).sort(), [...ex.options].sort());
  for (const v of Object.values(d.probabilities)) assert.ok(typeof v === 'number' && v >= 0 && v <= 1);
  assert.ok(typeof d.confidence === 'number' && d.confidence >= 0 && d.confidence <= 1);
  if (ex.tool === 'jev_route_worker') assert.equal(d.selected_worker, d.selected);
  return d;
}

async function handshake(c) {
  const init = await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
  assert.equal(init.result.serverInfo.name, 'jev-decision-layer');
  assert.ok(init.result.capabilities.tools);
  c.notify('notifications/initialized');
  ok(`initialize (protocol ${init.result.protocolVersion})`);
  const list = await c.request('tools/list', {});
  const names = list.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['jev_check_research', 'jev_guard_action', 'jev_review_completion', 'jev_route_worker']);
  for (const t of list.result.tools) {
    assert.equal(t.inputSchema.type, 'object');
    assert.ok(t.inputSchema.required.length >= 4);
    assert.equal(t.inputSchema.additionalProperties, false);
  }
  ok('tools/list returns 4 tools with JSON Schema inputs');
}

async function offline() {
  console.log('# offline smoke tests (mock TypeSafe API)');
  const mock = await startMock();
  const env = { PATH: process.env.PATH, TYPESAFE_API_KEY: FAKE_KEY, TYPESAFE_BASE_URL: mock.url, JEV_DEBUG: '1' };
  const c = startServer(env);
  try {
    await handshake(c);
    for (const ex of EXAMPLES) {
      const before = mock.seen.length;
      const res = await c.request('tools/call', { name: ex.tool, arguments: ex.args });
      const d = checkDecision(ex, res);
      assert.equal(mock.seen.length, before + 1, 'exactly one HTTP request per tool call');
      const req = mock.seen.at(-1);
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/v1/systemone');
      assert.equal(req.auth, `Bearer ${FAKE_KEY}`);
      assert.match(req.ctype, /application\/json/);
      assert.equal(typeof req.body.model, 'string');
      assert.ok(req.body.state && typeof req.body.state === 'object');
      const qs = Object.values(req.body.questions);
      assert.equal(qs.length, 1, 'exactly one question');
      assert.equal(qs[0].type, 'choice');
      assert.equal(typeof qs[0].instructions, 'string');
      assert.deepEqual(Object.keys(qs[0].criteria), ex.options);
      assert.equal(d.selected, ex.options[0]);
      assert.equal(d.probabilities[ex.options[0]], 0.7);
      assert.equal(d.confidence, 0.55);
      ok(`${ex.tool}: request shape + Decision {selected=${d.selected}, confidence=${d.confidence}}`);
    }

    // Validation errors
    let r = await c.request('tools/call', { name: 'jev_guard_action', arguments: { proposed_action: 'ls' } });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /arguments\.target is required/);
    r = await c.request('tools/call', { name: 'jev_route_worker', arguments: { ...EXAMPLES[0].args, available_workers: [{ name: 'a', job_description: 'x' }, { name: 'a', job_description: 'y' }] } });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /duplicate/);
    r = await c.request('tools/call', { name: 'jev_check_research', arguments: { ...EXAMPLES[1].args, extra: 1 } });
    assert.match(r.result.content[0].text, /not an allowed property/);
    r = await c.request('tools/call', { name: 'nope', arguments: {} });
    assert.equal(r.error.code, -32602);
    r = await c.request('bogus/method', {});
    assert.equal(r.error.code, -32601);
    ok('invalid inputs / unknown tool / unknown method give clear errors');
  } finally {
    await c.stop();
  }
  assert.ok(!c.stderr.includes(FAKE_KEY), 'key must never appear in stderr logs');
  assert.match(c.stderr, /Bearer \[REDACTED\]/, 'debug output redacts Authorization');
  for (const line of c.stdoutLines) assert.ok(!line.includes(FAKE_KEY), 'key must never appear on stdout');
  ok('key never appears on stdout/stderr; debug Authorization is redacted; stdout is pure JSON-RPC');

  // Missing key -> clear tool error, no HTTP request
  for (const keyVal of [undefined, '${TYPESAFE_API_KEY}']) {
    const before = mock.seen.length;
    const e2 = { PATH: process.env.PATH, TYPESAFE_BASE_URL: mock.url };
    if (keyVal !== undefined) e2.TYPESAFE_API_KEY = keyVal;
    const c2 = startServer(e2);
    await c2.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
    const r2 = await c2.request('tools/call', { name: EXAMPLES[3].tool, arguments: EXAMPLES[3].args });
    assert.equal(r2.result.isError, true);
    assert.match(r2.result.content[0].text, /TYPESAFE_API_KEY is not set/);
    assert.equal(mock.seen.length, before, 'no HTTP request without a key');
    await c2.stop();
  }
  ok('missing / unsubstituted key -> clear tool error, no request sent');

  // Upstream error and malformed shape -> tool errors, no invented data
  const bad = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.headers['x-mode'] === undefined && bad.mode === 'http') { res.writeHead(422, { 'content-type': 'application/json' }); return res.end('{"detail":[{"msg":"Field required"}]}'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'x', answers: { decision: { type: 'choice', choice: 'not_an_option', probabilities: {}, confidence: 0.9 } }, usage: {} }));
    });
  });
  await new Promise((r) => bad.listen(0, '127.0.0.1', r));
  for (const mode of ['http', 'shape']) {
    bad.mode = mode;
    const c3 = startServer({ PATH: process.env.PATH, TYPESAFE_API_KEY: FAKE_KEY, TYPESAFE_BASE_URL: `http://127.0.0.1:${bad.address().port}` });
    const r3 = await c3.request('tools/call', { name: EXAMPLES[3].tool, arguments: EXAMPLES[3].args });
    assert.equal(r3.result.isError, true);
    assert.match(r3.result.content[0].text, mode === 'http' ? /HTTP 422/ : /Unexpected TypeSafe response shape/);
    assert.ok(!r3.result.content[0].text.includes(FAKE_KEY));
    assert.equal(r3.result.structuredContent, undefined);
    await c3.stop();
  }
  bad.close();
  ok('HTTP error and malformed response -> tool error, no Decision invented');
  mock.srv.close();
}

async function live() {
  console.log('# LIVE smoke tests (real TypeSafe API)');
  if (!process.env.TYPESAFE_API_KEY) { console.error('TYPESAFE_API_KEY is not set; cannot run --live.'); process.exit(2); }
  const c = startServer({ ...process.env });
  let failures = 0;
  try {
    await handshake(c);
    for (const ex of EXAMPLES) {
      const res = await c.request('tools/call', { name: ex.tool, arguments: ex.args });
      try {
        const d = checkDecision(ex, res);
        ok(`${ex.tool}: selected=${d.selected} confidence=${d.confidence} probabilities=${JSON.stringify(d.probabilities)} model=${d.raw?.model}`);
      } catch (e) {
        failures++;
        console.log(`  FAIL - ${ex.tool}: ${res.result?.content?.[0]?.text ?? JSON.stringify(res.error)}`);
      }
    }
  } finally {
    await c.stop();
  }
  const k = process.env.TYPESAFE_API_KEY.trim();
  assert.ok(!c.stderr.includes(k) && !c.stdoutLines.some((l) => l.includes(k)), 'key leaked into output');
  ok('key never appears on stdout/stderr');
  if (failures) { console.log(`# ${failures} live tool call(s) failed`); process.exit(1); }
}

try {
  await (LIVE ? live() : offline());
  console.log(`# all ${passed} checks passed`);
} catch (e) {
  console.error('# FAILED:', e.message);
  process.exit(1);
}
