#!/usr/bin/env node
// Zero-dependency structural checks for both manifest formats, plus a launch test of the
// Cursor MCP config with ${CURSOR_PLUGIN_ROOT} expanded the way Cursor does it.
import { readFileSync, existsSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const j = (p) => JSON.parse(readFileSync(path.join(ROOT, p), 'utf8'));
let n = 0; const ok = (m) => { n++; console.log(`  ok - ${m}`); };
const NAME_RE = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const safeRel = (p) => typeof p === 'string' && !path.isAbsolute(p) && !path.posix.normalize(p).startsWith('..');

console.log('# manifest checks');
// Agent Plugins root manifest (closed schema)
const ap = j('plugin.json');
assert.equal(ap.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
const apAllowed = ['$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'extensions'];
for (const k of Object.keys(ap)) assert.ok(apAllowed.includes(k), `plugin.json: field "${k}" not allowed by Agent Plugins schema`);
assert.match(ap.name, NAME_RE);
for (const k of Object.keys(ap.author || {})) assert.ok(['name', 'email', 'url'].includes(k));
ok('plugin.json conforms to the closed Agent Plugins 1.0.0 manifest fields');

const am = j('mcp.json');
assert.equal(am.$schema, 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
assert.deepEqual(Object.keys(am).sort(), ['$schema', 'mcpServers']);
for (const [id, s] of Object.entries(am.mcpServers)) {
  assert.equal(s.type, 'stdio', id);
  for (const k of Object.keys(s)) assert.ok(['type', 'command', 'args', 'env', 'cwd'].includes(k), `${id}: ${k}`);
  assert.match(s.cwd, /^(?:\.\/|\$\{PLUGIN_ROOT\}(?:\/|$)|\$\{PLUGIN_DATA\}(?:\/|$))/);
  assert.ok(!('PLUGIN_ROOT' in (s.env || {})) && !('PLUGIN_DATA' in (s.env || {})));
}
ok('mcp.json conforms to Agent Plugins stdio server rules');

// Cursor Plugin manifest
const cp = j('.cursor-plugin/plugin.json');
assert.match(cp.name, NAME_RE);
assert.equal(cp.name, ap.name, 'name must match across manifests');
assert.equal(cp.version, ap.version, 'version must match across manifests');
assert.equal(typeof cp.author?.name, 'string');
for (const f of ['logo', 'rules', 'skills', 'agents', 'commands', 'hooks', 'mcpServers']) {
  if (typeof cp[f] !== 'string') continue;
  assert.ok(safeRel(cp[f]), `${f} path must be relative without ..`);
  assert.ok(existsSync(path.join(ROOT, cp[f])), `${f} path ${cp[f]} must exist`);
}
assert.ok(statSync(path.join(ROOT, 'skills/jev-decision-layer/SKILL.md')).isFile());
const v = cp.variables;
assert.equal(v.type, 'object');
const allowedKw = new Set(['type', 'title', 'description', 'default', 'enum', 'const', 'properties', 'required', 'items', 'minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems', 'pattern']);
const walk = (s) => { for (const [k, val] of Object.entries(s)) { assert.ok(allowedKw.has(k), `variables: keyword "${k}" not accepted by Cursor`); if (k === 'properties') Object.values(val).forEach(walk); if (k === 'items') walk(val); } };
walk(v);
ok('.cursor-plugin/plugin.json: valid name/paths, variables uses only Cursor-accepted keywords');

const cm = j(cp.mcpServers);
const text = JSON.stringify(cm);
const vars = [...text.matchAll(/\$\{([A-Z0-9_]+)\}/g)].map((m) => m[1]);
for (const name of vars) {
  if (name === 'CURSOR_PLUGIN_ROOT') continue;
  assert.ok(name in v.properties, `\${${name}} used in Cursor MCP config but not declared in variables`);
}
assert.ok(!text.includes('${PLUGIN_ROOT}'), 'Cursor config must not use ${PLUGIN_ROOT} (Cursor does not expand it)');
assert.ok(text.includes('${CURSOR_PLUGIN_ROOT}'));
ok('Cursor MCP config uses ${CURSOR_PLUGIN_ROOT}; every ${VAR} is declared in variables');

// Launch the Cursor config the way Cursor would (expand placeholders, run from a different cwd).
const srv = Object.values(cm.mcpServers)[0];
const expand = (s) => s.replaceAll('${CURSOR_PLUGIN_ROOT}', ROOT).replaceAll('${TYPESAFE_API_KEY}', 'offline-test-placeholder');
const child = spawn(srv.command === 'node' ? process.execPath : srv.command, srv.args.map(expand), {
  cwd: expand(srv.cwd), env: { PATH: process.env.PATH, ...Object.fromEntries(Object.entries(srv.env).map(([k, val]) => [k, expand(val)])) },
});
const reply = await new Promise((resolve, reject) => {
  let buf = '';
  const t = setTimeout(() => reject(new Error('timeout')), 10000);
  child.stdout.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) { clearTimeout(t); resolve(JSON.parse(buf.slice(0, i))); } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
});
child.stdin.end();
assert.equal(reply.result.tools.length, 4);
ok('server starts from the expanded Cursor MCP config and lists 4 tools');
console.log(`# all ${n} manifest checks passed`);
