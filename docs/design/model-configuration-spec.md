# Model Configuration — Technical Specification (SPEC): Runtime-Configurable Bedrock Models

> - Revision: **2.5** (🆕 2026-10-21, the long-running-operation framework: the implementation of the "hybrid response" row of section 3.3a **moved into `lib/long-ops/`** (the `lib/ai/long-call*.ts` files of the 2026-10-20 hybrid-response fix were merged into the unified long-running-operation
>   framework;
>   endpoint `GET /api/long-ops/[taskId]`, with `/api/ai/tasks/[taskId]` kept as an alias for one release;
>   table `bgp-ai-tasks` → `bgp-long-ops`;
>   environment variables `AI_SYNC_WAIT_MS` / `AI_ASYNC*` → `LONG_OPS_*`;
>   asynchronous failures restore the original status code through `errorStatus`);
>   from this revision on, this document keeps only the `_meta` echo contract; the hybrid-response contract is governed by [the long-running-operations design](./long-running-operations.md), section 2, and [the multi-region execution specification](./multi-region-execution-spec.md), section 3.18) ·
>   **revision 2.4** (🆕 2026-10-20 05:1xZ, **the asynchronous landing of synchronous routes** (the hybrid-response fix): section 3.3a gains a "hybrid response" row — the five synchronous routes ②③④⑤⑥ plus `etl-jobs/generate` / `engines/generate`, seven model-calling POST routes in total, uniformly
>   become "wait in-process for `AI_SYNC_WAIT_MS` (45 s); if still not terminal
>   ⇒ 202 `{taskId,status:"running",async:true}`"; the terminal state is echoed through the top-level `_meta` of `GET /api/ai/tasks/[taskId]` (the model + the correlationId of the submitting POST); the third persisted schema = the `model` attribute of the `bgp-ai-tasks` row;
>   the synchronous 200 shape for results that arrive within 45 s is unchanged byte for byte.
>   Basis: in a test account under Kimi K3, a Copilot question took 60.2 s, the network advisor 60.8 s, and batch code generation hit the CloudFront 60-second wall with a 504 while the page parsed the HTML as JSON) · **revision 2.3** (🆕 2026-10-20, the probe budget (the probe-timeout fix): section 2
>   `ProbeError` gains `Timeout` and `ProbeResult` gains `toolUseError` / `elapsedMs`;
>   in section 3.2 the tiny invoke and the tool-use second probe run **in parallel**, timeout = the vendor profile's `probeTimeoutMs` (Kimi K3 45 s / all others 10 s;
>   `probeTimeoutMsFor` is the single accessor), and a timeout is listed separately as Timeout, not classified as Throttle;
>   in section 3.3, PUT step ④ first accepts a probe-cache entry from the last 10 minutes that passed in the same region with complete tool-use evidence (`freshProbeFromCache`) and no longer probes a second time.
>   Basis: real measurements in a test account — 8 Kimi probe samples took 3.0–39.4 s, and 5 of them timed out under the 10 s budget) · **revision 2.2** (2026-10-14, after the first page-driven acceptance run: 🆕 section 7.2b retries a transient stream error once (`lib/ai/core/transient.ts`, design
>   decision D17);
>   section 7.8 adds the change points) · **revision 2.1** (2026-10-14, section 7 corrected after construction against the **code as landed**: 7.1 the family regular expression gains `(?![0-9])` plus `FAMILIES / familySummaries`;
>   7.2 the real signatures of the shaping functions (`shapeInferenceConfig / shapeConverseInput` return `{ config|input, stripped, boosted }`, the learning table hangs on globalThis), `InvokeOutcome.shaped`, the planner maxTokens factor;
>   7.3 the probe request goes through shaping;
>   7.5 ordering and `families[]`;
>   7.6 `CAP_AFTER` / `AGENT_SOURCE_PATHS`;
>   7.7 the candidate chain derived from ground truth / failures leave a trace / last resort;
>   7.8 the change points as actually made;
>   real-environment conclusions to be back-filled by the first page-driven acceptance run) · **revision 2.0** (🆕 2026-10-14, the multi-vendor model channel: new section 7 — vendor-profile types / `shapeConverseRequest` / changes to the probe and PUT flows / four families in the catalog / shared core
>   in the containers / deployment-time candidate chain / list of change points;
>   basis: the design, revision 2.3, section 12) · **revision 1.7** (🔴 2026-09-10, the **purpose of `_meta.backend` in section 3.3a is narrowed**: decided on that day that "all natural-language queries go through the same AgentCore"
>   ⇒ the normal value is always `agentcore`, and the value of the field becomes **exposing an AgentCore failure fallback** (the value is `inprocess` when the call fell back to the in-process engine; the answers of the two paths look identical, so without the echo nobody would know a downgrade
>   happened)) revision 1.6 (🆕 2026-09-10, section 3.3a gains the optional field **`_meta.backend`** (the execution backend actually used for this query, `agentcore`|`inprocess`) — since the multi-region work of 2026-09-10, "in which region the question is asked" decides the backend (AgentCore is
>   installed only in the home region), and the two backends differ in capability while their **answers look the same**
>   ⇒ without the echo one can only guess;
>   optional field, the shapes of the other 8 routes are unaffected) revision 1.5 (🔴 2026-09-09, **parameter renamed `scope` → `settingScope`**: `?scope=` had already been defined by [the multi-region execution specification](./multi-region-execution-spec.md), revision 3.34, section 2.6, as the
>   platform-wide single meaning of the **execution scope**, while an earlier platform-wide feature plan intended to write the per-region model override as `model-config?scope=<targetId>#global` ⇒ **a scheduled collision**.
>   Ruling: the model-setting scope parameter is renamed; receiving the old name `scope` ⇒ **400 `ScopeParamRenamed`**, **no compatibility alias**;
>   the only callers are `components/settings/AiModelCard.tsx:268` plus three unit tests) revision 1.4 (🔴 2026-09-05, 🆕 **section 6.5 landing corrections**: back-fed from the implementation record of construction stream C — `_meta` landing points / ★ error-body shape / `BGP_NONPROD_TARGET` / source
>   of `releaseId` / the three codegen routes / containers throw when both sources are missing / non-admins read-only / ★ GPT rejection-reason order / shared pieces / new dependencies / deployment order) revision 1.3 (🔴 2026-09-05, **the implementation addendum, section 6, rewritten**: rewritten with
>   the GPT branch as the reference implementation, the landing points of the five modes [literal type for `probeOk` / last-good + `runtime-stale` / audit and configuration in the same TransactWrite / `version` optimistic lock / AgentCore receipt validation] + three pitfalls avoided [keys and caches
>   shaped by `targetId` / the second parameter of `resolveModelIdRuntime` really wired / `isModelIdFormatValid` keeps a region hook] + scope of this wave = all of the first construction phase + the code side of the second construction phase;
>   production topology corrected = single account × multiple regions) revision 1.2 (implementation-level technical design: finalized table / interface schemas / pseudo-code for the key mechanisms / list of change points / acceptance) | Date: 2026-08-28 (revision 1.1: 2026-08-29) | Status: ⬜ in
>   design, pending review
>
> - Basis: [the design](./model-configuration.md), **revision 2.3** (decisions / surfaces changed / risks) + [the interaction design](./model-configuration-interaction.md), **revision 1.7** (interaction). **This document only elaborates the technical "how"; decisions and the "why" are in the design.**
>
> Earlier revisions (11) are in the collapsible list below.

<details><summary>Revision history</summary>

- 🔴 Red line: this is a pure design document (with pseudo-code); **no implementation code is written and nothing is deployed without explicit confirmation**. The pseudo-code is **illustrative**, not directly compilable.
- 🎯 **Revision 1.1 changes (convergence review of 2026-08-29: three independent reviews agreed that this module was the only one with "zero handling",**
  **so four blocking points are now added)**: ① **the `modelId` echo contract of section 3.3a** (previously a "circular gap": the acceptance criteria named it the only reliable state source and forbade CloudTrail, yet the specification never required any endpoint to add that field) — defines the
  response-body metadata block `_meta:{modelId,modelSource,correlationId}` + **landing points = 8 routes (6 synchronous routes echo it directly + 2 asynchronous routes return only a taskId) + 2 persisted schemas + retrieval/memory, which have no endpoint, covered by `_meta.invocations[]`** (precise
  wording in section 3.3a) + the **actually used** modelId uniformly supplied by `invokeWithFallback`;
  ② **the landing point of `gptTransportReady()`** (`sk="ai-model#__transport"` + the new endpoint `PUT /transport` + **400 `TransportNotVerified` when the probe has not passed**) and removal of the contradiction with the P0-5 hard gate that "reads no flag";
  ③ **the fault-injection mechanism** (🔴 **corrected in this summary on 2026-08-29**: the original wording "`FAULT_SETTINGS_TABLE` + build-time exclusion + status in health" — **all three points had already been rejected by the body of section 3.4a**, but the summary block was not synchronized ⇒
  building from the summary would produce a mechanism incompatible with the multi-region execution specification and point at an endpoint that does not exist.
  **Ruling**: throttling faults use **`FAULT_THROTTLE_MODEL`**;
  DynamoDB faults **add no new seam** and instead give `bgp-settings` a **`SETTINGS_TABLE` environment variable** (following the repository's existing `COPILOT_TURNS_TABLE` precedent) that is pointed at a broken table in non-production deployments;
  mechanism = **runtime environment gate + effective only on non-production targets** (word for word the same as the multi-region execution specification, section 8ter.2; **not build-time exclusion** — otherwise acceptance would not run the release image);
  the enablement status is shown in **`GET /api/system/wiring`** (**`/api/system/health` does not exist**)), replacing "temporarily pointing at a wrong table name", a way of creating faults that the multi-region execution specification, section 8ter.2, judged a red-line violation;
  ④ **the probe rate limit fixed at 6 per minute per administrator** + the landing point of the counter (the original literal "N/min" could not be executed headlessly).
- 🎯 **Revision 1.1 second convergence (full-module verification of 2026-08-29; everything fixed here was "introduced or missed by the previous round of corrections itself")**: ⑤ 🔴 **the dimension of the model key and of the resolver functions back-fed from `region` to `targetId`** — the
  multi-region execution specification had long defined `ai-model#<targetId>#global` in sections 1.3a-S2 and 6, while the four documents of this module and the platform feature plan **never synchronized 10 key names and 8 signatures**;
  implementing by region = two accounts in the same region share one model (Bedrock enablement is account × region) + when the per-target activation phase of the multi-region work arrives it turns into a key migration (violating the zero-migration decision D2).
- Reasoning and ruling in **design decision D8, "dimension ruling"**;
- ⑥ **the rate-limit sk of section 1 corrected** to `ratelimit#probe#<adminSub>#m#<bucket>` (the original invented a `<yyyy-MM-ddTHH:mm>` string, exactly the "needless fork of the in-house format" that section 3.4a judges and rejects; sections 1 and 3.4a contradicted each other);
  ⑦ **self-correction of the landing-point count in section 3.3a** (the previous "10 routes + 2 task-item schemas" conflicted with its own enumeration ①–⑩; the truth = **8 routes + 2 persisted schemas + ⑨⑩ without endpoint via `_meta.invocations[]`**);
  ⑧ **three stale mechanisms removed from the summary block of section 0** (`FAULT_SETTINGS_TABLE` / build-time exclusion / `/api/system/health` had all been rejected by section 3.4a; the summary block was not synchronized ⇒ building from the summary would produce a mechanism incompatible with the
  multi-region execution specification).
- 🎯 **Revision 1.0 changes (2026-08-28, specification-level deep review by two tracks — A, code-fact verification, and B, constructability — confirmed by grep)**: the skeleton and decision chain of revision 0.1 are correct, but "writing directly from the pseudo-code of section 3.1 would produce a
  hot path that crashes", so **5 P0 items that must be completed before construction starts** + P1/P2 items are added:
- **P0-1** try/catch + stale fallback on the resolver hot path, an independent short TTL for readVersion (no longer one table read per call);
- **P0-2** the store/version-layer contract finalized (ownership of the `ai-model#` prefix / cold-table defaults / write-then-bump order);
- **P0-3** the new shared `invokeWithFallback` (throttle back-off + downgrade to the previous layer's model; the only home of the P0-4 cold cliff);
- **P0-4** the landing point of the per-model probe cache (`ai-model#probe#<id>`); `/catalog` only reads the cache and never probes all models;
- **P0-5** the phase-one server-side hard gate that forbids storing GPT as the global default.
- Naming corrections: `BgpDatabaseStack` → **`DatabaseStack`** (the class name does not exist);
  the `bgp-budgets` optimistic-lock convention lives in `FinOpsStack`.

</details>

---

## 1. Table Design (Finalized) — New Table `bgp-settings`

CDK landing point: **`DatabaseStack`** (`infra/lib/database-stack.ts:11`; ⚠️ revision 0.1 wrongly called it `BgpDatabaseStack`, a class name that does not exist — verified by the code-fact review), appended (the design, section 3; the audit confirmed it was never implemented: zero hits across the repository, a pure addition with zero migration).

| Key / attribute | Type | Description |
|---|---|---|
| `pk` (PK) | S | Constant `"system"` (single partition; the volume of platform configuration is tiny) |
| `sk` (SK) | S | **Phase one**: `"ai-model#global"` (global default), `"ai-model#__version"` (invalidation version item), 🆕 `"ai-model#probe#<targetId>#<modelId>"` (**per-target × per-model probe cache**, P0-4; revision 1.2 added the target dimension — Bedrock enablement is account × region), 🆕 **`"ai-model#__transport"`** (GPT transport gate `{gptReady,branch,decidedAt,decidedBy}`, section 3.4, blocking point ②), 🆕 **`"ratelimit#probe#<adminSub>#m#<bucket>"`** (probe rate-limit counter; 🔴 **revision 1.1 correction: the original invented a `<yyyy-MM-ddTHH:mm>` string, exactly the "needless fork of the in-house format" that section 3.4a explicitly rejects** — the ruling reuses the `windowBuckets` shape of `lib/data-service/ratelimit.ts:18-36`, `bucket = floor(epochSec/60)`; attributes `{n}` + **`ttl` in epoch seconds (5 min)**; section 3.4a, blocking point ④. This key name is already in the doc-consistency freeze list of the multi-region acceptance criteria);<br>**phase two**: 🔴 **`"ai-model#<targetId>#global"`** (the third construction phase; **revision 1.1 back-fill: the original wrote `<region>`**; the multi-region execution specification, sections 1.3a-S2 and 6, had long settled on targetId — reasoning in design decision D8, "dimension ruling"), `"ai-model#<capability>"` (the fourth construction phase) |
| `modelId` | S | Bedrock model id (**short id, not an ARN**, see the validation in section 2) or inference profile id (such as `global.anthropic.claude-opus-4-8`) |
| `probedAt` | N | Timestamp of the most recent probe (epoch ms) |
| `probeOk` | BOOL | Whether the most recent probe passed |
| `probeError` | S? | Failure class (`AccessDenied`\|`NotFound`\|`MarketplaceSCP`\|`Throttle`\|`NotAvailableForAccount`\|🆕 revision 2.3 `Timeout`) |
| `toolUseOk` | BOOL? | (probe item) Whether tool use is available for the GPT family under Converse (the criterion for the decision-D9 branch) |
| `updatedBy` / `updatedAt` | S / N | Audit |
| `version` | N | **Per-item optimistic lock** (following the `bgp-budgets` convention of `FinOpsStack`, `finops/store.ts:129-137`; ⚠️ revision 0.1 wrongly placed it in DatabaseStack) |

- `BillingMode = PAY_PER_REQUEST`; `RemovalPolicy.RETAIN` + PITR on (configuration data must not be deleted by mistake).
- **Keep the two notions of version apart (P0-2/P1-2)**: ① every **configuration item** carries its own `version` = optimistic lock (PUT carries `expectVersion`; a conflict becomes 409); ② the `version` of the global `sk="ai-model#__version"` item = **cache-invalidation counter** (after any successful configuration write, `ADD version :one` increments it, and `resolveModelIdRuntime` compares against it to decide whether to drop its cache). The two are independent.
  - **Cold-table default of `__version`**: when the item does not exist, `readVersion()` returns `0`; `bumpVersion` uses `UpdateExpression:"ADD version :one"` (creates the item as 1 when absent) and **does not depend on prior seeding**.
- **Probe cache item** (🔴 **revision 1.2 corrected it to `ai-model#probe#<targetId>#<modelId>`**, P0-4): stores `{probeOk, probedAt, probeError, toolUseOk}`; the application layer treats it as a **24-hour TTL** (expired = "unknown"). GET `/catalog` **reads only this cache and never probes all models** (section 2).
  > 🔴 **Why the targetId must be part of the key** (confirmed by an external review on 2026-08-29): the original key had only the model dimension.
  > But **Bedrock model enablement (Marketplace subscription / model access) is "account × region"** — of two targets in the same region but different accounts, one may well be enabled and the other not.
  > Sharing one probe-cache entry ⇒ **a model is judged available on a target where it is not enabled**, which lands exactly on the P0-2 failure "switch to the wrong model and everything breaks".
  > Same reasoning as for the model key (see design decision D8, dimension ruling), so **the phase-one table is shaped per target from the start** (phase one has only home and the key value is always `tgt_home`, but the shape is fixed so that the per-target activation phase of the multi-region work does not turn into a key migration, which would violate the zero-migration decision D2).
- IAM: the ECS TaskRole already has broad DynamoDB permissions, **zero IAM change** (the design, section 1.3; the code-fact review checked `platform-stack.ts:658-669`, which contains List/Get/Invoke/Converse + `aws-marketplace:Subscribe`).

Example item (phase-one global default):
```json
{ "pk":"system", "sk":"ai-model#global", "modelId":"global.anthropic.claude-opus-4-8",
  "probedAt":1756... , "probeOk":true, "updatedBy":"admin@..", "updatedAt":1756..., "version":7 }
```

---

## 2. Interface Design (Request / Response Schemas)

All endpoints hang under the `/api/admin/*` gateway (`middleware.ts:104` enforces bgp-admin; the code-fact review confirmed this). **Second layer of defense in depth**: each route reuses `requireAdmin` (`resolveIdentity` + `isPlatformAdmin`; currently a local function at `api/admin/users/route.ts:12`; P2-4 extracts it into a shared `lib/auth` or replicates it). The TS types are **the contract**.

```ts
// 能力 key 白名单(防漂移,与 DESIGN §1.2 的 9 消费点对齐)
type Capability =
  | "genbi" | "genbi-retrieval" | "genbi-memory" | "copilot" | "copilot-planner"
  | "net-advisor" | "param-advisor" | "flink-sql" | "codegen";
type Family = "anthropic" | "openai";
type ProbeError = "AccessDenied" | "NotFound" | "MarketplaceSCP" | "Throttle" | "NotAvailableForAccount" | "Timeout";  // v2.3:Timeout = 预算内没等到(不是限流)
type SourceLayer = "runtime" | "env" | "ssot";           // 三层解析来源(DESIGN D2)

// 🆕 P1-1:bgp-settings 配置项形态(GET overrides 用;此前未定义)
interface SettingItem { pk:"system"; sk:string; modelId:string;
  probedAt?:number; probeOk?:boolean; probeError?:ProbeError; toolUseOk?:boolean;
  updatedBy:string; updatedAt:number; version:number; }
interface EffectiveModel { scope:string; modelId:string; source:SourceLayer;
  probedAt?:number; probeOk?:boolean; }
interface ProbeResult { ok:boolean; error?:ProbeError; errorDetail?:string;
  toolUseOk?:boolean;                       // GPT 系列 Converse tool-use 是否可用(D9 判据)
  quotaHint?:"ok"|"low"|"unknown"; }        // 🔴 best-effort:失败即 "unknown"、绝不阻断保存;
                                            //    冷悬崖真实防线是 §3.5 invokeWithFallback,非此(P2-2)
```

| Method · path | Request | Response (200 / error) |
|---|---|---|
| **GET** `/api/admin/model-config` | — | `{ effective:EffectiveModel[]/*phase one: global only*/, overrides:SettingItem[] }` (**includes the effective value + its source layer**; the L2 contract reads this directly, no separate `/effective`, P2-1). 🔴 **Revision 1.1: `overrides[]` must be filtered by an sk whitelist** — a bare `Query pk="system"` would also return `__version`/`__transport`/`probe#<id>` (**none of which has a `modelId`, violating the required `SettingItem.modelId`**); the listing condition = `begins_with(sk,"ai-model#")` **and excluding** `ai-model#__version` / `ai-model#__transport` / `ai-model#probe#*` ⇒ **only scope items remain** |
| **PUT** `/api/admin/model-config` | `{ scope:"global", modelId:string, expectVersion?:number }` (phase one: global only) | 200 `{ ok:true, version:number }` / **400** `{error:"ProbeFailed"\|"NotAllowedFamily"\|"NotInCatalog", reason?:ProbeError, detail:string}` / **409** `{error:"VersionConflict"}` |
| **DELETE** `/api/admin/model-config?settingScope=global` | query `settingScope` (🔴 renamed from `scope` on 2026-09-09: `?scope=` is monopolized platform-wide by the **execution scope** of [the multi-region execution specification](./multi-region-execution-spec.md), revision 3.34, section 2.6; receiving the old name ⇒ 400 `ScopeParamRenamed`, **no compatibility alias**) | 200 `{ ok:true, fellBackTo:SourceLayer }` (deleting the override → `resolveWithProvenance` re-resolves and reports the layer fallen back to; "Restore factory default" = delete all overrides) |
| **GET** `/api/admin/model-config/catalog` | — | `{ models:Array<{modelId, family:Family, available:boolean/*= the latest real probe passed; never probed = false + lastProbe absent*/, profilePrefixes:("us."\|"global.")[], lastProbe?:ProbeResult}> }` (`ListFoundationModels` filtered to outputModalities ⊇ TEXT + `ListInferenceProfiles`, **filtered to two families** per decisions D3/D4: only Claude Opus + `openai.gpt-5.6-*`; **`available`/`lastProbe` read the `ai-model#probe#<id>` cache and never probe all models**, P0-4) |
| **POST** `/api/admin/model-config/probe` | `{ modelId:string }` | `ProbeResult` (a real invoke; **writes back the probe-cache item**; 🔴 **the fixed rate limit is given below**, P2-5) |
| 🆕 **PUT** `/api/admin/model-config/transport` | `{ gptReady:boolean, branch:"A"\|"B" }` | 200 `{ok:true}`; writes `sk="ai-model#__transport"`; **bgp-admin only**; 🔴 **precondition**: when `gptReady=true`, the server **must** first run `probeModel` against at least one `openai.gpt-5.6-*` **with `toolUseOk===true`** (branch A) or confirm that the branch-B adapter layer is live, otherwise **400 `TransportNotVerified`** — prevents "one click opens GPT and breaks the 9 tool loops" (section 3.4, P0-5) |

- **PUT server-side flow** (authoritative; P0-2/P0-5/P1-2/P1-3): `requireAdmin` → **cheap regular-expression prefilter** `^(us\.|global\.)?[a-z]+\.[a-z0-9.:-]+$` (verified to match `openai.gpt-5.6-sol`/`global.anthropic.claude-opus-4-8`;
  format only) → **validate `modelId ∈ catalog (after the two-family filter)`** (the only authoritative whitelist,
  preventing a direct API call from bypassing the front end and inserting haiku and the like) → 🔴 **P0-5 phase-one hard gate**: `isOpenAIFamily(modelId) && !gptTransportReady()` → **400 `NotAllowedFamily`** ("the GPT family is not open in phase one,
  pending the transport gate of the second construction phase") — 🔴 **revision 1.1 adds the landing point of `gptTransportReady()` (blocking point ②)**: until then `GPT_TRANSPORT_READY` appeared only in the acceptance criteria, with zero hits in the specification and the design,
  and the acceptance criteria' "may temporarily be set to true when testing branch A" **contradicted** this hard gate's "400 **unconditionally** by family, reading no flag" (implemented per the specification, the flag would have no effect).
  **Ruling**: it lands in **`bgp-settings` under `sk="ai-model#__transport"`** (item `{gptReady:boolean, branch:"A"|"B"|null, decidedAt, decidedBy}`, default `gptReady=false`), and `gptTransportReady()` reads it (**sharing the 5 s short TTL with `readVersionCached`**, no extra table read);
  🔴 **only a platform admin sets it explicitly through `PUT /api/admin/model-config/transport` after the decision-D9 probe has passed** (endpoint in section 2) — **not an environment variable, not a CDK context** (changing an env requires a redeploy = violates the "effective from the page" intent).
> - 🔴 **Three reinforcements in revision 1.1 (real defects pointed out by the convergence verification)**:
> - ① **Phasing**: the gate's **code / endpoint / DynamoDB item and the negative test of the gate must ship in the same phase**. The original arrangement (the gate in the first construction phase, the negative test in the second) = **shipping an unverified self-service release switch in phase
>   one**. **Ruling: in the first construction phase `gptTransportReady()` always returns `false`** (hard-coded, does not read DynamoDB); **the endpoint + the DynamoDB item + the negative test enter the second construction phase together**.
>   ② **Failure direction fail-closed**: **any exception in `gptTransportReady()` ⇒ return `false`** (never adopt section 3.1's "never throw + fall back to lastGood" — that would make the GPT hard gate **fail-open**, exactly the historical lesson of this project's "16 fail-open ternaries").
>   ③ **Cache and invalidation**: use an **independent** `_transportCache{val,at}` (TTL = `VER_TTL_MS` 5 s), **and `PUT /transport` must also call `bumpVersion()`** (otherwise a reader hung off `__version` would **never refresh** = bug).
>   ④ **Strength of the gate's evidence**: the `probe` item has a **24-hour expiry** semantics ⇒ the transport item must store `{probeModelId, probedAt}` and is **considered invalid after 24 h** (the model may be revoked / the SCP may change);
>   and a PUT of `openai.*` **requires `toolUseOk===true` from that probe** (not just `ok`).
> - ⚠️ **Honest boundary**: a single tiny probe is weaker than the "4 tool loops each verified headlessly" required by the design, section 9.3, P0-3 ⇒ the **formal adoption** of branch A still depends on the 4-loop acceptance of the second construction phase; setting the transport flag is only **a
>   switch**, not **evidence**.
> - ⑤ ⚠️ **Risk record**: `auth/identity.ts:40-49` gives everyone `isPlatformAdmin:true` **when Cognito is not configured**
>   ⇒ in a demo or misconfigured deployment anyone could flip the gate — one more reason for the always-false of the first construction phase → **mandatory `probeModel`**, failure ⇒ 400 with the reason → `store.put` (conditional write `version=:expectVersion`, conflict ⇒ 409) → `bumpVersion()` →
>   `recordAudit(req,"model-config.update",{resourceType:"model-config",resourceId:scope,detail:{old,new}})`.
- 🔴 **`modelId` uses the short id** (catalog and PUT agree; `ListInferenceProfiles` returns both the id and the ARN, always take the short id; the regular expression rejecting ARNs is intentional, P1-3).
- 🔴 **Audit strength (P2-3)**: in phase one `recordAudit` reuses the existing `bgp-audit` (best effort, plain Put, **without the deny-modify/delete tamper protection of the multi-region execution specification, section 3.3**) — consistent with the whole platform, acceptable; if "changing the global model" must be tamper-proof, that is a separate to-do (joining the unified egress / high-risk audit list of the multi-region execution specification, section 3.3).

---

## 3. Pseudo-Code for the Key Mechanisms

### 3.1 🔴 `resolveModelIdRuntime` (P0-1 robust version: three-layer resolution + short-TTL version check + never throws on failure)

```
// lib/ai/model.ts —— 新增 async;原同步 resolveModelId()(:19,env||DEFAULT)不删不动(部署期/兜底继续用)
const _cache    = new Map<string,{modelId,ver,at}>()   // key=scope;正解值
const _lastGood = new Map<string,string>()             // key=scope;🔴 兜底:最近一次成功解析值(即使过期也用)
const TTL_MS = 60_000                                  // 配置项缓存
const VER_TTL_MS = 5_000                               // 🔴 P0-1:readVersion 独立短 TTL(避免每调用打 pk="system" 单热分区)
let _verCache = {ver:0, at:0}

async function readVersionCached(): Promise<number> {
  if (now() - _verCache.at < VER_TTL_MS) return _verCache.ver
  const v = await store.getVersion()          // sk="ai-model#__version";冷表→0(P0-2)
  _verCache = {ver:v, at:now()}; return v
}

// 🔴 v1.1 回灌:第二参数是 targetId 不是 region(50 SPEC §1.3a-S2/§6 已定;理由见 51 DESIGN D8「维度定案」)
async function resolveModelIdRuntime(capability?:Capability, targetId?:string): Promise<string> {
  const scope = deriveScope(capability, targetId)        // 逻辑 scope:一期恒 "global";二期 "<targetId>#global"/"<capability>"
  try {
    const ver = await readVersionCached()
    const hit = _cache.get(scope)
    if (hit && hit.ver===ver && now()-hit.at < TTL_MS) return hit.modelId
    const {modelId} = await resolveWithProvenance(scope, targetId)  // 🔴 v1.2:原写 region = **未定义变量**
                                                                   //    (上一轮只改了本函数签名,漏改这一行)
    _cache.set(scope,{modelId,ver,at:now()}); _lastGood.set(scope,modelId)
    return modelId
  } catch (e) {
    // 🔴 P0-1 韧性:配置读取子系统故障【绝不】拖垮 AI 主功能(不比现状差,兑现 DESIGN P1-1)
    return _lastGood.get(scope) ?? process.env.BEDROCK_MODEL_ID ?? DEFAULT_MODEL_ID
  }
}
```

### 3.1a `resolveWithProvenance` (P1-1: the "resolve + report the hit layer" primitive shared by three callers)

```
// 供 resolveModelIdRuntime、GET /model-config(填 source)、DELETE(算 fellBackTo)【共用】,免各写一份口径漂移
async function resolveWithProvenance(scope, targetId?): Promise<{modelId, source:SourceLayer}> {
  const item = await store.get(scope)                              // store 内部独占拼 sk="ai-model#"+scope(P0-2)
             ?? (targetId ? await store.get("global") : null)      // 🔴 v1.2:二期 per-target miss 回落全局
                                                                  //    (原签名/回落条件仍写 region,是漏改)
  if (item?.modelId)              return {modelId:item.modelId, source:"runtime"}
  if (process.env.BEDROCK_MODEL_ID) return {modelId:process.env.BEDROCK_MODEL_ID, source:"env"}
  return {modelId: DEFAULT_MODEL_ID, source:"ssot"}                 // ai-model.json:5(仍 opus-4-6,守零迁移)
}
```
- **Active invalidation**: a successful `PUT/DELETE` calls `bumpVersion()`; the `readVersionCached` of every ECS instance reads the new `ver` within **≤ VER_TTL_MS (5 s)** → drops its cache and re-reads ⇒ **takes effect within seconds** (no waiting for the 60 s configuration TTL).
  - 🔴 **Revision 0.1 "immediate" → revision 1.0 "within seconds (≤ 5 s)" (P0-1; back-fed to design decision D6)**: revision 0.1 said "effective immediately after saving, acceptance needs no wait". A true "immediate" would require reading `__version` on every call (a single hot partition, throttled under high concurrency). Compromise = a 5 s short TTL on `__version`: convergence window ≤ 5 s, far below 60 s, DynamoDB reads cut several-fold. Acceptance allows taking effect within ≤ 5 s (still no 60 s wait).
- **Call placement (added by the code-fact review)**: `resolveModelIdRuntime` is evaluated **once per query / once per generation** (at the top of the function body), **not** on every Converse iteration (`genbi maxIters=8`; `agent.ts:155`/`copilot:70` sit inside a for loop → the await is hoisted out of the loop).
- 🔴 **Multi-region cross-process invalidation boundary** (the multi-region cross-process invalidation risk): per-region skill Lambdas and per-region processes each keep their own cache, and a control-plane bump is not pushed to them ⇒ the TTL is the safety net (changing a per-region model takes effect within ≤ 60 s, as already declared in the design, section 8.2).

### 3.2 `probeModel` (mandatory probe before saving + error classification + decision-D9 transport branch + probe-cache write)

```
async function probeModel(modelId): Promise<ProbeResult> {   // classify() 为净新(此前只换默认模型的改动未留分类,A 核对)
  try {
    const transport = pickTransport(modelId)                 // 见 §3.4 D9 分支
    const budgetMs = probeTimeoutMsFor(modelId)                 // v2.3:厂商档案 probeTimeoutMs(Kimi K3 45s / 其余 10s),不再写死 10s
    const [, tool] = await Promise.all([                         // v2.3:两探**并行**,墙钟 ≈ max(留在 ALB 60s 内)
      transport.tinyInvoke(modelId,{prompt:"ping",maxTokens:24,timeoutMs:budgetMs}),
      vendor.toolUse==="probe" ? probeToolUse(modelId,{timeoutMs:budgetMs}).catch(e=>({ok:false,error:classify(e)})) : {ok:true}])
    const toolUseOk = tool.ok;  const toolUseError = tool.error   // 二探超时 ⇒ toolUseError:"Timeout"(≠ 不支持工具)
    const r = {ok:true, toolUseOk, quotaHint: await tryReadQuota(modelId)}  // quotaHint best-effort(P2-2)
    await store.putProbe(targetId, modelId, r); return r      // 🔴 写 ai-model#probe#<targetId>#<modelId>(v1.2 补 target 维)
  } catch (e) {
    const r = {ok:false, error: classify(e)}                 // AccessDenied|NotFound|MarketplaceSCP|Throttle|NotAvailableForAccount|Timeout(v2.3,先于 Throttle)
    await store.putProbe(modelId, r); return r
  }
}
// 🔴 MarketplaceSCP 对新账号真实活跃:默认已回 opus-4-6(opus 系走 Marketplace),SCP 禁 Subscribe 会开通失败(A 核对)
// 🔴 tryReadQuota 现实(P2-2):Bedrock 无实时余量 API(Service Quotas 只给已配额值、不给剩余)→ 取不到即返 "unknown",绝不阻断保存
// 🔴 v2.3(2026-10-20 测试账号真测):Kimi K3 tiny / tool-use 探测 8 次采样 3.0–39.4s(推理模型首字延迟,us. / global. 都抖),
//   原 10s 串行预算 ⇒ 5 次超时且被归 Throttle(页面「探测被限流」)。⇒ 预算按系列、两探并行、超时单列 Timeout;
//   **PUT ④ 改为**:`freshProbeFromCache(getProbe(targetId, modelId))` —— 同 id、probeOk、probedAt 在 PROBE_FRESH_MS(10 分钟)内、
//   toolUse:"probe" 的系列还要 toolUseOk === true ⇒ 直接用这次探测写库,不再二次探;否则照旧现探。ProbeOk 的类型级供给不变。
```

### 3.3 Conversion Pattern for the 9 Consumption Points (module-load-time constant → evaluation at the call site → uniformly through the section 3.5 wrapper)

```
// A 核对:9 能力(copilot 含 :70/:122 两点)所在函数【全部 async】,await 逐点安全;现全读模块加载期常量。
// BEFORE(固化):config 顶层 const → 调用处直接读
const GENBI = { modelId: resolveModelId(), workgroup, database }  // genbi/config.ts:16
new ConverseCommand({ modelId: GENBI.modelId, ... })             // agent.ts:155

// AFTER(调用处求值 + 走 invokeWithFallback,不动 config 对象形状):
const modelId = await resolveModelIdRuntime("genbi", targetId) // 循环外求值一次(v1.1:第二参数 targetId 非 region)
await invokeWithFallback("genbi", targetId, (mid)=>new ConverseCommand({modelId:mid, ...}))  // §3.5
// config.ts 的 modelId 字段【保留标 deprecated】,避免动对象形状波及所有读 GENBI.* 的代码
```
- 🔴 **Strands variant (added by the code-fact review)**: `planner.ts:107` and the GenBI container use **`new BedrockModel({modelId})`** (Strands), not ConverseCommand; the conversion is the same (`new BedrockModel({modelId: await resolveModelIdRuntime("copilot-planner", targetId)})`), still async-safe, only the carrier differs.
- 🔴 **Hidden readers must be changed together** (the design, section 9.2 / the hidden-reader risk; the code-fact review confirmed the whole chain): `flink-sql-ai.ts:101 model:GENBI.modelId` (return-value metadata) → change it to the runtime value, otherwise the model name reported by the API ≠ the one actually called (it flows into `flink/ai-sql/route.ts:22` recordAudit and the `:23` response envelope).
- The point-by-point list is in the table of section 4; **each point is an independent commit and can be reverted alone**.

### 3.3a 🔴 Added in revision 1.1: the `modelId` echo contract (blocking point ① — previously a "circular gap": the acceptance criteria made it the only reliable state source and forbade CloudTrail, yet the specification required no endpoint to add this field)

**Problem**: of the 9 consumption points **only flink** returns `model:` in its response (`ai-sql/route.ts:23`); the other 8 have neither the field nor a modelId log; and the method given by the design, section 10, is CloudTrail — which is exactly what section 7 of the acceptance criteria forbids because of **delivery lag** ⇒ acceptance has no reliable, immediate state source.

**Ruling (contract)**:

| Item | Final |
|---|---|
| **Carrier** | A uniform metadata block in the **response body**, **`_meta: { modelId, modelSource, correlationId }`** (`modelSource` ∈ `runtime\|env\|ssot`). 🔴 **Implementation fixed**: extend `apiOk(data, status?, meta?)` — following the **compatible-signature precedent** of `api-response.ts:33 apiError` (206 routes use `apiOk`; **existing calls must not break**); `_actions` is already an underscore-metadata precedent (`requirements/[id]/generate:36`), and `_meta` has zero hits across the repository, no conflict. 🔴 **The real reason not to use response headers (revision 1.1 correction)**: this repository has **no streaming responses** (`ConverseStreamCommand`/`text/event-stream`/`ReadableStream` have **zero hits** in `platform/src`), so the original "streaming headers already sent" was **factually wrong**; the real reason = **long tasks go asynchronous + polling** (to get around CloudFront's 60 s), and headers cannot carry the terminal state |
| 🔴 **`correlationId` is mandatory** | The infrastructure exists (`observability/logger.ts:16` reads `x-correlation-id`, `middleware.ts:3` generates it, `getCorrelationId`:54); under concurrent acceptance, without it a response **cannot be matched to its log** |
| **Field names fixed** | `_meta.modelId` (**the underscore prefix marks "not a business field"**, avoiding a clash with the business field `model`; flink's existing `model:` **stays untouched** and **additionally** gets `_meta.modelId`, and the two values must be equal — which is itself the regression assertion for the "hidden readers" of section 3.3) |
| 🔴 **Landing-point correction (revision 1.1; 🔴 re-corrected 2026-08-29: the previous "actually 10 routes + 2 task-item schemas" was itself miscounted** — it conflicted with the enumeration ①–⑩ below: ⑨⑩ are not routes at all, and the persistence of ⑦⑧ was counted twice. **Authoritative wording**: **8 routes** (① – ⑥ synchronous routes, **6** in total, echo directly; ⑦⑧ asynchronous POST routes, **2** in total, return only `taskId`) + **2 persisted schemas** (`GenBiResult` and the `bgp-copilot-plan-tasks` task item, i.e. the terminal-state carriers of ⑦⑧) + **⑨⑩ retrieval/memory have no independent HTTP endpoint** and are covered by the `_meta.invocations[]` of the genbi/ask response. ⚠️ What the original "8" got wrong was the **attribution** (treating the planner as an endpoint and the dual-mode genbi/ask as single-mode), **not the route count**) | **Synchronous routes (add `_meta` directly)**: ① the **synchronous branch** of `genbi/ask` (`route.ts:54 apiOk(result)`) ② `copilot` (Q&A) ③ `network-advisor` (advise) ④ `param-advisor` (advise) ⑤ `requirements/codegen` ⑥ `flink/ai-sql` (**already has `model:`; keep it and add `_meta`, the two values must be equal**).<br>**Asynchronous: must be persisted, otherwise polling cannot get it**: ⑦ the **asynchronous branch** of `genbi/ask` (`:40` returns only `{taskId,status,async}`, gated by `GENBI_ASYNC=1`) → the terminal state lives in **the `result` of `genbi/tasks/[taskId]:69-76`** ⇒ 🔴 **put `_meta` into `GenBiResult` (`types/genbi.ts:16-29`)** ⇒ the polling response **carries it automatically** (saves one change); ⑧ `copilot/plan` (**the original "planner" pointed at the wrong place**: `plan/route.ts:52` returns only `{taskId,status}`, and **the planner runs inside the task**) → the terminal state lives in **`copilot/plan/task/[taskId]:39`** ⇒ `usedModelId` **is written into the `bgp-copilot-plan-tasks` task item**.<br>**⑨⑩ retrieval / memory have no independent HTTP endpoint** ⇒ 🔴 **do not go through logs** (the approach is below) |
| 🆕 **Hybrid response: the asynchronous landing of synchronous routes (the hybrid-response fix, 2026-10-20, revision 2.4)** | Under a reasoning model (Kimi K3), routes ②③ and the three codegen routes were measured running past the CloudFront 60 s hard wall ⇒ 504 HTML ⇒ the page's `res.json()` produced gibberish. Ruling: **the seven model-calling POST routes** (② `copilot/ask` ③ `network-advisor/advise` ④ `param-advisor/advise` ⑤ `requirements/[id]/generate` + `etl-jobs/generate` + `engines/generate` ⑥ `flink/ai-sql`) uniformly go through `lib/ai/long-call-driver.ts#submitAiTask`: create a `bgp-ai-tasks` task row → claim it → start execution **in this process** → wait `AI_SYNC_WAIT_MS` (45 s, < the 60 s wall): **terminal state reached** **⇒ synchronous 200 + `_meta`, byte for byte the same shape as revision 2.3** (on failure the original error goes into the route's catch unchanged; status code and wording unchanged); **not terminal** **⇒ 202 `{ taskId, status:"running", async:true }`**, and the page polls `GET /api/ai/tasks/[taskId]` every 2 s through `lib/ai/client/ai-fetch.ts#aiFetchJson`; the terminal succeeded response carries a **top-level** `_meta` (`buildAiMeta(req, task.model, { correlationId: task.correlationId })`: the model is the one actually used and the correlationId is that of **the submitting POST**, so the polled result can be matched back to the submission log) ⇒ 🔴 **the third persisted schema = the `model: AiModelUse` attribute of the `bgp-ai-tasks` row**. Concurrency and closure follow GenBI (conditional claim write / runToken / heartbeat 8 s · stale 30 s / the 300 s ceiling `AI_ASYNC_MAX_MS` forces a timeout and never re-runs; ownership `task.userId === who.sub`, otherwise 403). `AI_ASYNC=0` falls back to pure synchronous behavior (byte for byte as before the hybrid-response fix). Acceptance wording: a synchronous 200 reads the top-level `_meta`; a 202 reads the top-level `_meta` of the terminal state from `GET /api/ai/tasks/[taskId]` (the acceptance harness's meta reader accepts both); the flink `model:` = `_meta.modelId` equality check holds on both branches. **Revision 2.5 (2026-10-21, the long-running-operation framework)**: the implementation above moved into `lib/long-ops/` (`submitAiTask` → `submitLongOp`, the seven kinds joined `LONG_OP_KINDS`, table `bgp-long-ops`, endpoint `GET /api/long-ops/[taskId]` with `/api/ai/tasks/[taskId]` as an alias for one release; a failed asynchronous branch restores the original status code through the task row's `errorStatus` — revision 2.4 always lost the status code on an asynchronous failure, a gap fixed in passing; on the page side `aiFetchJson` shrank to a thin shell and the 202 is followed to its terminal state by the global fetch interceptor); **from here on this row keeps only the `_meta` echo contract**; the wait budget / 202 payload / polling / gates are governed by [the long-running-operations design](./long-running-operations.md), **revision 1.0, section 2**, and [the multi-region execution specification](./multi-region-execution-spec.md), **revision 3.54, section 3.18** |
| 🆕 **`_meta.backend?` (added by the multi-region work, 2026-09-10)** | The execution backend **actually used** for this query (`agentcore` \| `inprocess`). 🔴 Purpose (**narrowed by a decision that afternoon**): all regions go through **the same AgentCore** (the multi-region execution specification, revision 3.41, section 3.4.5), so the normal value is always `agentcore`; the value of this field is **to expose an AgentCore failure fallback** — when AgentCore is down the platform automatically falls back to the in-process engine, and **the answers of the two paths look exactly the same**, so without the echo nobody would know that the query just ran degraded. Optional field (filled only by the query path); the shapes of the other 8 routes are unaffected |
| 🔴 **retrieval/memory go through `_meta.invocations[]` instead (no CloudWatch reads)** | Both are **sub-calls inside the genbi flow** ⇒ let genbi's `_meta` carry **`invocations: [{capability, modelId, modelSource}]`** (one query proves **all three legs: genbi + retrieval + memory**). **Reason**: going through logs would require ① discovering the ECS log group dynamically (`platform-stack.ts:718-734` sets no `logGroupName`) and ② tolerating CloudWatch's seconds-level ingestion lag — i.e. introducing yet another state source that is not hard enough. **If a log fallback is still wanted**, the API is `logger.info("ai.invoke", {capability, modelId, modelSource, correlationId})` — 🔴 the field name is **`event`, not `evt`** (`logger.ts:99-113`; `evt:` has zero hits across the repository) |
| **Single implementation point** | 🔴 The `invokeWithFallback` of section 3.5 **returns `{response, usedModelId, usedSource}`** and each endpoint puts them into `_meta`; ⇒ this naturally covers "the downgrade switched the model" (echoing the model **actually used**, not the one **intended**). ⚠️ **But it covers only the 8 "command-type" points**; the 5 agent-type sites cannot be wrapped — see the **two-form** ruling in section 3.5 |
| **Use of the contract** | The `model_config_effective` L2 contract and the model-switch acceptance checks all read `_meta.modelId`; 🔴 **the statement "CloudTrail InvokeModel modelId == new value" in the design, section 10, is void** (delivery lag, not usable as immediate proof) and refers to this section instead |

### 3.4 Decision-D9 Transport Branch (probe gating; design decision D9)

```
function pickTransport(modelId) {
  if (BRANCH === "A") return converse                    // 分支A(探测=支持):两系列都走 Converse,仅换 modelId
  return isOpenAIFamily(modelId) ? openAICompat          // 分支B:Mantle(装 openai+@aws/bedrock-token-generator,现均未装,A 核对)
                                 : converse
}
```
- **Branch A**: decision D6 "change only one field" holds; no new packages. **Preferred; adopted as soon as the probe passes.**
- **Branch B**: GPT needs (a) two packages installed, (b) dispatch by family, (c) an OpenAI-protocol adapter layer for the tool-use loops of genbi/copilot/planner/codegen. **Branch B is a separate PR and is not touched before the probe conclusion**; the phase-one specification allows a stub (contract = the three points of section 3.4), but 🔴 **phase one relies on the PUT hard gate of section 2 (P0-5) to forbid storing GPT as the global default** — otherwise an administrator could detonate the stub with one click (choose GPT → all 9 tool loops break).
- Phase-one default `global.anthropic.claude-opus-4-8` (Claude/Converse, supported as is), not blocked on the probe.

### 3.4a 🔴 Added in revision 1.1: the fixed probe rate limit (blocking point ④) and the fault-injection seam (blocking point ③)

| Item | Final |
|---|---|
| 🔴 **Probe rate limit = `6 per minute per administrator`** (the original literal "N/min" could not be executed headlessly) | Basis: one probe = one tiny invoke (maxTokens=8, 10 s timeout); 6/min is enough for manual trials and blocks scripted hammering. 🔴 **Revision 1.1: reuse the repository's existing implementation shape, do not invent one** — `lib/data-service/ratelimit.ts:18-36` already has: `windowBuckets` → **`m#<floor(epochSec/60)>`** (+ an optional `d#<floor/86400>` daily cap), **a single `UpdateItem`** (`ADD #c :one SET #ttl = if_not_exists(...)` + **`ReturnValues:"UPDATED_NEW"` atomic read-back**), returning `retryAfterSec`. ⇒ ① the sk is **`ratelimit#probe#<adminSub>#m#<bucket>`** (**no self-invented `yyyy-MM-ddTHH:mm` string**, which would be a needless fork of the in-house format); ② 🔴 **the over-limit decision must come from a single UpdateItem with `ReturnValues`** (the original "`ADD n :1` + read back" = two separate calls **with a race**); ③ over the limit → **429 `{error:"RateLimited", retryAfterSec}`**. ⚠️ **Hot partition is not a concern** (confirmed by verification): the 5 s TTL of section 3.1 cuts the read amplification of **every AI call** (unbounded), whereas the rate limiter is **administrator writes ≤ 6/min**; a single partition's 1000 WCU/s is more than enough ⇒ keep `pk="system"`. ⚠️ **Demo mode**: under `identity.ts:42`, `sub = LEGACY_PARTITION` is a constant ⇒ the rate limit collapses into one bucket shared by the whole platform (acceptable; **written into the documentation so that acceptance does not report it as a bug**) |
| 🔴 **Two mechanical requirements added to the table configuration (revision 1.1)** | ① **TTL**: `bgp-settings` must enable **`timeToLiveAttribute: "ttl"`** with values in **epoch seconds** (the firm convention of the repository's 13 tables, e.g. `database-stack.ts:170,295,332`; the write side always uses `Math.floor(ms/1000)+N`). 🔴 **Risk and protection**: fitting an automatic deleter to a configuration table that "must not be deleted by mistake" ⇒ should `ai-model#global` ever carry a `ttl` by mistake, **the global model configuration would silently disappear** (RETAIN/PITR raise no alarm) ⇒ **the `store` asserts that no `ai-model#*` item it writes carries `ttl`** (pinned by a unit test); mixing retained items in the same table has a precedent (`bgp-incidents`, `database-stack.ts:349-352`: TTL enabled at table level, master records carry no `ttl`). ② **Encryption**: reuse the repository's `hardened` spread (`database-stack.ts:18-24`, which includes **CMK encryption**); the original section 1 listed only PAY_PER_REQUEST/RETAIN/PITR and missed it |
| 🔴 **Fault injection (heavily corrected in revision 1.1: mechanism unified with the multi-region execution specification, endpoints made real, one seam fewer)** | ① **The throttle-and-fallback acceptance check uses `FAULT_THROTTLE_MODEL=<modelId>`** — `invokeWithFallback` forcibly throws `ThrottlingException` for that modelId ⇒ verifies back-off + downgrade (replacing "inject a low-quota model"). 🔴 **Mechanism = runtime environment gate + effective only on non-production targets, word for word the same as [the multi-region execution specification](./multi-region-execution-spec.md), section 8ter.2** (the original "build-time exclusion" was **a second, incompatible scheme**; and build-time exclusion would mean **acceptance does not run the release image** — the image is built once by CDK `fromAsset("../platform")` (`platform-stack.ts:727`) and `deploy-all` produces a single one; the cost is too high). ② 🔴 **The settings-table-failure acceptance check no longer needs the `FAULT_SETTINGS_TABLE` seam** — the truth: the platform **has no `*_TABLE` environment variable at all** (table names are constants compiled into the image, `lib/aws/dynamodb.ts:12`), while the repository **already has the precedent** `COPILOT_TURNS_TABLE \|\| "bgp-copilot-turns"` (`copilot/memory.ts:9`) ⇒ **give `bgp-settings` a `SETTINGS_TABLE` environment variable directly (with a default value)**; for acceptance, point it at a non-existent table in a **non-production** deployment, **zero new seams** (the ECS env goes through the CFN override at `platform-stack.ts:753-757`, one line). ③ **Enablement status shown on a real endpoint**: 🔴 `/api/system/health` **does not exist** (only `system/wiring`, `governance/health` and `incidents/health` exist) ⇒ use **`GET /api/system/wiring`** (returns `items[]{key,label,status,detail}`, exactly the source the `ai_wiring` L1 contract reads — its natural host); also written to the audit. ④ 🔴 **The failure direction when `SETTINGS_TABLE` points at a broken table must be decided item by item** (it makes **the whole store** fail, taking `__transport`/`__version`/`probe#`/rate limit with it): `resolveModelIdRuntime` → **falls back to lastGood/env/SSOT (does not throw)**; `gptTransportReady()` → **`false` (fail-closed)**; probe rate limit → **fail-closed, returns 429** (a probe burns real Bedrock calls; better to refuse than to let it through); `putProbe` → silently skipped (does not affect the main flow). ⑤ **Written into the list of change points in section 4** |
| **The catalog-does-not-probe acceptance check made testable** | The original criterion "observe that no N InvokeModel calls happened" depends on CloudTrail ⇒ changed to asserting: **the `probedAt` of the `ai-model#probe#*` items is unchanged before and after GET `/catalog`** (proving that no real probe was triggered), supplemented by a response time < 1 s |

### 3.5 🆕 `invokeWithFallback` (P0-3: throttle back-off + downgrade to the previous layer's model — the only home of the P0-4 cold cliff)

```
// lib/ai/invoke.ts(新)—— 9 消费点(+二期容器)统一走它。现 lib/ai/lib/genbi 无任何 backoff(grep 零命中,B 核对)
// 🔴 v1.1 两形态(原单一 buildCommand 形态【包不住 5 处】):
//   形态① 命令型 —— 8 个 ConverseCommand 点(genbi/agent:154、copilot/agent:69,121、advisor-agent:106、
//          param-advisor:99、codegen:150、retrieval:49、memory:122、flink-sql-ai:88)
//   🔴 形态② agent 型 —— Strands / 容器:`planner.ts:105-131`(我方只 await `agent.invoke()`)+
//          4 个容器(`infra/agent/genbi/agent.js:220`、`_runtime|netadvisor/_runtime|paramadvisor/_runtime`
//          的 `agent-runner.js:76`)。**Strands 的 `_client` 是私有**(`@strands-agents/sdk` `bedrock.d.ts:222-224`)、
//          SDK 内部自建 `BedrockRuntimeClient`(`bedrock.js:167`)与 `ConverseCommand`(:350)⇒ **无法注入 command**。
//          故 agent 型签名 = `(modelId) => runAgent(modelId)`(整个 agent 调用作为可重试单元);
//          Strands 另有 `updateConfig()` 与 typed `ModelThrottledError` 可用(`bedrock.d.ts:294,327`)。
//   ⚠️ **agent 型的幂等约束(必须写明)**:重试会【重跑整个多轮 tool 循环】 ——
//      planner 的工具是只读、幂等 ✅;但容器 `agent.js:210-216` 会【重复 append steps】⚠️
//      ⇒ 容器侧重试前须清空/去重 steps,或对容器只做"退避不降级"。
async function invokeWithFallback(capability, region, buildOrRun, kind: "command"|"agent"):
        Promise<{response, usedModelId, usedSource}> {
  const layers = await resolveLayered(capability, region)   // [runtime?, env?, ssot] 去重后有序候选
  for (let li=0; li<layers.length; li++) {
    const modelId = layers[li]
    for (let attempt=0; attempt<=MAX_RETRY; attempt++) {    // MAX_RETRY=2,指数退避 base 200ms
      try { return await bedrock.send(buildCommand(modelId)) }
      catch (e) {
        if (isThrottle(e) && attempt<MAX_RETRY) { await backoff(attempt); continue }  // 退避重试
        if (isThrottleOrUnavailable(e) && li<layers.length-1) break  // 🔴 降级:回落解析链下一层模型
        throw e                                              // 非限流类错误 or 最后一层耗尽:抛给调用方
      }
    }
  }
}
```
- 🔴 **Ruling / optional phasing**: `invokeWithFallback` is the **only feasible home** for the design, section 9.3, P0-4 and the acceptance of section 10 (otherwise the "runtime Throttle → downgrade" acceptance can never pass). The **back-off retry** part is cheap and must enter the first construction phase; **automatic downgrade to another model** could be split into an immediately following fast-follow to lighten the first construction phase, but the design, section 10, already lists it in that phase's acceptance, so by default both are done together.
- `quotaHint` (section 3.2) serves only as a yellow hint before switching and **cannot hold the cold cliff**; the real line of defense is this wrapper's runtime downgrade (P2-2).

---

## 4. Change list (converged from the design document, section 9.1; implementation level)

**A. New (purely additive, zero regression of existing code)**:

| Item | Location | Notes |
|---|---|---|
| `bgp-settings` table | CDK **`DatabaseStack`** | section 1 (naming corrected) |
| `lib/settings/store.ts` | new | bgp-settings read/write + **the store alone concatenates the `ai-model#` prefix** + optimistic lock (conditional write on `version=:v`, 409) + `getVersion/bumpVersion` (ADD) + `putProbe/getProbe` + audit hooks |
| `lib/ai/probe.ts` | new | section 3.2 tiny invoke + error classification (net new) + quota / tool-use probe |
| 🆕 `lib/ai/invoke.ts` | new | section 3.5 `invokeWithFallback` (backoff + degradation; **returns `{response, usedModelId, usedSource}`** for the echo of section 3.3a) + 🆕 **`FAULT_THROTTLE_MODEL` seam** (compiled in only for non-production builds) |
| 🆕 `_meta.modelId` echo | **8 locations** (section 3.3a) | genbi/ask (+ tasks terminal state), copilot, copilot/plan, network-advisor, param-advisor, requirements/codegen each add `_meta` to the `apiOk()` envelope;<br>retrieval/memory have no HTTP endpoint → structured log `evt:"ai.invoke"`.<br>flink keeps its existing `model:` and adds `_meta.modelId` (the two values must be equal) |
| 🆕 transport gate (**phase 2**) | `sk="ai-model#__transport"` + `PUT /transport` endpoint + `gptTransportReady()` | the hard gate of section 3.4 against the OpenAI family (a must-have requirement) reads it; **constantly false in phase 1**; on exception ⇒ fail-closed |
| 🆕 `SETTINGS_TABLE` env (with default) | `lib/settings/store.ts` + `platform-stack.ts:753-757` CFN env override | follows the `COPILOT_TURNS_TABLE` precedent; **replaces the former `FAULT_SETTINGS_TABLE` seam** (section 3.4a ②) |
| 🆕 table mechanics | `DatabaseStack`: `hardened` spread (CMK) + `timeToLiveAttribute:"ttl"` | the store **asserts there is no `ttl`** when writing `ai-model#*` (unit test) |
| 🆕 seam status display | `GET /api/system/wiring` gains one entry | 🔴 **not `/api/system/health` (it does not exist)**; the `FAULT_*` armed state + written to the audit log |
| 🆕 probe rate limit | `sk="ratelimit#probe#<adminSub>#m#<bucket>"` (TTL 5 min; revision 1.2 aligns it with sections 1 / 3.4a, the earlier `<minute>` was a third spelling) | **6 per minute per administrator**; above the limit 429 (section 3.4a) |
| `resolveModelIdRuntime` + `resolveWithProvenance` | added to `lib/ai/model.ts` | sections 3.1 / 3.1a; the original synchronous `resolveModelId` (:19) is untouched |
| 3 groups of API routes | `/api/admin/model-config` (GET/PUT/DELETE) `/catalog` `/probe` | section 2 (**no `/effective` is created**) |
| "AI model" card on /settings | `app/settings/page.tsx` | no new page, zero change to routes.tsx (interaction design) |

**B. Changes to existing code (regression risk, item by item)**:

| Item | file:line (current values verified by code review) | Risk |
|---|---|---|
| Re-evaluation at the 9 consumer points | agent.ts:155 / retrieval.ts:50 / memory.ts:123 (@17) / copilot/agent.ts:70,122 / planner.ts:107 (Strands) / advisor-agent.ts:107 / param-advisor/index.ts:100 (@25) / flink-sql-ai.ts:89 / codegen.ts:151 | all async → await is safe; change only the call sites, not the config shape; go through section 3.5; one independent commit per point |
| **Hidden reader flink-sql-ai.ts:101** | same file :101 → ai-sql/route.ts:22,23 | if missed, the reported name ≠ the actual one (section 3.3) |
| config `modelId` marked deprecated | genbi/config.ts:16 / copilot:14 / net-advisor:20 | keep the field, do not change the shape; also clean the stale "sonnet-4-5" comments at config.ts:15 / memory.ts:17 (code-review finding) |
| 🔴 **AgentCore container side reads the payload (phase 2; closes the hot-reload-boundary gap)** | container `agent.js:220` / `agent-runner.js:76` read `input.modelId ‖ env ‖ fallback`; client `agentcore-client.ts:42` adds `modelId` to the payload | **rebuild the image + redistribute (shared runner source) + redeploy the Runtime** — heavier than in-process; ⚠️ revision 0.1 listed only the client side and missed the container read side, while acceptance requires "container log == new value"; this was a gap inside the specification itself, now closed |
| Fix the drift of the 4 container fallback literals | agent.js:21 + _runtime×3 agent-runner.js:18 (currently sonnet-4-5, drifted from the SSOT opus-4-6, confirmed by code review) | change the **shared source + redistribute** (core-prebuild); changing only the copies creates new drift |
| ai-model.json `$comment` | — | demote the wording to "factory default"; **the value is not changed** (still opus-4-6, honoring the backward-compatible resolution-priority decision; `$modelPolicy` records that opus-4-8 was once not-available, verified by code review) |
| **(Branch B) GPT transport adaptation** | new OpenAI-compatible client + tool protocol adaptation | done only if the probe gate lands on Branch B; separate PR (section 3.4) |

---

## 5. Acceptance (implementation level; 🔴 explicit split between the phase 1 and phase 2 scope)

**Phase 1 (in-process / ECS · inprocess path) — hard acceptance of this delivery**:
- [ ] `bgp-settings` table created, `RETAIN` + PITR, `__version` defaults to 0 on a cold table, the first write self-creates it via `ADD`; no IAM change.
- [ ] PUT of a legal modelId (∈ catalog, both families + probe passed) → 200 + version++; GET `effective[]` echoes the `source` layer accurately (runtime/env/ssot); with a stale `expectVersion` → 409.
- [ ] PUT of a model that is not enabled → 400 `{reason:"MarketplaceSCP"|...}` and nothing is written; PUT `openai.*` (phase 1) → **400 `NotAllowedFamily`** (the must-have hard gate against the OpenAI family).
- [ ] PUT via the API directly of `us.anthropic.claude-haiku-4-5` (not in the two families) → **400 `NotInCatalog`** (the allow-list is not front-end only; server-side allow-list requirement).
- [ ] **≤ 5 s after saving, the very next query uses the new model** (bump-version; the "second-level effect" must-have requirement): **the modelId echoed in the response envelope == new value** (a reliable state source, not CloudTrail alone; reliable-state-source requirement).
- [ ] **Hard evidence at each of the 9 consumer points** (catches a missed reader): switch to a model clearly different from the SSOT → trigger the 9 features one by one, **each response envelope / log modelId == new value**; **verify flink-sql-ai:101 → ai-sql/route.ts:22/23 separately in particular** (both the audit record and the response body == new value). Any point still on the old model = FAIL. A smoke test (features did not crash) **cannot substitute** for this item.
- [ ] DELETE of all overrides → `fellBackTo` falls back to env/SSOT (= the behavior before the change, the backward-compatible resolution decision, reported by `resolveWithProvenance`).
- [ ] 🔴 **Resilience (must-have)**: **point the `SETTINGS_TABLE` env at a non-existent table** (non-production deployment; section 3.4a ②, **no longer a "temporary wrong table name"**) → AI features **remain usable** (`_meta.modelSource` = `env`/`ssot`, no 500 is thrown); at the same time assert that `gptTransportReady()` is **fail-closed** and that the rate limit is **fail-closed 429**.
- [ ] 🔴 **Cold cliff (the must-have items on tool-use adaptation and quota cliff)**: **`FAULT_THROTTLE_MODEL=<current model>`** (runtime env gate, non-production targets only; **no longer a "low-quota model"**) → exponential backoff + **degrade to the model of the previous layer** (assert `_meta.modelId` == the fallback layer), no avalanche under high concurrency.
- [ ] 🆕 **`_meta` echo delivery** (section 3.3a): 6 synchronous routes + **2 asynchronous task items persist `usedModelId`** + `_meta.invocations[]` covers retrieval/memory; flink's `model:` and `_meta.modelId` are **equal**.
- [ ] 🆕 **probe rate limit**: ≤ 6/min normal, the 7th call **429**; the counter sk is `ratelimit#probe#<adminSub>#m#<bucket>`.
- [ ] 🆕 **overrides allow-list**: `overrides[]` of `GET /model-config` **does not contain** `__version`/`__transport`/`probe#`/`ratelimit#` (prevents type violations + adminSub leakage).
- [ ] 🆕 **`ai-model#*` items carry no `ttl`** (unit-test assertion; prevents the configuration from being silently deleted by TTL).
- [ ] **transport gate**: in phase 1 `gptTransportReady()` is **constantly false** (the endpoint / the DDB item / the transport-gate negative case **all belong to phase 2**).
- [ ] `model_config_effective` L2 contract: read `effective[]` of GET `/model-config` (a synchronous, real state source) and assert == new value (**not** CloudTrail, to avoid delivery lag; guards the must-have "switching to a wrong model").
- [ ] contract-guard verify reports zero FAIL (`ai_wiring` does not read modelId, necessary but not sufficient — covered by the items above).

**Phase 2 (AgentCore / container path + the transport-decision branch) — not verified in phase 1, explicitly marked**:
- [ ] 🔴 **Hot-reload boundary**: in phase 1 hot reload covers **only the in-process path**; with `GENBI_BACKEND=agentcore`, a configuration change **does not take effect in phase 1** for Ask-Your-Data and for the netadvisor / paramadvisor containers (they still use the Runtime env) — **not a bug**. Only after payload pass-through + the container read-side change have landed (phase 2) does the switch become hot, and only then is "container log payload.modelId takes effect" verified.
- [ ] (Branch B) GPT tool-use protocol adaptation layer: each of the 4 tool loops verified headlessly ([the design document](./model-configuration.md), section 9.3, the GPT tool-use must-have item), added after the phase 2 branch is settled.
- [ ] **(Second stage)** per-region (phase 3) / per-capability (phase 4): see [the design document](./model-configuration.md), section 10; not verified in phase 1.

> The complete positive/negative matrix, headless-script design, contracts, hard evidence and rollback acceptance are kept in the module's acceptance record (an engineering record, not part of the public repository). Acceptance scripts stay on the developer machine and are never committed.

---

## 6. 🆕 Revision 1.3 — rewrite-and-landing addendum (2026-09-05; rewritten with the GPT branch as the **reference implementation**, not copied; scheduled as a work package of the multi-region execution program, roadmap items ② / ④)

> - 🔴 Relation to sections 1–5: sections 1–5 are the contract; this section only adds "how to land it" and "the scope of this wave". On conflict, the **corrections** in this section prevail (every correction keeps its retraction wording on the same line).
> - 🔴 **Production-form correction (decided on 2026-09-05, verbatim: "a real production environment has exactly one account with several regions; a multi-account situation never occurs")**: in the multi-region-dimension decision, the reason "same region, different accounts" **becomes secondary**;
>   keys and caches are still shaped by `targetId`, and the load-bearing reasons become ① the platform identity is uniformly `targetId` ② two blue/green targets in the same region each keep their own setting ③ zero table migration.

### 6.1 Five patterns → our locations (what is worth taking from the reference implementation, rewritten to our contract)

| # | Pattern | Location | Gate |
|---|---|---|---|
| ① | probe-before-save | `ModelSettingItem.probeOk: true` in `lib/settings/model-store.ts` (a **literal type**, not boolean); the parameter of `putGlobalModel()` accepts only `ProbeResult & { ok: true }` ⇒ a value that was never probed / failed its probe **cannot be written at the type level** (the type-level landing of the "force a real probe before saving" decision); validated once more at runtime (fail-closed) | unit test: `@ts-expect-error` passing `probeOk:false` must produce an error (type-level probe-before-save acceptance item) |
| ② | last-good + `stale` | resolution chain in `lib/ai/model.ts`: `_lastGood: Map<scopeKey, { modelId, at }>`;<br>a DDB read exception ⇒ return the last-good value and mark the source **`runtime-stale`** (a new `SourceLayer` value; `effective[].stale=true` in GET `/model-config`);<br>no last-good ⇒ env ⇒ ssot | the DDB-fault-resilience and last-good + stale acceptance items |
| ③ | audit and configuration in one transaction | the `PUT` write = **one `TransactWriteCommand`**: conditional write of the configuration item (`version=:expect`) + `__version` ADD + `bgp-audit` Put, three items in one transaction ⇒ if the audit record cannot be written the configuration does not take effect (the same discipline as step 6 of [the multi-region execution specification](./multi-region-execution-spec.md), section 3.9a; the audit item shape reuses the `writeAuditRecord` shape of `lib/audit.ts`, no second one is written) | unit test: mocked transaction failure ⇒ configuration unchanged + 503 |
| ④ | optimistic lock | `version` per item (fixed in section 1) + `ModelVersionConflictError` ⇒ 409 `VersionConflict` | the negative case of the save acceptance item |
| ⑤ | **AgentCore receipt validation** `assertAgentCoreModelMeta()` | 🆕 `lib/ai/agentcore-contract.ts`: when the platform calls the Runtime the payload carries `{ modelId, releaseId }`;<br>the container receipt `_meta.modelId` **must** equal the expected value (missing / unequal ⇒ throw `AgentCoreModelMismatch` ⇒ that call fails closed with 503, "AI Wiring Health" on `/settings` turns red);<br>on the container side `_runtime/agent-runner.js` / `genbi/agent.js` read `payload.modelId ‖ env ‖ fallback` and **echo** `_meta.modelId` | the AgentCore receipt acceptance item; the container is changed in the **shared source + redistributed by core-prebuild** (the second caveat of the request-level pass-through decision); delegated workers do not hand-edit the copies |

### 6.2 Three traps avoided (what must not be copied from the reference implementation)

1. **Keys and caches are shaped by `<targetId>` from the first line**: `scopeKey = "<targetId>#<capability ?? global>"`; the cache is a `Map<scopeKey, …>`, not a singleton; in phase 1 targetId is always `tgt_home` and capability always global ⇒ the sk written in phase 1 is **still** `ai-model#global` (the multi-region-dimension decision: phase 1 key values unchanged, shape extensible). 🔴 Literal types such as `sk: typeof GLOBAL_MODEL_SK` that pin the key are not allowed.
2. **Both parameters of `resolveModelIdRuntime(capability, targetId?)` are really wired**: `deriveScope(capability, targetId)` returns `"global"` in phase 1, but the call sites **already pass capability now** (each of the 9 consumer points has its own key; the allow-list is `Capability` in section 2) — the per-capability phase changes only `deriveScope`, in one place.
3. **`isModelIdFormatValid(modelId, { region? })`**: regex + `region` hook (in phase 1 `region` is omitted and not judged; the per-region phase fills in the judge "a `us.` inference profile is bound to fail in a non-US region", a must-fix multi-region requirement).

### 6.3 Scope of this wave (first parallel construction wave; built by delegated workers, the lead session merges + deploys + runs the acceptance gate)

| Stage | Done in this wave | Not done in this wave (recorded honestly, with owner) |
|---|---|---|
| **Phase 1** | all new items of section 4-A (⚠️ measured when opening the package: the `bgp-settings` table **already exists** [created in the multi-region baseline stage, `hardened` + `ttl` at table level] and `TABLES.SETTINGS` already carries the `SETTINGS_TABLE` env ⇒ these two rows are **already done**) + section 4-B re-evaluation at the 9 consumer points + `_meta` echo in 8 routes + 2 persisted + `invocations[]` + the "AI model" card on `/settings` (scenarios one / two / four of [the interaction design](./model-configuration-interaction.md), section 2, + every state of section 3 + FeatureGuide;<br>read-only for non-admins) + probe rate limit + `invokeWithFallback` (backoff + degradation, both forms) + `FAULT_THROTTLE_MODEL` seam + one more entry in `GET /api/system/wiring` + `gptTransportReady()` **constantly false** | — |
| **Phase 2, code side** | AgentCore payload pass-through + container read side (shared source) + `assertAgentCoreModelMeta` + fixing the drift of the 4 container fallback literals (they now read the SSOT injected at build time) + the `PUT /transport` endpoint and the `__transport` item + the transport-gate negative unit test | **Deployment** (ECS + core-prebuild + Runtime redistribution `-c runtime=1`) and the **real transport probe** (a real invoke of `openai.gpt-5.6-*` from the platform account) are done by the lead session after the merge; transport stays fail-closed until probed |
| Phase 3 / phase 4 | not done (the key shape is already ready) | with the multi-region per-region configuration phase / the second stage |

**File surface (the only files delegated workers may touch)**: see the "file surface" of the corresponding work package (revision 1.6) of the multi-region execution program. 🔴 **Do not touch**: `infra/lib/**` (the table is already there, zero IAM change), any contract document, `lib/exec-env/**`, the shape of `lib/audit.ts` (call only).

### 6.4 Acceptance addendum (acceptance record revision 1.3, section 7: four new matrix items + the headless gate segment for model configuration)

- Unit-test gate `model-config-guard.test.ts`: (a) none of the 9 consumer points reads a module-load-time `modelId` constant any more (`MODEL_ID = resolveModelId()` / `modelId: resolveModelId()` have zero hits at consumer points;
  - the `config.ts` field is kept but marked deprecated) (b) `probeOk: true` literal type (`@ts-expect-error` target) (c) `ai-model#*` writes assert no `ttl` (d) the cache key contains targetId (e) `gptTransportReady()` constantly false (phase 1) (f) `assertAgentCoreModelMeta` throws when missing / unequal.
- Headless segment for **model configuration** (a developer-machine acceptance script registered in the all-regions suite; run by the lead session after merge and deployment): the matrix items for saving a legal model / the phase 1 GPT hard gate / the server-side allow-list / second-level effect / the 9-point `_meta.modelId` evidence / restoring the factory default / permission depth / catalog without probe-all / probe rate limit / echoed value = actual value, plus the four new items (type-level probe-before-save, last-good + stale, AgentCore receipt validation, keys and cache per targetId). The last line reports the totals ("N items in total, M failed"), zero ⚠️.

### 6.5 🆕 Revision 1.4 — landing corrections (2026-09-05, fed back from the construction log of the first parallel wave; merged into the development branch; ★ = a deviation from the contract awaiting decision; until decided, the record in this section prevails)

1. **`_meta` location**: `apiOk(data, status?, meta?)` third parameter ⇒ envelope `{success, data, _meta}` (top level); the genbi synchronous response also lands `data._meta` (the front end's existing read path); asynchronous tasks persist it in `result._meta` with the task item; the three legs of `_meta.invocations[]` = main loop / retrieval re-ranking / memory long-term summary (the memory leg is asynchronous and can only echo `deferred:true`). The "echoed fields" of section 3.3a are governed by this.
2. ★ **Error body shape**: `/api/admin/model-config*` uses the flat shape of section 2, `{ error: <code>, message | detail | reason }`, which is **inconsistent** with the site-wide `apiError` envelope `{success:false, error:{message, code}}`. Awaiting decision: A = switch to the site-wide `apiError` + `error.detail.code` (the front-end `AiModelCard` changes accordingly); B = keep the flat shape and note in section 2 "exception for the model-configuration admin plane".
3. **`BGP_NONPROD_TARGET=1`** (new contract env): the explicit marker of a non-production deployment; the `FAULT_THROTTLE_MODEL` seam is armed only when it is `1`, otherwise inert (fail-closed); registered in the identifier-consistency list of the multi-region acceptance criteria.
4. **`releaseId`** source = `BGP_RELEASE_ID || IMAGE_TAG || "unknown"` (`currentReleaseId` in `lib/ai/agentcore-contract.ts`); CDK currently injects no build id ⇒ constantly `unknown` on live systems; the phase 2 deployment side adds the injection (platform stack env `BGP_RELEASE_ID=<git sha>`).
5. **All three codegen routes echo `_meta`** (`requirements/[id]/generate` / `engines/generate` / `etl-jobs/generate`; the original text listed only one).
6. **Container read side** (`infra/agent/_runtime/agent-runner.js` / `genbi/agent.js`): model = `payload.modelId ‖ env BEDROCK_MODEL_ID`, **throws when both sources are missing** (fail-closed), no built-in model-name literal any more (the former 4 hand-copied sonnet-4-5 literals had drifted from the SSOT, confirming [the design document](./model-configuration.md), section 1.1); echoes `_meta.{modelId, modelSource}`.
7. **Read-only effective value for non-admins** is served by `GET /api/settings` (`aiModel:{modelId, source}`); the "AI model" card on `/settings` renders read-only for non-admins (does not expose `/api/admin/**`).
8. ★ **Order of rejection reasons for the GPT family**: the catalog gate of PUT comes before the family gate ⇒ when this account's catalog has no `openai.gpt-5.6-*` (Marketplace / SCP) the error is `NotInCatalog`, whereas the semantics of section 3.4 is `NotAllowedFamily`. Awaiting decision: A = family gate first (GPT always `NotAllowedFamily`, consistent with the transport decision); B = keep catalog first ("not in the catalog" is the more fundamental fact).
9. **Shared pieces**: the third parameter of `apiOk` is backward compatible (old two-parameter calls are byte-for-byte unchanged); `lib/audit.ts` extracts `buildAuditItem` (a pure function) for reuse by TransactWrite, `writeAuditRecord` = `buildAuditItem` + one Put, behavior unchanged.
10. **New dependency** `@aws-sdk/client-bedrock` (catalog `ListFoundationModels` / `ListInferenceProfiles`; probing still goes through `client-bedrock-runtime`).
11. **Deployment surface**: after the merge, `core-prebuild.sh all` → three ARM64 images → three `*AgentCoreStack -c *-runtime=1 -c *-agent-tag=<sha>` → then redeploy the platform stack (the order cannot be reversed: new platform + old containers ⇒ the receipt lacks `_meta.modelId` ⇒ the three AI capabilities fail closed with 503).
12. **Retrieval re-ranking leg under the agentcore backend** (caught by the 9-point evidence item of the headless segment in a real environment): retrieval re-ranking is done inside the container, so the in-process sink receives nothing ⇒ the container reports every real Converse call of the model client used for retrieval, and the receipt `_meta.invocations[]` carries `genbi-retrieval`;
    - the platform client merges them and runs `assertAgentCoreModelMeta` **on each entry** (a sub-call that switched models = the same class of wiring fault, fail-closed), and the agentcore branch of `execute.ts` merges them into `_meta.invocations[]`.
    - The three legs of section 3.3a are thus equally observable in the production form (agentcore).

---

## 7. 🆕 Revision 2.0 — multi-vendor model channel (2026-10-14; based on the design document, section 12; **revision 2.1 corrected against the landed code**; file references follow the feature code landed on 2026-10-14)

### 7.1 Vendor profiles (TS contract; `platform/src/lib/ai/core/vendors.ts`, zero `@/`, zero SDK)

```ts
export type Family = "anthropic" | "openai" | "zai" | "moonshotai";
export type InferenceField = "temperature" | "topP" | "stopSequences";
export const INFERENCE_FIELDS: readonly InferenceField[];
export type InferenceFieldSupport = Record<InferenceField, boolean>;
export interface VendorProfile {
  family: Family;
  label: string;                       // 下拉分组标题(中文原文为 i18n 键)
  selectable: RegExp;                  // 作用在**去掉地理前缀后**的 id 上
  toolUse: "assumed" | "probe";        // assumed = 不二探(Claude 现状即支持);probe = 探测必做二探,PUT 要求 toolUseOk === true(D11)
  inferenceFields: InferenceFieldSupport;   // false 的字段整形时剥掉(D12)
  reasoningBlocks: boolean;            // 恒回 reasoningContent 块(只做标注与系数依据,D13)
  maxTokensFactor: number;             // 量出来的(Kimi K3 ≈ Claude 2.1× ⇒ 2)
}
export const VENDORS: Record<Family, VendorProfile> = {
  anthropic:  { label:"Claude Opus",                    selectable:/^anthropic\.claude-opus-/,        toolUse:"assumed", inferenceFields:{temperature:true, topP:true, stopSequences:true},  reasoningBlocks:false, maxTokensFactor:1, … },
  openai:     { label:"OpenAI GPT-5.6(经 Bedrock)",     selectable:/^openai\.gpt-5\.6-/,              toolUse:"probe",   inferenceFields:{temperature:true, topP:true, stopSequences:true},  reasoningBlocks:false, maxTokensFactor:1, … },
  zai:        { label:"GLM 5(Z.AI 智谱,经 Bedrock)",    selectable:/^zai\.glm-5(?![0-9])/,            toolUse:"probe",   inferenceFields:{temperature:true, topP:true, stopSequences:false}, reasoningBlocks:false, maxTokensFactor:1, … },
  moonshotai: { label:"Kimi K3(Moonshot AI,经 Bedrock)", selectable:/^moonshotai\.kimi-k3(?![0-9])/,  toolUse:"probe",   inferenceFields:{temperature:false, topP:false, stopSequences:false}, reasoningBlocks:true, maxTokensFactor:2, … },
};
export const FAMILIES: readonly Family[] = ["anthropic", "openai", "zai", "moonshotai"];   // 顺序 = 下拉分组顺序 = 目录排序的系列序
export const GEO_PREFIX_RE = new RegExp(`^[a-z]+(?:-[a-z]+)*\\.(?=(?:${FAMILIES.join("|")})\\.)`);   // 由系列键生成
export function stripGeoPrefix(id: string): string;  export function familyOf(id: string): Family | null;
export function vendorOf(id: string): VendorProfile | null;  export function isSelectableSeries(id: string): boolean;
export function isOpenAIFamily(id: string): boolean;         // 保留,D9 门还用
export interface FamilySummary { family: Family; label: string; toolUse: VendorProfile["toolUse"]; reasoningBlocks: boolean }
export function familySummaries(): FamilySummary[];          // GET /catalog 的 families[]
```

- `(?![0-9])`: `zai.glm-5` / `zai.glm-5.3` pass, `zai.glm-50` does not; `moonshotai.kimi-k3` passes, `kimi-k30` does not. glm-4.x / kimi-k2.x / sonnet / haiku / other vendors do not pass.
- `Family` / `GEO_PREFIX_RE` / `stripGeoPrefix` / `familyOf` / `isOpenAIFamily` in `capabilities.ts` have been changed to re-export this file;
  - so has `isSelectableSeries` in `model-catalog.ts`.
  - **No second copy of the family regexes may appear anywhere in the repository**: gate unit test `model-config-guard.test.ts` (g) scans `platform/src` (comments stripped) and requires that, outside `vendors.ts` and the tests, there is no `anthropic\.claude-opus-` / `openai\.gpt-5\.6-` / `zai\.glm-5` / `moonshotai\.kimi-k3` / `(?:anthropic|openai)`, and that `scripts/resolve-home-model.sh` contains no vendor regex.

### 7.2 Request shaping (`platform/src/lib/ai/core/converse-shape.ts`; **real signatures**, replacing the `shapeConverseRequest` pseudocode of revision 2.0)

```ts
export interface InferenceConfigLike { maxTokens?: number; temperature?: number; topP?: number; stopSequences?: string[] }
export const UNSUPPORTED_FIELD_RE = /doesn't support the (temperature|topP|stopSequences) field/i;   // 2026-10-14 Bedrock 原话
export function learnUnsupportedField(modelId: string, err: unknown): InferenceField | null;  // 命中 ⇒ 记住并返回字段名;别的错误 ⇒ null、不记
export function learnedUnsupportedFields(modelId: string): InferenceField[];
export function _resetLearnedForTests(): void;
export interface ShapeResult<T> { config: T; stripped: InferenceField[]; boosted: boolean }
export function shapeInferenceConfig<T extends InferenceConfigLike | undefined>(modelId: string, cfg: T): ShapeResult<T>;
export function shapeConverseInput<T extends { modelId?: string; inferenceConfig?: InferenceConfigLike }>(input: T): { input: T; stripped: InferenceField[]; boosted: boolean };
```

- Shaping rules: strip the fields whose profile `inferenceFields[f] === false` **or** that were learned at runtime; `maxTokens × maxTokensFactor` (rounded); an unknown family only gets the learning, with factor 1; an empty `cfg` is returned as is; **if nothing changed, the original reference is returned** (`shapeConverseInput` shallow-copies `inferenceConfig` only when something really changed; the message body is always the original reference). Identity for the Claude family (pinned by the unit test `converse-shape.test.ts`).
- 🔴 The "learned unsupported fields" hang off `globalThis[Symbol.for("kf.ai.converse-shape.learnedUnsupportedFields")]` (in the Next build artifact the same source file exists as several module instances, and module-level Maps cannot see each other); forgotten on process restart — the profile is the baseline, learning only patches holes.
- **Platform location = `invokeConverse`** (`lib/ai/invoke.ts`): after `build(modelId)` has produced the command, `shapeInferenceConfig(modelId, cmd.input.inferenceConfig)`, write back to `cmd.input.inferenceConfig` only if something changed, then `client.send`;
  - in the catch of `invokeWithFallback`, **first** `learnUnsupportedField(modelId, e)`; if something was learned ⇒ retry once immediately on the same layer (`attempt--; continue`: **does not consume the throttle-retry budget**, no backoff, no degradation, at most once per layer, counted in `attempts`), then the original three branches "throttle backoff / unavailable switch layer / rethrow as is".
  - `InvokeOutcome` gains an optional `shaped?: InferenceField[]` (the fields stripped on the successful attempt; filled only by `invokeConverse`; absent when empty).
- **The Strands variant** has no `ConverseCommand` to shape and only takes the maxTokens factor: `BedrockModel({ maxTokens: shapeInferenceConfig(modelId, { maxTokens: COPILOT.planMaxTokens }).config.maxTokens })` in `lib/copilot/plan/planner.ts`.
- **Container locations** (`core-dist/ai` of section 7.6): the retrieval re-ranking ModelClient of genbi `agent.js` first runs `shapeInferenceConfig(MODEL_ID, { maxTokens, temperature })` and then `send`; in the catch, a `learnUnsupportedField` hit retries once (other errors are rethrown as is);
  - the Strands `BedrockModel maxTokens` of genbi `agent.js` and of `_runtime/agent-runner.js` both go through `shapeInferenceConfig(...).config.maxTokens`.
- 🔴 Shaping **only removes fields and only enlarges maxTokens**; it never adds fields and never changes the message body.

### 7.2b Transient stream errors (`platform/src/lib/ai/core/transient.ts`; the transient-retry decision of the design document; revision 2.2)

```ts
export const TRANSIENT_MODEL_ERROR_RE: RegExp;            // 闭合清单:Stream ended without completing a message | ModelStreamErrorException | Throttling | ServiceUnavailable | InternalServer | ModelNotReady | ECONNRESET | socket hang up | EPIPE | ETIMEDOUT
export function isTransientModelError(e: unknown): boolean; // 名 / 原话 / code 命中清单,或 $metadata.httpStatusCode ∈ {429, 503};null / 空对象 / 字段被拒 / 账号级被拒 ⇒ false
export const TRANSIENT_MAX_RETRIES: 1;                    // 不含首发
export function transientBackoffMs(attempt: number, rand?: () => number, baseMs = 600, capMs = 2400): number; // 全幅抖动 [0, min(cap, base·2^attempt)]
export function describeModelError(e: unknown): { name: string; message: string; status: number | null; transient: boolean }; // message 截 400
```

- Locations: `infra/agent/genbi/agent.js` and `infra/agent/_runtime/agent-runner.js` (+ the distributed copies under `netadvisor` / `paramadvisor/_runtime/`): `const mkAgent = () => new Agent({ …, messages: [...messages] })`;
  - `for (attempt = 0; ; attempt++) { try { result = await mkAgent().invoke(…); break } catch (e) { const d = describeModelError(e); console.error(…); if (d.transient && attempt < TRANSIENT_MAX_RETRIES) { steps.push({ tool: "model", phase: "retry", … }); await sleep(transientBackoffMs(attempt)); continue } return <existing fallback> } }`.
- Unchanged: the platform-side `invokeConverse` does not add this (non-streaming Converse has never shown this class of error; if it ever needs it, it imports this one list only); the "learn a field + same-layer retry" of the request-shaping decision and this section are two different things (the former is the ValidationException wording, the latter stream / throttle / 5xx) and neither contains the other.
- Artifacts: `tsconfig.ai-core.json` includes the three files; `core-prebuild.sh ai` produces `core-dist/ai/transient.{js,d.ts}` in the three containers.

### 7.3 Probe (`probe.ts`) changes

```
PROBE_MAX_TOKENS 8 → 24 (with 16 tokens Kimi's output is entirely consumed by reasoning and still returns 200; with 24 at least one block is visible)
both commands — the tiny ping and the tool-use second probe — go through shapeConverseInput ⇒ the same path as real calls (Kimi's ping actually sends maxTokens=48 because of the ×2 factor, pinned by unit test)
toolUseOk = vendorOf(modelId)?.toolUse === "probe" ? await probeToolUse(modelId) : true      // previously only for openai
classifyProbeError:  ① /is not available for this account|contact AWS Sales/i ⇒ "NotAvailableForAccount" (new; placed first — the body is also an AccessDeniedException and contains "not available")
                     ② the former order MarketplaceSCP / AccessDenied / Throttle / NotFound is unchanged
ProbeError = "AccessDenied" | "NotFound" | "MarketplaceSCP" | "Throttle" | "NotAvailableForAccount"
```

### 7.4 PUT `/api/admin/model-config` flow change (step ③′ inserted after step ④)

```
① format pre-screen → ② ∈ catalog (after filtering to the four families; NotInCatalog detail = "<id> 不在可选系列目录内(<VENDORS 四个 label 以 / 连接>)", not hand-written)
→ ③ openai family && !gptTransportReady() ⇒ 400 NotAllowedFamily (unchanged)
→ ④ probeModel (must pass) → ③′ vendorOf(modelId)?.toolUse === "probe" && probe.toolUseOk !== true ⇒ **400 ToolUseUnavailable**
   { detail: "<modelId> 在 Converse 下不能调用工具(tool-use 探测未通过),问数 / Copilot / 顾问会哑火,不能设为全局默认" } (nothing written to the table, no audit record)
→ ⑤ putGlobalModel (unchanged)
```
The `modelConfigError` error-code union (`lib/settings/admin-guard.ts`) gains `ToolUseUnavailable`. The Claude family (`toolUse:"assumed"`) does not look at `toolUseOk`.

### 7.5 Catalog GET `/catalog`

- `isSelectableSeries` is profile-driven ⇒ both the base models and the inference profiles of `zai.glm-5*` and `moonshotai.kimi-k3*` enter the catalog; `family` has four values.
- **Ordering**: entries with `available === true` come first (any family), then by `FAMILIES` order (anthropic → openai → zai → moonshotai), then by id.
- The response gains `families: FamilySummary[]` (`familySummaries()`); the front end reads the group titles / order / the "tool-use probe required" and "always reasoning blocks" tags only from here and no longer hard-codes "two families".

### 7.6 Shared container core (core-prebuild)

- `scripts/core-prebuild.sh` registry `[ai]`: tsconfig `platform/tsconfig.ai-core.json` (includes only `src/lib/ai/core/vendors.ts` and `converse-shape.ts`, rootDir `src/lib/ai/core`, CJS), CAP_DESTS = `infra/agent/genbi/core-dist/ai infra/agent/netadvisor/core-dist/ai infra/agent/paramadvisor/core-dist/ai`;
  - the explicit order of `all` is `genbi paramadvisor netadvisor cookbook ai` (a parent capability's build does `rm -rf <container>/core-dist`, so subdirectory capabilities must come after it).
- 🆕 `CAP_AFTER`: running `genbi` alone also rebuilds `cookbook ai`, running `paramadvisor` / `netadvisor` alone also rebuilds `ai` — the root fix for "running a parent capability alone wipes the subdirectory capabilities" (the class of incident of 2026-09 where genbi deleted cookbook ⇒ `ERR_MODULE_NOT_FOUND` in the image).
- Consumption: genbi `agent.js` `import { shapeInferenceConfig, learnUnsupportedField } from "./core-dist/ai/converse-shape.js"`;
  - `_runtime/agent-runner.js` `import { shapeInferenceConfig } from "../core-dist/ai/converse-shape.js"` (written for the **in-container layout**: `<container>/_runtime/` and `<container>/core-dist/ai/`; the source location `infra/agent/_runtime` is only distributed, never executed).
  - The artifacts are committed (the same discipline as the other core-dist bundles).
- `AGENT_SOURCE_PATHS` in `scripts/lib/agentcore-agents.sh` gains `platform/src/lib/ai/core` ⇒ `redeploy-agents.sh --check` can see profile changes.
- 🔴 Because the image content changes, upgrading to this wave **must run `scripts/redeploy-agents.sh`** (an upgrade that only runs the platform redeploy script does not refresh the three agent images and stacks; defect identified 2026-10-14); stated in the upgrade section of [the deployment guide](../deployment.md).
- Gate unit test `model-config-guard.test.ts` (h): the import in genbi `agent.js` and ≥ 2 `shapeInferenceConfig(` calls + `learnUnsupportedField(MODEL_ID, e)`; the old directly assembled form `inferenceConfig: { maxTokens: maxTokens || 1000, temperature … }` may not come back;
  - the import and the maxTokens call site in `agent-runner.js`;
  - the three `core-dist/ai/vendors.js` contain the four families and their `package.json` is commonjs;
  - the `_runtime/agent-runner.js` copies of `netadvisor` / `paramadvisor` are byte-for-byte identical to the shared source;
  - `core-prebuild.sh` registers `[ai]` and its explicit order ends with `ai`.

### 7.7 Deploy-time candidate chain (the ordered-candidate-chain decision)

> 🔴 Revision 2.2 correction: the real call for each expanded id uses **`maxTokens=16`**, not 1 — the lower bound of Kimi K3's `max_output_tokens` is 16 (verbatim from a test account on 2026-10-14: "Invalid 'max_output_tokens': integer below minimum value. Expected a value >= 16"); with 1 the candidate is treated as "unavailable" and skipped, so the candidate chain can never land on Kimi (caught by the page-driven acceptance of the deploy-time candidate chain). Claude / GLM 5 accept both 1 and 16; the cost is negligible.

`platform/ai-model.json`:
```json
{ "defaultModelId": "us.anthropic.claude-opus-4-5-20251101-v1:0",
  "candidateModelIds": ["us.anthropic.claude-opus-4-5-20251101-v1:0", "zai.glm-5.3", "moonshotai.kimi-k3"] }
```
`scripts/resolve-home-model.sh <profile> <home-region>` (the real algorithm):
```
candidate chain = ${BGP_MODEL_CANDIDATES:-candidateModelIds} (space-separated; an explicit override is only for troubleshooting / tests and prints 「候选来自 env」 to stderr)
rows = list-inference-profiles (this region, once; if denied ⇒ rows is empty and the denial reason is recorded)
for each candidate C in the chain:
  base model base =
    C is in rows (an inference-profile id of this region) ⇒ the last segment of that profile's models[0].modelArn      // ground truth
    else if C ends with "." + some base model present in rows ⇒ that base model (take the longest)                    // the candidate is a profile id of another region (a European home region receiving us.*)
    else ⇒ C itself                                                                                                    // the candidate is already a base id
  expansion = [C (if in rows)] + sorted(geographic profiles of this region → base) + sorted(global.* → base) + [base]; deduplicated
         when rows is empty (listing failed) one more variant "strip the first segment by shape" is appended at the end (only the <geo>.<vendor>.<model> shape is stripped)
  for id in expansion: real converse with maxTokens=1 ⇒ on success print id to stdout and exit 0 (when id ≠ C, stderr explains 「候选 C 以推理配置 id 调通」)
                 on failure print one stderr line 「✗ 候选 C → id —— <原话>」 (a trace is left on success as well)
if nothing in the whole chain works ⇒ exit 1, stderr summary 「找不到能用的默认大模型(候选链:…)」 + every verbatim error (+ the denial reason of listing the profiles itself)
```
- **No vendor regex**: the base model is derived from the `modelArn` ground truth, not by guessing the geographic / vendor segment (pinned by gate (g)).
- Item 7 of `01-preflight-account.sh` now calls this script: if any candidate passes ⇒ ✅ and it names "the first one that passed a real converse"; if none passes ⇒ ❌ and it lists everything (stderr verbatim, truncated to 700 characters). The wiring of `deploy-all.sh` / `redeploy-platform.sh` is unchanged (an explicit `BEDROCK_MODEL_ID` takes precedence).
- `infra/lib/shared/model.ts` gains `CANDIDATE_MODEL_IDS` (an old json without `candidateModelIds` falls back to `[defaultModelId]`, backward compatible).
- Offline stand-in `infra/test/resolve-model/test_resolve_model.sh` (fake aws, 24 cases: this region first / falling to global. / the whole chain failing leaves traces / other models and INACTIVE are not tried / listing denied falls back by shape / the chain lands on the second candidate / env override annotated / a candidate that is itself a profile id is tried first / ground-truth derivation / wiring of the three deployment scripts), run for real inside vitest by `platform/src/lib/ai/__tests__/resolve-home-model-harness.test.ts`;
  - the manifest `infra/prod-only-layers.json` records `cases: 24` for this layer.

### 7.8 Change list (implementation level, landed on 2026-10-14)

| Item | Location | Notes |
|---|---|---|
| new `lib/ai/core/vendors.ts` · `converse-shape.ts` | new | sections 7.1 / 7.2; zero `@/`, zero SDK |
| new `platform/tsconfig.ai-core.json`; `core-prebuild.sh` `[ai]` + `CAP_AFTER`; `core-dist/ai/` artifacts in the three containers; source list in `agentcore-agents.sh` | new / changed | section 7.6 |
| `capabilities.ts` · `model-catalog.ts` · `catalog/route.ts` | changed | re-export; `Family` with four values; ordering; `families[]` response |
| `probe.ts` | changed | section 7.3 |
| `app/api/admin/model-config/route.ts` · `lib/settings/admin-guard.ts` | changed | section 7.4 |
| `lib/ai/invoke.ts` · `lib/copilot/plan/planner.ts` | changed | section 7.2 platform location + Strands factor; `InvokeOutcome.shaped` |
| `components/settings/AiModelCard.tsx` · `lib/i18n/messages/en.ts` | changed | interaction design, section 7 (families grouping, two F8 lines, two family tags, four-family tour text + English keys) |
| `app/genbi/page.tsx` | changed | result card "Model used: <id> · backend <backend> (· degraded to fallback)" (`data-testid=genbi-model-used`, attributes `data-model / data-backend / data-degraded`); answer section `genbi-answer` — the ground truth for page-driven acceptance (the result-card decision of [the design document](./model-configuration.md)) |
| `infra/agent/genbi/agent.js` · `infra/agent/_runtime/agent-runner.js` (+ distributed copies `netadvisor` / `paramadvisor/_runtime/`) | changed | section 7.2 container locations |
| new `lib/ai/core/transient.ts` + `core/__tests__/transient.test.ts`;<br>`agent.js` / `agent-runner.js` Agent factory + one transient retry + structured log;<br>`tsconfig.ai-core.json` include;<br>`core-dist/ai/transient.*` in the three containers;<br>`model-config-guard.test.ts` (h) for the transient-retry decision | new / changed | section 7.2b (revision 2.2; the 1-in-3 intermittent failure caught on the first page-driven acceptance run) |
| `platform/ai-model.json` · `scripts/resolve-home-model.sh` · `scripts/01-preflight-account.sh` · `infra/lib/shared/model.ts` · `infra/test/resolve-model/test_resolve_model.sh` · `infra/prod-only-layers.json` | changed | section 7.7 |
| unit tests: new `core/__tests__/vendors.test.ts` · `converse-shape.test.ts` · `ai/__tests__/resolve-home-model-harness.test.ts`;<br>changed `invoke.test.ts` (shaping / learn + same-layer retry / learn only once / other ValidationException not retried) · `probe.test.ts` (five classes, zai / moonshotai second probe, account-level not enabled) · `model-catalog.test.ts` (four families + ordering) · `model-id-regex-geo.test.ts` · `route.test.ts` (the four cases of step ③′ + NotInCatalog detail) · `model-config-guard.test.ts` ((g) / (h)) | new / changed | fixtures use the real wording recorded in [the design document](./model-configuration.md), section 12.2; the full vitest run of the feature branch, 375 files / 4944 tests, all green (2026-10-14) |
