# Jev Decision Layer (`jev-decision-layer`)

Four **advisory decision** tools for AI agents. They come from a zero-dependency stdio MCP server backed by
the [TypeSafe](https://api.typesafe.ai/redoc) System One API (Jev model). Each tool builds exactly one
**Choice** question and returns a decision. **Nothing is ever executed.**

The repo ships as both a **Cursor Plugin** (`.cursor-plugin/plugin.json`) and a portable
**[Agent Plugin](https://agent-plugins.org)** (root `plugin.json`).

## Install

### Cursor, local install (from GitHub)

```bash
mkdir -p ~/.cursor/plugins/local
git clone https://github.com/tkandpf/jev-decision-layer ~/.cursor/plugins/local/jev-decision-layer
```

Then run **Developer: Reload Window** (or restart Cursor), open **Customize**, and confirm that the
`jev-decision-layer` skill and MCP server appear. Node.js ≥ 18.17 must be on `PATH`.
On Teams/Enterprise, an admin must enable *Allow Local Plugin Imports*.

### Cursor, from a marketplace

When it's listed (Cursor Marketplace, a team marketplace, or cursor.directory), open **Customize**, find
**Jev Decision Layer**, select **Install**, and choose project or user scope.

### Other Agent Plugins hosts

Point the host at this directory. It reads the root `plugin.json`, `mcp.json`, and `skills/`.

## Set `TYPESAFE_API_KEY`

The key is a secret. Never commit it, and never put it in `mcp.json` or any other file in this repo.

- **Cursor:** the plugin declares `TYPESAFE_API_KEY` under `variables` in `.cursor-plugin/plugin.json`. Set
  the value under **Plugins → Configure** (at install or later). Cursor substitutes it into the
  `${TYPESAFE_API_KEY}` placeholder in `.cursor-plugin/mcp.json`.
- **Other hosts / manual runs:** export it in the environment that launches the server
  (`export TYPESAFE_API_KEY=...` from your secret store), then run `node server/index.mjs`.

The server reads the key from `process.env.TYPESAFE_API_KEY` only at call time. It never logs, echoes, or
returns the key, and Authorization is redacted in debug output. If the key is missing, or is a
`${TYPESAFE_API_KEY}` placeholder the host didn't substitute, every tool returns a clear error and sends
no request.

Optional env vars: `TYPESAFE_BASE_URL` (default `https://api.typesafe.ai`), `TYPESAFE_MODEL`
(default `jev-latest`), `TYPESAFE_TIMEOUT_MS` (default `30000`), and `JEV_DEBUG=1` (redacted request and
response logs on stderr).

## The four tools

| Tool | Call it when | Inputs (all required) | Choice options |
| --- | --- | --- | --- |
| `jev_route_worker` | Before handing the next step to a worker or subagent | `objective`, `completed_work`, `blockers`, `available_workers[{name, job_description}]` (≥ 2, unique names) | the worker names (also returned as `selected_worker`) |
| `jev_check_research` | Before relying on or reporting a factual claim | `claim`, `evidence`, `source_quality`, `known_conflicts` | `accept`, `verify_more`, `reject` |
| `jev_review_completion` | Before declaring a task done | `original_objective`, `required_outputs`, `completed_work`, `verification`, `known_gaps` | `complete`, `verify_more`, `incomplete` |
| `jev_guard_action` | Before any action with side effects | `proposed_action`, `target`, `side_effects`, `reversibility`, `existing_approval_policy` | `allow`, `confirm`, `human_review`, `deny` |

Inputs are validated against the JSON Schemas published in `tools/list`. Unknown fields, empty strings, and
duplicate worker names are rejected with clear errors. The bundled skill
(`skills/jev-decision-layer/SKILL.md`) tells agents when to call each tool.

### Data shape

```ts
type Decision = {
  tool: string;                          // e.g. "jev_guard_action"
  selected: string;                      // chosen option (TypeSafe `choice`)
  probabilities: Record<string, number>; // one entry per option, 0..1
  confidence: number;                    // 0..1, TypeSafe `confidence`
  raw?: { model: string; answer: object; usage: object }; // upstream answer, for auditing
};
```

The tool result's `structuredContent` is `{ decision_only: true, notice, ...Decision }`. The text content
starts with the decision-only notice.

## Decision-only guarantee

- Every tool sends **one** Choice question to TypeSafe and returns the answer. No tool runs commands,
  writes files, sends messages, dispatches workers, or verifies anything.
- Every result, including errors, includes: *"DECISION ONLY: this is an advisory decision. Nothing was
  executed, changed, sent, or verified by this tool; the caller must not treat it as having executed
  anything."*
- **`jev_guard_action` returning `confirm`, `human_review`, or `deny` means stop and ask a human.**
  `allow` never overrides the user's or the host's own approval rules.
- If the API fails or returns an unexpected shape, the tool returns an error. It never makes up a decision.

## TypeSafe API contract used

Source: TypeSafe OpenAPI 3.1 at <https://api.typesafe.ai/openapi.json>. The live response shape was
confirmed against the real API.

```http
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer ${TYPESAFE_API_KEY}
Content-Type: application/json

{ "model": "jev-latest",
  "state": { ...tool inputs... },
  "questions": { "decision": { "type": "choice", "instructions": "...",
                               "criteria": { "<option>": "<when it applies>", ... } } } }
```

```json
{ "model": "jev-1.13.0",
  "answers": { "decision": { "type": "choice", "choice": "<option>",
                             "probabilities": { "<option>": 0.0 }, "confidence": 0.0 } },
  "usage": { "input_tokens": 0, "output_tokens": 0 } }
```

The request builder and response parser live together in the `API` object at the top of
`server/index.mjs`.

## Layout

```text
.cursor-plugin/plugin.json   Cursor Plugin manifest (displayName, license, variables, skills, mcpServers path)
.cursor-plugin/mcp.json      Cursor MCP config: ${CURSOR_PLUGIN_ROOT} paths + ${TYPESAFE_API_KEY} placeholder
plugin.json                  Agent Plugins 1.0.0 manifest (closed schema)
mcp.json                     Agent Plugins MCP config: cwd ${PLUGIN_ROOT} (the standard variable)
server/index.mjs             MCP server (Node ≥ 18.17, no dependencies)
skills/jev-decision-layer/   SKILL.md
test/                        manifests.mjs, smoke.mjs
```

There are two MCP configs because Cursor doesn't expand the standard `${PLUGIN_ROOT}` variable, and the
Agent Plugins schema only allows `./`, `${PLUGIN_ROOT}`, or `${PLUGIN_DATA}` for `cwd`. The Cursor manifest's
`mcpServers` field points Cursor at `.cursor-plugin/mcp.json`, which overrides default `mcp.json` discovery.
The root `mcp.json` stays standard for other hosts.

## Tests

```bash
npm test                     # manifest checks + offline smoke tests (local mock API, fake key)
node test/smoke.mjs --live   # real API, one safe example per tool; needs TYPESAFE_API_KEY
```

## License

MIT © 2026 Samuel Kim. See [LICENSE](LICENSE).
