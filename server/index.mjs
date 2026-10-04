#!/usr/bin/env node
// Jev Decision Layer: zero-dependency stdio MCP server.
// JSON-RPC 2.0 over newline-delimited stdin/stdout. stdout carries ONLY JSON-RPC
// messages; all logs go to stderr and never include the API key.
//
// Data shape (returned by every tool):
//   Decision = { tool, selected, probabilities: { [option]: number }, confidence, raw? }
//
// Every tool builds exactly ONE TypeSafe Choice question and returns a Decision.
// Nothing is ever executed: the result is advisory only.

import { createInterface } from 'node:readline';

const SERVER_INFO = { name: 'jev-decision-layer', version: '0.1.0' };
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const DECISION_NOTICE =
  'DECISION ONLY: this is an advisory decision. Nothing was executed, changed, sent, or verified by this tool; ' +
  'the caller must not treat it as having executed anything.';

// ---------------------------------------------------------------------------
// TypeSafe API adapter: the ONE place to adjust if the API contract changes.
// Source: https://api.typesafe.ai/openapi.json (TypeSafe 0.2.0), POST /v1/systemone
//   request:  { model, state, questions: { <id>: { type: "choice", instructions, criteria: { <option>: description } } } }
//   response: { model, answers: { <id>: { type: "choice", choice, probabilities: { <option>: n }, confidence } }, usage }
// ---------------------------------------------------------------------------
export const API = {
  baseUrl: () => (process.env.TYPESAFE_BASE_URL || 'https://api.typesafe.ai').replace(/\/+$/, ''),
  path: '/v1/systemone',
  model: () => process.env.TYPESAFE_MODEL || 'jev-latest',
  timeoutMs: () => Number(process.env.TYPESAFE_TIMEOUT_MS) || 30000,
  questionId: 'decision',

  /** Build the request body for a single Choice question. */
  buildChoiceRequest({ state, instructions, options }) {
    return {
      model: API.model(),
      state,
      questions: {
        [API.questionId]: { type: 'choice', instructions, criteria: options },
      },
    };
  },

  /** Extract { selected, probabilities, confidence } from the response; throw if the shape is unexpected. */
  parseChoiceResponse(body, optionNames) {
    const ans = body && typeof body === 'object' && body.answers && body.answers[API.questionId];
    if (!ans || typeof ans !== 'object') throw new ShapeError('response.answers.decision missing');
    if (ans.type !== undefined && ans.type !== 'choice') throw new ShapeError(`answer type is "${ans.type}", expected "choice"`);
    const selected = ans.choice;
    if (typeof selected !== 'string') throw new ShapeError('answer.choice is not a string');
    if (!optionNames.includes(selected)) throw new ShapeError(`answer.choice "${selected}" is not one of the requested options`);
    const p = ans.probabilities;
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw new ShapeError('answer.probabilities is not an object');
    const probabilities = {};
    for (const k of optionNames) {
      if (typeof p[k] !== 'number' || !Number.isFinite(p[k])) throw new ShapeError(`answer.probabilities["${k}"] missing or not a number`);
      probabilities[k] = p[k];
    }
    if (typeof ans.confidence !== 'number' || !Number.isFinite(ans.confidence)) throw new ShapeError('answer.confidence is not a number');
    return { selected, probabilities, confidence: ans.confidence, raw: { model: body.model, answer: ans, usage: body.usage } };
  },
};

class ShapeError extends Error {}
class ToolError extends Error {}

// ---------------------------------------------------------------------------
// Secrets & logging
// ---------------------------------------------------------------------------
function getApiKey() {
  const v = process.env.TYPESAFE_API_KEY;
  // Treat an unsubstituted host placeholder like "${TYPESAFE_API_KEY}" as missing.
  if (!v || !v.trim() || /^\$\{[^}]*\}$/.test(v.trim())) return null;
  return v.trim();
}
function redact(text) {
  let s = String(text);
  const k = process.env.TYPESAFE_API_KEY;
  if (k && k.trim().length >= 4) s = s.split(k.trim()).join('[REDACTED]');
  return s.replace(/(Bearer\s+)[^\s"',}]+/gi, '$1[REDACTED]');
}
function log(...args) {
  process.stderr.write(redact(`[jev-decision-layer] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`) + '\n');
}
const DEBUG = process.env.JEV_DEBUG === '1';

// ---------------------------------------------------------------------------
// HTTP call
// ---------------------------------------------------------------------------
async function askChoice({ tool, state, instructions, options }) {
  const key = getApiKey();
  if (!key) throw new ToolError('TYPESAFE_API_KEY is not set. Configure it in the plugin variables / environment; no request was sent.');
  const optionNames = Object.keys(options);
  const body = API.buildChoiceRequest({ state, instructions, options });
  const url = API.baseUrl() + API.path;
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${key}` };
  if (DEBUG) log('request', { url, headers: { ...headers, Authorization: 'Bearer [REDACTED]' }, body });

  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(API.timeoutMs()) });
  } catch (e) {
    throw new ToolError(redact(`TypeSafe request failed (${e.name}): ${e.message}`));
  }
  const text = await res.text();
  if (DEBUG) log('response', res.status, text.slice(0, 2000));
  if (!res.ok) {
    throw new ToolError(redact(`TypeSafe API HTTP ${res.status} ${res.statusText}: ${text.slice(0, 800)}`));
  }
  let json;
  try { json = JSON.parse(text); } catch { throw new ToolError(redact(`TypeSafe API returned non-JSON (HTTP ${res.status}): ${text.slice(0, 300)}`)); }
  try {
    const parsed = API.parseChoiceResponse(json, optionNames);
    /** @type {Decision} */
    const decision = { tool, ...parsed };
    return decision;
  } catch (e) {
    if (e instanceof ShapeError) throw new ToolError(redact(`Unexpected TypeSafe response shape: ${e.message}. Body: ${text.slice(0, 500)}`));
    throw e;
  }
}
/**
 * @typedef {{ tool: string, selected: string, probabilities: Record<string, number>, confidence: number, raw?: unknown }} Decision
 */

// ---------------------------------------------------------------------------
// Minimal JSON Schema validator (subset used by our tool schemas)
// ---------------------------------------------------------------------------
function validate(schema, value, path = 'arguments') {
  const errs = [];
  const t = schema.type;
  const typeOk =
    t === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
    : t === 'array' ? Array.isArray(value)
    : t === 'string' ? typeof value === 'string'
    : t === undefined ? true : typeof value === t;
  if (!typeOk) return [`${path} must be of type ${t}`];
  if (t === 'string') {
    if (schema.minLength && value.trim().length < schema.minLength) errs.push(`${path} must be a non-empty string`);
    if (schema.maxLength && value.length > schema.maxLength) errs.push(`${path} must be at most ${schema.maxLength} characters`);
  }
  if (t === 'array') {
    if (schema.minItems && value.length < schema.minItems) errs.push(`${path} must contain at least ${schema.minItems} items`);
    if (schema.maxItems && value.length > schema.maxItems) errs.push(`${path} must contain at most ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => errs.push(...validate(schema.items, v, `${path}[${i}]`)));
  }
  if (t === 'object') {
    for (const r of schema.required || []) if (!(r in value)) errs.push(`${path}.${r} is required`);
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties && schema.properties[k]) errs.push(...validate(schema.properties[k], v, `${path}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${path}.${k} is not an allowed property`);
    }
  }
  return errs;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------
const str = (description, maxLength = 8000) => ({ type: 'string', minLength: 1, maxLength, description });
const decisionOutputSchema = (extra = {}) => ({
  type: 'object',
  properties: {
    decision_only: { type: 'boolean', const: true },
    notice: { type: 'string' },
    tool: { type: 'string' },
    ...extra,
    selected: { type: 'string' },
    probabilities: { type: 'object', additionalProperties: { type: 'number' } },
    confidence: { type: 'number' },
  },
  required: ['decision_only', 'notice', 'tool', 'selected', 'probabilities', 'confidence', ...Object.keys(extra)],
});

const TOOLS = [
  {
    name: 'jev_route_worker',
    title: 'Route to worker (decision only)',
    description:
      'Decide which available worker should take the next step toward an objective. Asks TypeSafe one Choice question whose options are the worker names. Returns selected_worker, probabilities and confidence. Decision only: it does not dispatch or run any worker.',
    inputSchema: {
      type: 'object',
      properties: {
        objective: str('The overall goal being pursued.'),
        completed_work: str('What has been done so far (use "none" if nothing).'),
        blockers: str('Current blockers or open problems (use "none" if none).'),
        available_workers: {
          type: 'array', minItems: 2, maxItems: 255,
          description: 'Candidate workers. Names must be unique; they become the Choice options.',
          items: {
            type: 'object',
            properties: { name: str('Unique worker name (choice option key).', 128), job_description: str('What this worker does / when it applies.', 2000) },
            required: ['name', 'job_description'],
            additionalProperties: false,
          },
        },
      },
      required: ['objective', 'completed_work', 'blockers', 'available_workers'],
      additionalProperties: false,
    },
    outputSchema: decisionOutputSchema({ selected_worker: { type: 'string' } }),
    build(a) {
      const names = a.available_workers.map((w) => w.name.trim());
      const dup = names.find((n, i) => names.indexOf(n) !== i);
      if (dup) throw new ToolError(`available_workers names must be unique; duplicate: "${dup}"`);
      return {
        state: { objective: a.objective, completed_work: a.completed_work, blockers: a.blockers },
        instructions: 'Choose the single worker best suited to perform the next step toward the objective, given the completed work and current blockers.',
        options: Object.fromEntries(a.available_workers.map((w) => [w.name.trim(), w.job_description])),
      };
    },
  },
  {
    name: 'jev_check_research',
    title: 'Check a research claim (decision only)',
    description:
      'Decide whether a research claim should be accepted, verified further, or rejected given the evidence, source quality and known conflicts. One Choice question: accept | verify_more | reject. Decision only: it does not look anything up.',
    inputSchema: {
      type: 'object',
      properties: {
        claim: str('The claim under evaluation.'),
        evidence: str('Evidence supporting or refuting the claim.'),
        source_quality: str('Description of the sources (e.g. peer-reviewed, official docs, blog, unknown).'),
        known_conflicts: str('Known contradicting evidence or conflicts (use "none" if none).'),
      },
      required: ['claim', 'evidence', 'source_quality', 'known_conflicts'],
      additionalProperties: false,
    },
    outputSchema: decisionOutputSchema(),
    build: (a) => ({
      state: { claim: a.claim, evidence: a.evidence, source_quality: a.source_quality, known_conflicts: a.known_conflicts },
      instructions: 'Decide how to treat the claim given the evidence, the quality of the sources and any known conflicts.',
      options: {
        accept: 'The evidence is sufficient and reliable, with no unresolved conflicts; the claim can be used as stated.',
        verify_more: 'The claim is plausible but evidence is thin, sources are weak, or conflicts exist; more verification is needed before relying on it.',
        reject: 'The evidence contradicts the claim or is unreliable; the claim should not be used.',
      },
    }),
  },
  {
    name: 'jev_review_completion',
    title: 'Review task completion (decision only)',
    description:
      'Decide whether a task is complete against its original objective and required outputs, given the completed work, verification performed and known gaps. One Choice question: complete | verify_more | incomplete. Decision only: it does not verify or finish anything.',
    inputSchema: {
      type: 'object',
      properties: {
        original_objective: str('The objective as originally stated.'),
        required_outputs: str('The outputs/deliverables that were required.'),
        completed_work: str('What was actually produced/done.'),
        verification: str('How the work was verified (tests run, checks, evidence). Use "none" if unverified.'),
        known_gaps: str('Known gaps, skipped items or caveats (use "none" if none).'),
      },
      required: ['original_objective', 'required_outputs', 'completed_work', 'verification', 'known_gaps'],
      additionalProperties: false,
    },
    outputSchema: decisionOutputSchema(),
    build: (a) => ({
      state: { original_objective: a.original_objective, required_outputs: a.required_outputs, completed_work: a.completed_work, verification: a.verification, known_gaps: a.known_gaps },
      instructions: 'Decide whether the completed work fully satisfies the original objective and every required output, considering the verification performed and known gaps.',
      options: {
        complete: 'Every required output is delivered and adequately verified, with no material gaps.',
        verify_more: 'The outputs appear delivered but verification is missing or insufficient to be confident.',
        incomplete: 'One or more required outputs are missing, or known gaps are material.',
      },
    }),
  },
  {
    name: 'jev_guard_action',
    title: 'Guard a proposed action (decision only)',
    description:
      'Decide whether a proposed action may proceed, given its target, side effects, reversibility and the existing approval policy. One Choice question: allow | confirm | human_review | deny. Decision only: it never performs the action. Outcomes confirm, human_review and deny mean STOP and ask a human.',
    inputSchema: {
      type: 'object',
      properties: {
        proposed_action: str('The exact action/command proposed.'),
        target: str('What the action touches (system, file, account, recipient).'),
        side_effects: str('Expected side effects (use "none" if read-only).'),
        reversibility: str('How reversible the action is (e.g. read-only, easily undone, irreversible).'),
        existing_approval_policy: str('The approval policy in force for this kind of action.'),
      },
      required: ['proposed_action', 'target', 'side_effects', 'reversibility', 'existing_approval_policy'],
      additionalProperties: false,
    },
    outputSchema: decisionOutputSchema(),
    build: (a) => ({
      state: { proposed_action: a.proposed_action, target: a.target, side_effects: a.side_effects, reversibility: a.reversibility, existing_approval_policy: a.existing_approval_policy },
      instructions: 'Decide how the proposed action should be gated, considering its target, side effects, reversibility and the existing approval policy.',
      options: {
        allow: 'Safe to proceed without asking: read-only or trivially reversible, low impact, and permitted by the approval policy.',
        confirm: 'Probably fine but has some side effect or ambiguity; the user should confirm before it runs.',
        human_review: 'Significant, external, or hard-to-reverse effects, or the policy requires approval; a human must review it first.',
        deny: 'Destructive, unsafe, or clearly disallowed by the approval policy; it should not be performed.',
      },
    }),
  },
];
const TOOL_BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

async function callTool(name, args) {
  const tool = TOOL_BY_NAME[name];
  if (!tool) return { unknown: true };
  const errs = validate(tool.inputSchema, args ?? {});
  if (errs.length) throw new ToolError(`Invalid arguments for ${name}: ${errs.join('; ')}`);
  const q = tool.build(args);
  const decision = await askChoice({ tool: name, ...q });
  const result = { decision_only: true, notice: DECISION_NOTICE, tool: name };
  if (name === 'jev_route_worker') result.selected_worker = decision.selected;
  Object.assign(result, { selected: decision.selected, probabilities: decision.probabilities, confidence: decision.confidence, raw: decision.raw });
  return { result };
}

// ---------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const replyErr = (id, code, message, data) => send({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });
const toolError = (text) => ({ content: [{ type: 'text', text: `ERROR: ${text}\n${DECISION_NOTICE}` }], isError: true });

async function handle(msg) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    if (msg && msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) return; // a response to us; ignore
    return replyErr(msg?.id ?? null, -32600, 'Invalid Request');
  }
  const { id, method, params } = msg;
  const isNotification = id === undefined;
  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      return reply(id, {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: 'Advisory decision tools backed by TypeSafe Jev. Results are decisions only; nothing is executed.',
      });
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return;
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: TOOLS.map(({ name, title, description, inputSchema, outputSchema }) => ({ name, title, description, inputSchema, outputSchema })) });
    case 'tools/call': {
      const name = params?.name;
      try {
        const out = await callTool(name, params?.arguments);
        if (out.unknown) return replyErr(id, -32602, `Unknown tool: ${redact(String(name))}`);
        const { raw, ...summary } = out.result;
        return reply(id, {
          content: [{ type: 'text', text: `${DECISION_NOTICE}\n${JSON.stringify(summary, null, 2)}` }],
          structuredContent: out.result,
          isError: false,
        });
      } catch (e) {
        if (e instanceof ToolError) { log(`tool ${name} error:`, e.message); return reply(id, toolError(e.message)); }
        log(`tool ${name} internal error:`, e?.stack || String(e));
        return reply(id, toolError('Internal error in jev-decision-layer server.'));
      }
    }
    default:
      if (isNotification) return;
      return replyErr(id, -32601, `Method not found: ${method}`);
  }
}

const inflight = new Set();
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return replyErr(null, -32700, 'Parse error'); }
  for (const m of Array.isArray(msg) ? msg : [msg]) {
    const p = handle(m).catch((e) => log('handler crash:', e?.stack || String(e)));
    inflight.add(p);
    p.finally(() => inflight.delete(p));
  }
});
// On stdin EOF, let in-flight tool calls finish and flush their responses before exiting.
rl.on('close', async () => { await Promise.allSettled([...inflight]); process.exit(0); });
log(`ready (base ${API.baseUrl()}, model ${API.model()}, key ${getApiKey() ? 'present' : 'missing'})`);
