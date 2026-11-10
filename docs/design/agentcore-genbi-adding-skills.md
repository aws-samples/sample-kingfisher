# How to add a skill to GenBI / AgentCore (hot loading supported)

> 📌 **Scope note (reconciled 2026-10-13)**: this document was written in the single-region stage and records the design as it stood at that time (including the audit-calibration annotations of 2026-08); **the current implementation is defined by the code**. Multi-region behavior — place, execution scope, per-region scheduling and the like — is described in the [multi-region execution specification](./multi-region-execution-spec.md) and [design](./multi-region-execution-design.md); the current state of each module is tracked in the design index; a path mentioned below that no longer exists means that the idea was not implemented as described here or has since been superseded.

> - Design goal: after a new skill is added, **subsequent sessions load it automatically — no agent rebuild or restart is needed**.
> - Key point: the GenBI agent (AgentCore Runtime) has been changed to be **generic and dynamic** — on every invocation it discovers all tools on the Gateway with `tools/list`, exposes them to the model dynamically, and forwards calls generically. Therefore **the agent never needs a code change or an image rebuild for a new skill**.

## The two kinds of "skill" and how each is added

### A. Data-driven business knowledge, definitions and rules (**fully hot-loaded, zero deployment**)
- Add entries (definitions / terms / rules) directly on the "Data Governance → Business Glossary & Rules" page `/knowledge`.
- Takes effect immediately: on every question the agent queries DynamoDB `bgp-genbi-context` in real time through the MCP tool `lookup_business_context`, so a new entry is injected and followed from the next question onward. No deployment of any kind is needed.
- Suitable for: metric definitions, term aliases, caveats, statuses that must be excluded, specific naming conventions, and so on.

### B. Adding a "tool-type skill" (a new capability, such as calling an external API or a new query)
Adding a Gateway MCP tool takes two code steps plus one infrastructure deployment (**but the agent is not touched**):
1. **Lambda implementation**: in `infra/lambda/genbi-skills/index.js`, add a `case "<new-tool-name>": return await <handler>(args);` to the `switch(tool)` (or create a separate Lambda as a new GatewayTarget).
2. **Gateway registration**: in `infra/lib/agentcore-stack.ts`, add the tool definition (Name/Description/InputSchema) to the `GatewayTarget` `ToolSchema.InlinePayload`.
3. **Deploy**: `cdk deploy BgpAgentCoreStack -c genbi-runtime=1 -c genbi-agent-tag=<current-tag>` (updates the Lambda and the Gateway; the Runtime image is unchanged and the agent is not touched).
4. Once done, the agent **automatically discovers the tool on its next invocation and offers it to the model** — no agent change, no image rebuild, no session restart.

> Why does B still need one deployment? The AgentCore Gateway's tool catalog is registered through `GatewayTarget` (control plane); a tool must be registered before `tools/list` can discover it. This is a platform constraint; the agent side, however, is already fully dynamic, so once registered the tool hot-loads.

### C. Registering a "parameterized read-only query" skill (**zero-deployment hot loading**, platform release 1.28.0)
- On the "Smart Analytics → Skills" page `/skills`, click "Register skill": fill in the skill name + a purpose description + the engine + a read-only SQL template (with `{{param}}` placeholders) + the parameter declarations.
- Takes effect immediately: stored in DynamoDB `bgp-genbi-skills` (per workspace / global). The agent discovers skills through the built-in tool `list_registered_skills` and executes them by name with `run_registered_skill(skill, params)` (the Lambda renders the parameters safely → read-only guard → Redshift/Athena). **No deployment of any kind; subsequent sessions can use it automatically.**
- Suitable for: high-frequency queries that need consistent definitions and that you want to package as a "one-click call" (for example "TOP N regions by customer count", "GMV for a given month").
- Security: the template must be read-only `SELECT/WITH`; parameters are rendered safely according to their declared type (number validation / identifier allow-list / string escaping); the rendered SQL still passes through the read-only guard.

## Currently registered MCP skills (discovered dynamically by the agent)
- `run_redshift_sql` / `run_athena_sql`: execute read-only SQL on Redshift / Athena.
- `introspect_redshift_schema` / `introspect_s3tables_schema`: inspect table structures (prefetched in the agent's first stage).
- `lookup_business_context`: look up business definitions / terms / rules (data-driven, hot-loaded).

## Verification (headless)
- Add the definition "GMV = the sum of quantity*unit_price over the order_items table" → ask "What is the GMV?" → the agent generates `SELECT SUM(quantity*unit_price) FROM public.order_items`, following the definition.
