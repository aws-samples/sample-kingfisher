# _runtime (distributed copy, do not edit by hand)

This directory is a copy, not the source. It holds the shared runtime of the advisor-style
AgentCore containers: `agent-runner.js`, the Strands agent assembly loop that every advisor
agent runs, and `mcp.js`, a minimal MCP Streamable HTTP client that signs its calls to the
AgentCore Gateway with SigV4.

Distributed by: `bash scripts/core-prebuild.sh netadvisor`
Single source of truth: `infra/agent/_runtime/*.js`

## Why a copy exists

The Docker build context of each agent is its own directory and `COPY` cannot reach outside
it, so the shared runtime is copied in by the prebuild script, exactly like `core-dist`.
The container entry point `agent.js` imports `./_runtime/agent-runner.js`, and the runner
in turn imports `../core-dist/ai/*.js` for the shared model vendor profile, so the two copies
are expected to move together.

## How to change it

1. Edit the files under `infra/agent/_runtime/` (never the copies here).
2. Run `bash scripts/core-prebuild.sh netadvisor` (or `all`) from the repository root.
3. Commit the refreshed copies of every container together with the source change.

The script deletes and recreates this directory on every run, so manual edits are lost.
The files are plain JavaScript and are copied as they are; no compilation is involved.
