---
name: jev-decision-layer
description: Advisory decision checkpoints backed by TypeSafe Jev. Call jev_route_worker before delegating the next step, jev_check_research before relying on a factual claim, jev_review_completion before declaring a task done, and jev_guard_action before any action with side effects. Results are decisions only and never execute anything.
---

# Jev Decision Layer

Four MCP tools. Each one asks TypeSafe a single Choice question and returns a
`Decision = { tool, selected, probabilities, confidence, raw? }`.
**These results are advisory decisions only.** No tool runs, sends, verifies, or changes anything. Never
report an action as done because a tool returned `allow` or `complete`.

## When to call each tool

| Tool | Call it when | Options |
| --- | --- | --- |
| `jev_route_worker` | You are about to hand the next step to one of several workers/subagents. Pass the objective, completed work, blockers, and each worker's `name` + `job_description`. | the worker names (`selected_worker`) |
| `jev_check_research` | You are about to rely on or report a factual claim. Pass the claim, evidence, source quality, and known conflicts. | `accept`, `verify_more`, `reject` |
| `jev_review_completion` | You are about to say a task is finished. Pass the original objective, required outputs, completed work, verification done, and known gaps. | `complete`, `verify_more`, `incomplete` |
| `jev_guard_action` | Before any command or tool call with side effects (writes, deletes, sends, purchases, deploys, external posts). Pass the action, target, side effects, reversibility, and the approval policy in force. | `allow`, `confirm`, `human_review`, `deny` |

## Using the result

- Act on `selected`, but take `confidence` and `probabilities` into account. With low confidence or a close
  second option, choose the more cautious path (e.g. `verify_more`).
- `verify_more` / `incomplete` / `reject`: do more work or verification and don't present the result as final.
- **`jev_guard_action`: `confirm`, `human_review`, or `deny` all mean STOP.** Do not perform the action. Ask a
  human, saying what you proposed and what the guard returned. Only `allow` lets you go ahead under the
  existing policy, and `allow` never overrides the user's or host's own approval rules.
- If a tool returns an error (missing `TYPESAFE_API_KEY`, HTTP error, unexpected shape), there is no
  decision. Fall back to normal caution. For guarded actions, ask a human.
