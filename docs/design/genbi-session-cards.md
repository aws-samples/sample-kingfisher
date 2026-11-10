# Ask-Your-Data "Session Cards" (save a whole conversation / open and continue / delete, at most 100 per user)

> Revision: **1.8** | Date: 2026-09-13 | 🔴 **Revision 1.8 = step 7 of the construction sequence closed (the headless acceptance segment passed 23/23 in a real environment; the only item still registered is GC-12) + a whole missing layer of tests added**
>
> Earlier revisions (16) are in the collapsible list below.

<details><summary>Revision history</summary>

- **Assembly layer (`cards-assembly.test.ts`)**: mocks **only true externals** (in-memory DDB / in-memory S3 / registry / model side);
  **nothing is mocked between** `cards-service` ↔ `cards-store` ↔ `cards-body-store`.
  The reason for creating it: the 4 self-inflicted defects of that day **all grew on the seams**, while `tsc` was self-consistent, 3000+ `vitest` tests were all green and **60 mutations were all red** —
- 🔴 **mutation cannot create observational power that the criteria never had**: the mutations hit units that were equally isolated by mocks, so a broken seam stayed all green.
  Accompanied by the shrink-only ratchet `mock-hygiene-guard` (number of cross-module mock pairs · any directory with cross-module mocks must have an assembly layer) + the corresponding rule of the change-safety protocol.
- 🔴🔴 **Revision 1.7 = two structural rulings forced by the first run in a real environment** (details were recorded in the planning notes of the time):
  - **① The card collection has two identities, and they must be separated explicitly.** It is both the personal-asset index of "**100 per user, globally**" (decided in section 3.2),
    and it has to be presented on a platform that filters by execution scope. Before the change the latter **silently overrode** the former ⇒ the counter said "97/100 used" while the list showed only 3 cards
    (**the number and the list contradicted each other**), cards outside the scope were **unreachable**, so the either-or dialog of section 9.7 could **not be triggered by any real user**
    except from the "All" view = dead code; and the only exit copy read "switch the top-bar scope to view" — which is exactly what guardrail 7 exists for, yet the user was asked to do it by hand.
    ⇒ Ruling: **complete index, adjustable lens**. The execution scope remains the **default lens** (the platform-wide rule is unchanged, the ratchet is not loosened),
    but the drawer can widen **its own** reading lens with one click; 🔴 widening only changes "which rows are read" and **never changes the execution scope**
    (that is the silent switch forbidden by clause 1 of section 9.7), and it must **say explicitly** "the top bar has not changed". Criteria: section 9 GC-9 (default filtering) + 🆕 **GC-9b** (reachability + scope untouched).
  - **② Contention on the single counter is absorbed by the platform, never pushed onto the user, and failures must be compensated.** The quota is a **single** item per user (for the atomicity of "exactly 100";
    this trade-off stays — a sharded counter would destroy the exact upper bound), so concurrent saves by the same person inevitably collide on it;
    DynamoDB's `TransactionConflict` is a "retryable" signal, but before the change it was pushed onto the user as a 500 "please retry later"
    (measured: 3 of 100 attempts). ⇒ The store **backs off with jitter and retries a bounded number of times** (6) internally; when exhausted it throws the typed
    `CardStoreContended` → **503**; 🔴 `ConditionalCheckFailed` is **never retried** (it is the answer; retrying would drag "full" out into a timeout).
    At the same time the compensation of section 7.1 is extended from "delete the body only when the quota is full" to **every kind of pointer-write failure** —
    otherwise every contention leaves behind an orphan body object **that no pointer refers to and that nobody ever finds**. | Status: 🚧 **code and criteria of construction steps 1–7 all landed** (step 7 = the acceptance-segment script is written and registered in the acceptance gate; **none of it
  deployed yet ⇒ not yet passed**)
- 🔴🔴 **Revision 1.6 = writing the criteria uncovered and root-fixed two real product gaps** (both of the kind "the contract says it, the code never wired it", and **neither raises an error**):
  ① **Re-masking was always a no-op ⇒ cards were a back door around data classification.** `maskRows` first computes from "column metadata / SQL" which tables are involved this time,
    then looks up the classification of those tables; the card path **passed neither** (`columns` had only column names, `sql` and `database` were not given at all) ⇒ the reference table set was empty
    ⇒ it hit `return passthrough` at the first branch ⇒ **`maskedNow` was always empty, and opening an old card always returned plaintext**.
    The platform's other three call sites (direct-query results / BI queries / Ask-Your-Data execution) always passed both; only the card path left them out.
    Root fix = "**the body carries the context needed for re-masking**": `CardBody.database` is added and stays in the region with the body; `sql` is passed per turn;
    on the write side `database` is **required** (no silent default — that is the breeding ground of a whole class of defects); on the read side the fallback to the default database applies only to old cards saved **before the fix**.
  ② **Deleting a workspace silently left other people's cards behind.** `bgp-genbi-cards` was not in the resource inventory of workspace deletion at all (not among the 11 kinds).
    Ruling: **block + list the details**, no cascading delete — a workspace is **shared**, cards are **personal**; cascading would mean that one person deleting a workspace
    silently destroys the conversations several other people saved. The blocking message must say "must be deleted by the owner", otherwise an administrator thinks the platform is broken (see section 9 GC-15).
    A fail-open in the same place was fixed along the way: the `.catch(() => [])` of `OWN_LIST_KINDS` made **any read failure of any kind count as 0** ⇒ no block ⇒
    the workspace was deleted with orphans attached. Now all 12 kinds go through `safeCount` (failure ⇒ `count: null` + masked reason ⇒ **always blocks**).
- ✅ **Revision 1.5 = the three decisions of 2026-09-12 landed**: ① **the title also stays in the region** (overruling my default of "store the title centrally") · ② 100 = **per user, globally** (as stated) · ③ scheduling order as proposed.
  Landing points of ①: the central pointer **does not store even `title`** (it has joined the data-value blacklist; writing it is rejected outright); the list title is now read from a lightweight `head.json` in **that card's own region**
    (one small object per card, written in the same write as the body ⇒ **no index-consistency problem**);
  🔴 **a title that cannot be read must degrade, not disappear** — the row is still listed (cardId / region / time / turn count are all central),
    and the title slot shows a placeholder. Removing unreadable cards from the list = the user thinks the cards are lost, which is far worse than not seeing a title.
- Revision 1.4: section 5.6 corrected — only **three** error codes are added, the other three **reuse the platform's existing vocabulary** (`code` from the existing union + `detail.reason` as single-author literals); and one Next constraint recorded: the error mapping **cannot** be exported from a
  route file (routes may only export fixed names); it was extracted into `lib/genbi/cards-http.ts`.
- Revision 1.3: section 3.3 adds two construction-time rulings (both forced by mutation tests): **the idempotency criterion is prefix matching** (judging "exactly equal" would wipe the turns the user added by continuing) · **cleanup must have an upper bound and fail loudly** (without the bound the
  failure mode is "the request hangs" rather than an error).
- Revision 1.2 **two corrections, both things I wrote from memory in revision 1.0 that the real infrastructure falsified**:
  ① Writing the encryption as "SSE-KMS (that region's dataKey)" was **wrong** — the datalakeBucket uses the bucket default **SSE-S3** (`BucketEncryption.S3_MANAGED`; home `platform-stack.ts:53`, non-home `exec-env/core-stack.ts:64`). The only KMS bucket on the platform is the residency bucket
  (`residency-stack.ts:74`). Putting cards under a CMK needs **one key per region + grants**, a separate hardening item that is **not done in this work** (see section 12, item ①).
  ② The lifecycle cannot be covered in one sentence: the **non-home** datalakeBucket is `RETAIN` without autoDeleteObjects (execution-environment discipline), whereas 🔴 **home's is `DESTROY + autoDeleteObjects: true`** (`platform-stack.ts:57`) ⇒ destroying the platform stack deletes the home card
  bodies with it (see section 12, item ②).
- Revision 1.1: section 5 tightened from an "interface list" into a **buildable contract** (field-by-field request/response + error-code table + idempotency and concurrency semantics);
  🔴 the interaction "open a card from another scope" is **not defined in this document** — it was extracted into the general protocol of the [multi-region interaction design](./multi-region-execution-interaction.md), **revision 2.30, section 9.7 "the page proposes an execution-scope switch"
  (guardrail 7)**; this work is merely its first consumer (the same family includes opening a run in another region from an alerting / monitoring deep link, shared BI cards, and drilling down from the cross-region overview).
  ⚠️ When section 9.7 was first drafted it used `residency-blocked` as if it were an existing state, and the `contract-drift` negative list caught it on the spot (that state had already been removed by the residency-gate work) ⇒ changed to point at the registry's single author `unusableReason()`,
  and "pages may not write their own serviceability check" was written into the contract.
- Revision 1.0: first version (design pending review)
  Four-in-one (following the precedent of the [operation guide](./operation-guide.md)): **section 2 summary design · section 3 data model and contract · section 4 interfaces · section 5 prototype · section 6 execution flow · section 7 construction sequence · section 8 headless acceptance criteria**.
  Planning: tracked as its own work item with a dedicated work package.
  Related existing modules: **[Ask-Your-Data](./genbi.md)** (the question-answering core) · **[GenBI requirement pipeline](./genbi-requirement-pipeline.md)** ("Raise as request"; this requirement is its **peer**) · **[AgentCore GenBI](./agentcore-genbi.md)** (conversation memory) · **[GenBI
  asynchronous execution](./genbi-async-execution.md)** (asynchronous tasks) · **[multi-region execution](./multi-region-execution.md)** (execution scope + data residency; the source of this work's hard constraints).

</details>

---

## 1. Requirement (as stated on 2026-09-12, verbatim)

> On top of the existing Ask-Your-Data feature, add a feature with the following effect:
> 1. If a customer wants to keep an existing card, they can click save, and then find the whole process of their original conversation in their personal card collection in Ask-Your-Data — I mean all of the content, questions as well as results, kept exactly as they were; if they open it again, they can continue the conversation from where it left off. This feature is a requirement at the same level as "Raise as request". Understand this first.
> 2. There is one limit here: each person can keep at most 100 session cards.
> 3. Support the action of deleting a card.
>
> As usual, do the design first, then the scheduling, and record it in the schedule plan. Remember, this is a global production system; it needs a high degree of design, good design. Don't mess around.

**Reading (my understanding, please verify)**:
1. The action entry is a **peer** of "Raise as request" (same action area of the assistant's answer card), but the **semantics differ**: Raise as request = take **one turn** of Q&A to open a request ticket; Save card = put the **whole conversation** into "My cards".
2. "All content, exactly as it was" = not just the question and conclusion text, but **the complete artefacts of every turn**: question / conclusion / SQL / columns / **all data rows** / chart spec / matched tables / reference definitions / masked columns / reasoning steps / token usage.
3. "Open it again and continue the conversation" = after opening, **the context is really there**; a follow-up "and by category?" builds on what came before — not "display the old Q&A, then ask from scratch".
4. Upper bound **100 cards / user**; deletion supported.

---

## 2. Survey of the current state (code-level facts; falsify first, then design)

| # | Fact | Source | Impact on the design |
|---|---|---|---|
| 1 | A conversation **lives only in browser memory**; a refresh loses everything; today there is **no** capability whatsoever to "open an old conversation" | `platform/src/app/genbi/page.tsx:200` `const [turns, setTurns] = useState<Turn[]>([])` | The "card collection" is a **brand-new entity**, not a button added to an existing list |
| 2 | Three persistence points exist, **none of them can restore a conversation** | See the three rows below | ⇒ A new snapshot entity must be built; **the three existing ones cannot be stitched together** |
| 2a | `bgp-genbi-history`: one row per question, stores only `question/answer/sql/rowCount/chartType`, **no** columns / rows / chart spec / matched tables / definitions / masked columns / reasoning steps, and **no conversation dimension** (no conversationId stored) | `src/lib/genbi/history.ts:38-62` | Restoring from it = text only, all data lost |
| 2b | `bgp-genbi-turns`: has conversationId but stores only `question/answer/sql`, **TTL 24h**, and only the last 6 turns are injected into the model | `src/lib/genbi/memory.ts:23-25,53` | "Open it three weeks later and still continue" is **impossible** under today's mechanism |
| 2c | AgentCore Memory is managed session events + semantic memory, **not exportable as a snapshot** | `memory.ts:31` `isAgentCoreMemory()` | Continuing can only rely on **re-hydration**, not on "restoring the original session" |
| 3 | "Raise as request" is a **single-turn** snapshot and only cuts `sampleRows(0,10)` | `page.tsx:74` (button) → `openRequirement` → `POST /api/requirements` (`page.tsx:271`) | Peer but different meaning: this requirement needs **the whole conversation, in full, with a way back into the conversation** |
| 4 | Result size has a hard cap: **≤ 200 rows** per turn (`GENBI_MAX_ROWS`), and the SQL is forcibly wrapped in a `LIMIT` | `src/lib/genbi/config.ts:29`, `src/lib/genbi/core/sql-guard.ts:54` | A single turn is estimable; but **several turns added up exceed the 400KB DynamoDB item limit** ⇒ the body must go to object storage |
| 5 | Ask-Your-Data **already splits by execution scope**: `askTargetId` goes into the body, the history list filters by `?scope=` | `page.tsx:192,213,321` | Cards must inherit the same rule, otherwise the read-level ratchet `UNSCOPED_READ_LIMIT` immediately goes +1 (current value **1**, shrink-only) |
| 6 | The platform already has **region-side storage** with its three disciplines (table names only from the descriptor's resource bag / only Put·Get·Query, never Update·Delete / no business decisions) | `src/lib/exec-env/residency-store.ts:1-16` | Reuse this discipline directly; do not invent another |
| 7 | `datalakeBucket` is a product of the **core component** and the probe really checks it ⇒ **every target has a bucket in its own region** | `src/lib/exec-env/component-contract.ts:17`, `registry.ts:2310`, `probe-runner.ts:90` | Putting the body into "that region's bucket + a dedicated prefix" is feasible; **no new component and no new naming kind needed** |
| 8 | ⚠️ **Pre-existing gap (not fixed in this work, but registered)**: `recordGenBiHistory` unconditionally writes `question/answer/sql` into the **home-region** table, and the whole `persistGenBiSideEffects` chain has **no** `residencyAudit` (`grep -rn "residency" src/lib/genbi/*.ts` finds nothing) | `history.ts:38`, `execute.ts:248-261` | The **answer text of cross-jurisdiction questions already leaves the region today**. Belongs to the "Ask-Your-Data / BI across jurisdictions" work item; this work **does not repeat that mistake** |

---

## 3. Three questions that must be settled first (they determine the whole shape)

### 3.1 Question A — where does the "exactly as it was" body live?

🔴 **Ruling: the body always lands in the regional S3 of "the target the data came from"; the center stores only a pointer with no data values.**

- **Why not one central table**: a card contains **real business data rows** (≤200 rows/turn × N turns). Writing them into the home region = moving eu data into us — exactly what the data-residency track of the multi-region execution design exists to prevent. Nobody has hit it so far only because **no feature has ever persisted result rows until now**; this feature is **the first**. If this is not settled at design time, go-live day is a residency incident.
- **Why not "store only the SQL and re-run on open"**: ① the requirement is "exactly as it was"; ② re-running costs money; ③ when the data changes the conclusion changes — then it is a live query, not a card; ④ if permissions / the warehouse change, it simply fails to open. **The snapshot is right**; the price is to label it in the UI as "a snapshot taken at <time>" and to offer a "re-run this turn with current data" button (added value, and it does not change the snapshot semantics).
- 🔴 **The title also stays in the region (decided, revision 1.5)**: my default in revision 1.0 was "store the title centrally" (reason: it is metadata the user typed in; the list renders from a single query).
  That was overruled ⇒ the center holds **not a single data-value field**, the title included. The cost and the handling already done are in the revision header and section 4.
- **Shape (one definition, no same-jurisdiction / cross-jurisdiction fork)**:
  - Body: `s3://<that target's datalakeBucket>/genbi-cards/<userSub>/<cardId>/body.json`, encryption = **bucket default SSE-S3** (revision 1.2 correction: the original "SSE-KMS" was wrong, see the revision header).
    Home cards land in the home bucket — the rule is **not a special case** for home; "that region" just happens to be the home region.
  - Center: `bgp-genbi-cards` (home region) stores **pointer + quota**, with fields that are **non-data values only**.
- Cross-jurisdiction reads and writes go through the **existing** gates: `residencyAudit` + prior consent; **if the write fails ⇒ refuse to save**.
  🔴 This is deliberately the **opposite** of `recordGenBiHistory`'s best-effort rule: history is a side channel, a card is a **user's deliberate asset**, and silent failure is unacceptable.

### 3.2 Question B — how do we guarantee the limit of 100 is real?

🔴 **Ruling: an atomic `TransactWriteItems` write in the same central table.**

```
TransactWriteItems([
  Put   { pk: <userSub>, sk: "card#<cardId>", ... },
  Update{ pk: <userSub>, sk: "quota#", UpdateExpression: "ADD n :one",
          ConditionExpression: "attribute_not_exists(n) OR n < :limit" }   // :limit = 100
])
```

- **Why not "Count first, then Put"**: two concurrent saves both read 99 ⇒ 101 cards get written. This is the most common class of hole in this repository; the unit tests must include a concurrency target.
- **Why the counter must be central**: the limit means "**per user** at most 100" = **global** across workspaces and regions. If pointers were stored per region, the global count would need a cross-region transaction (which does not exist) ⇒ **pointers must be central**. This is also the second reason for section 3.1's "body in the region, pointer in the center" — two constraints point at the same shape; it is not patchwork.
- **Full-quota semantics**: `409 GENBI_CARD_QUOTA_EXCEEDED`, copy "100/100 saved, please delete cards you no longer need first" + a one-click jump to the card collection (sorted by earliest created).
  🔴 **Never silently evict the oldest** — something the user deliberately saved being quietly deleted by the system violates guardrail 1 of the [multi-region interaction design](./multi-region-execution-interaction.md), section 9, "nothing gets lost".
- **Idempotency (saving the same conversation repeatedly = update the same card; no second quota slot consumed)**: the idempotency key `(userSub, conversationId)` goes through a GSI; on a hit the `Put` becomes an `Update` (body overwritten, `updatedAt` advances), and the counter **does not move**.
  🔴 Consequence of skipping this: clicking save three times on one conversation eats 3 slots, and 100 cards fill up in two days — while the user believes the platform is counting wrong.

### 3.3 Question C — what makes "continue the conversation" really continue?

🔴 **Ruling: keep the original `conversationId` + rebuild short-term memory on open by an "overwriting replay" of the card body.**

- **Why not just put `conversationId` back**: short-term memory has a **24h** TTL (section 2, fact 2b). Open that card three weeks later: the id is still there, the context is long gone ⇒ the follow-up "and by category?" gets an answer that **looks normal but is detached from the context**. That is precisely what this repository fears most: "wrong in a way that looks right".
- **Overwriting, not appending**: the memory may still hold stale events / warm-container state, and **the card body is authoritative**. One new single exit `replaceConversation(conversationId, turns[])` (implemented by each of the two backends in `memory.ts`): first clear the short-term entries of the same `conversationId`, then replay in order. **Idempotent** — opening the same card twice does not double the context.
- 🔴 **Known trap** (a recorded lesson on AgentCore verification): `runtimeSessionId()` is derived from `conversationId` (`memory.ts:41`), and **AgentCore reuses warm containers by sessionId**. Reuse here is what we **want** (continue), but **acceptance must build a control group with a brand-new conversationId**, otherwise it cannot tell whether the replay took effect at all.
- 🔴 **The idempotency criterion is "the card's turns are a **prefix** of the existing conversation", not "exactly equal"** (added in revision 1.3; forced by mutation testing during construction):
  the user opens a card (4 turns replayed) → asks 2 more (6 turns now) → resume is triggered again. Judging "exactly equal" ⇒ 4≠6 ⇒ clear and replay
  ⇒ **the 2 turns they just asked are wiped**, violating guardrail 1 "nothing gets lost"; and the symptom is "gets dumber the more you use it", almost impossible to attribute to this spot.
  ⇒ A prefix match counts as "already replayed (and possibly extended by continuing)" and is skipped outright.
- 🔴 **Cleanup must have an upper bound and fail loudly** (added in revision 1.3): cleanup on the AgentCore side = "list one page → delete all of it → list again" until 0 entries are listed
  (**not paging with `nextToken` while deleting** — the cursor is computed from the undeleted content and would skip entries). If `DeleteEvent` is rejected without throwing,
  the loop **never ends**: the failure mode is "the open-card request hangs" rather than an error — the logs show nothing at all.
  ⇒ Hard bound of 50 rounds; throw beyond it. (Mutation check: with the bound removed that test **hangs** instead of failing, so mutation targets must run the test suite under a `timeout`.)
- 🔴 **The execution scope must follow the card**: a card is bound to **one** target. On open, if the current view is not that target ⇒ **switch to that target automatically and restate it** (multi-region interaction design, section 9, guardrail 2 "the button restates" + guardrail 3 "the instance is referenced back"); if the user declines the switch ⇒ **read-only view**, with the question box disabled and the reason stated.
  Without this, "continue the conversation" asks in the **wrong region** — worse than not being able to continue.
  🔴 **This interaction is not defined in this document**: it has been extracted into the general protocol of the [multi-region interaction design](./multi-region-execution-interaction.md), **revision 2.30, section 9.7 "the page proposes an execution-scope switch" (guardrail 7, seven contract clauses)**; this work is its first consumer. Clause 7 pins down "**being visible ≠ being serviceable**": read-only viewing only requires **visibility**, whereas "switch region and continue" requires **serviceability** (the only judge is the registry's single author `unusableReason()`; pages may not write their own).

---

## 4. Data model (contract level)

### 4.1 Central table `bgp-genbi-cards` (new in the home region; `TABLES.GENBI_CARDS`)

```
pk = userSub                 Cognito sub (not the user name — a rename must not lose cards)
sk = "card#<cardId>"         cardId = ulid()
   | "quota#"                one counter row per user { n }
GSI byConversation (userSub, conversationId)   idempotency key: one card per conversation
```

`card#` row fields (**all non-data values**):
`cardId · conversationId · targetId · region · projectId · engine · turnCount · bytes · createdAt · updatedAt · bodyRef{bucket,key} · bodySha256 · state("ready"|"deleting")`

🔴 **No `title`** (decided in revision 1.5). Together with `rows`/`sql`/`answer` it is on the **data-value blacklist**; writing it is rejected on the spot by `assertNoDataValues` — the most natural degradation, "just store the title in the pointer for convenient list display", cannot even be written through the write channel.

### 4.1a Region-side lightweight head object `head.json` (added in revision 1.5, carrying "the title also stays in the region")

`s3://<that target's datalakeBucket>/genbi-cards/<userSub>/<cardId>/head.json`
= `{ v, cardId, title, turnCount, savedAt }`, **written in the same write as the body**.

| Why this way | Rejected alternative |
|---|---|
| One small object per card ⇒ **no consistency problem**; the list issues N small GETs concurrently (N ≤ 100, concurrency cap 20) | **One `index.json` per user**: needs read-modify-write optimistic locking + retries, and all it saves is a few tens of milliseconds |
| Unreadable ⇒ **degrade** (placeholder in the title slot); the card stays in the list | **Reading the whole `body.json` per card** for the title: a body can be several MB, the list would pull hundreds of MB at once |

🔴 The title is **named by the user in the save dialog** (prefilled with the first 40 characters of the first question, editable); validation (1..80 characters) is on the **region side**
(`cards-body-store.assertTitle` — it exists only there, and validation belongs only there).
The dialog copy flips with the decision: revision 1.0 said "the title will be saved in the home region"; it must now say **"the title and the conversation body are saved only in `<region>`"**.

### 4.2 Regional body `body.json` (versioned schema)

```json
{ "v": 1, "cardId": "…", "conversationId": "…", "targetId": "…", "projectId": "…",
  "engine": "redshift|athena", "database": "dev", "title": "…", "savedAt": "…", "savedBy": { "sub": "…", "name": "…" },
  "turns": [ { "i": 0, "question": "…", "askedAt": "…", "elapsedMs": 1234,
               "result": { "answer": "…", "sql": "…", "columns": [], "rows": [[]], "rowCount": 0,
                           "chart": {}, "steps": [], "usage": {}, "maskedColumns": [],
                           "matchedTables": [], "usedContext": [], "retrievalNote": "…", "_meta": {} },
               "error": null } ] }
```

**Store everything**: `rows` are not truncated, and `steps` (the reasoning trace) are kept too (the requirement said "all content").

**Anti-abuse caps**: `turns ≤ 200` and `bytes ≤ 20MB`; beyond that, **refuse explicitly and say which limit was exceeded** (no silent truncation — silent truncation equals lying that the save succeeded).

🔴 **Why `database` must be stored in the body (added in revision 1.6; the root fix of a real gap)**: opening a card must re-mask by the **current** data classification,
and classification is stored by the FQN `<engine>.<database>.<schema>.<table>` ⇒ without the database name the FQN cannot be assembled ⇒ the "tables involved this time" that `maskRows`
computes is an empty set ⇒ it **passes plaintext straight through**. The contract said "cards are not a back door around data classification",
while the code on this path passed neither `sql` nor `database` ⇒ that sentence had **never held**, and **no error was ever raised**.
⇒ On the write side `database` is **required** (400 when missing; no silent default); on the read side the fallback to the platform default database
applies **only to old cards saved before this fix** — that is compatibility, not a default. Criterion GC-11 pins it down with a non-administrator identity + a probe table.

### 4.3 What is explicitly **not** stored (honest disclosure)

- AgentCore Memory's internal vectors / semantic memory records: **not exportable**. ⇒ Continuing relies on the replay of section 3.3, not on "restoring the original session"; in the UI, opening a card shows "the context of this conversation has been restored".
- The model's raw prompt / full trace: not in the card (privacy + size); the observability surface has its own channel.

---

## 5. Interface contract (5 routes, `/api/genbi/cards`; field level; construction follows this section)

**Common**: all go through the platform's `apiOk` / `apiError` wrappers; identity = `getUserId(req)` (Cognito `sub`, **not** the user name);
workspace = `getActiveProjectId(req)`. 🔴 **Unauthorized access always returns 404, never 403** — a 403 would leak "this cardId exists".

### 5.1 `POST /api/genbi/cards` — save / update a conversation

```jsonc
// Request
{ "conversationId": "conv-1757…-ab12cd",   // required; idempotency key
  "title": "East China customer distribution and category breakdown",        // required, 1..80 characters; named by the user (section 4.1)
  "targetId": "tgt_use1_a",                 // required; the target this conversation queried (not "the current view")
  "engine": "redshift" | "athena",          // required
  "database": "dev",                        // 🔴 **required** (revision 1.6); the database used when this conversation ran
  "turns": [ { "question": "…", "askedAt": "…", "elapsedMs": 1234,
               "result": { /* complete GenBiResult, see section 4.2 */ }, "error": null } ] }
// Response 200
{ "success": true, "data": { "cardId": "01M2…", "created": true, "used": 13, "limit": 100 } }
```

| Case | HTTP | `error.code` | Copy requirements |
|---|---|---|---|
| Already 100 cards | **409** | `GENBI_CARD_QUOTA_EXCEEDED` | "100/100 saved; the per-user limit is reached. The platform **will not delete** your saved cards automatically — please delete the ones you no longer need first." + a guiding entry |
| The same `conversationId` was already saved | **200** | — | `created:false`; body overwritten, `updatedAt` advances, **quota unchanged** (section 3.2, idempotency) |
| `turns > 200` or body > 20MB | **400** | `GENBI_CARD_TOO_LARGE` | Must state **whether it is turns or bytes** and by how much (no silent truncation) |
| `targetId` not in the registry / not visible | **404** | `TARGET_NOT_FOUND` | Consistent with the platform's existing rule |
| Cross-jurisdiction and the residency-gate write fails | **502** | `RESIDENCY_AUDIT_UNAVAILABLE` | 🔴 **Refuse to save**, no best-effort (section 3.1) |
| The descriptor lacks `datalakeBucket` | **500** | `CARD_STORE_UNAVAILABLE`, of the same family as `SCHEDULER_ARTIFACT_MISSING` | "This execution environment's regional storage is unavailable" — **never fall back to the home region** |

**Server-side order** (section 7.1): validate → resolve the place (bucket name only from the descriptor's resource bag) → cross-jurisdiction residency gate → PutObject the body →
idempotency lookup on the GSI → `TransactWriteItems` (Put the pointer + the counter with condition `n < 100`) → on condition failure **delete the body just written**, then return 409.

### 5.2 `GET /api/genbi/cards?scope=<scopeParam>` — my card list

🔴 Titles are fetched from **their respective regions** (decided in revision 1.5), and **only for the cards that are to be shown in the current scope** — execution-scope filtering naturally reduces cross-region reads to the minimum.

**Unreadable ⇒ `title:null` + `titleUnavailable:true`, and the row is still returned** (never let "cannot read the title" become "the list is empty").

🔴 **Must filter by `?scope=`** (read-route rule, the [multi-region specification](./multi-region-execution-spec.md), section 2.6.3); no `scope` = all scopes.

```jsonc
{ "success": true, "data": {
    "items": [ { "cardId": "01M2…", "title": "…" /* or null */, "titleUnavailable": false,
                 "targetId": "tgt_use1_a", "region": "us-east-1",
                 "projectId": "proj-default", "engine": "redshift", "turnCount": 4, "bytes": 51234,
                 "createdAt": "…", "updatedAt": "…", "state": "ready" } ],
    "used": 13, "limit": 100,
    "hiddenByScope": 3,          // 🔴 how many more cards exist outside the current scope (guardrail 1: what is left out must be said; no silent under-listing)
    "titleUnavailableCount": 0 } }  // 🔴 how many titles cannot be read right now (revision 1.5: titles live in their own regions) ⇒ the page says so honestly
```

### 5.3 `GET /api/genbi/cards/[cardId]` — fetch the body (open)

Response = the full `body.json` of section 4.2 + `{ "resnapshotted": false }`.

🔴 Two post-processing steps, both mandatory: ① `userSub` mismatch ⇒ **404**; ② after retrieval, **re-mask by the current data classification**, taking the **stricter** of stored and current,
and include `maskedNow: ["col"]` in the response so the page can explain "this column is now hidden by classification".

### 5.4 `DELETE /api/genbi/cards/[cardId]` — delete a card (two-phase; the quota slot is released immediately)

`200 { "deleted": true, "used": 12, "limit": 100, "bodyCleaned": true }`.
`bodyCleaned:false` = the pointer is deleted but **the regional body cleanup is not finished** ⇒ a "Cleanup incomplete · Retry" entry appears in the list (residue stays visible — the rule established by the execution-environment decommission work).

### 5.5 `POST /api/genbi/cards/[cardId]/resume` — open and continue

```jsonc
{ "success": true, "data": { "conversationId": "conv-1757…-ab12cd", "targetId": "tgt_use1_a",
                             "region": "us-east-1", "rehydratedTurns": 4 } }
```
Server side = `replaceConversation(conversationId, turns)` (**overwriting, idempotent**, section 3.3).

🔴 **This route does not change the execution scope** — switching region is done by the page itself after obtaining the user's consent under the protocol of the multi-region interaction design, **section 9.7**;
the server only answers "which target this card belongs to". When the user chooses "View read-only" this route **is not called at all** (section 9.7, clause 6: declining the switch has zero side effects).

### 5.6 Error codes (revision 1.4 correction: only three added, the rest **reuse the existing vocabulary**)

**Added** (already in the `ApiErrorCode` union of `src/lib/api-response.ts`):
`GENBI_CARD_QUOTA_EXCEEDED` (409; a full quota is a **state conflict**, not a request error) · `GENBI_CARD_TOO_LARGE` (400) · `CARD_STORE_UNAVAILABLE` (502).

🔴 Three that are **not** newly minted (the revision 1.3 draft had a `RESIDENCY_AUDIT_UNAVAILABLE`; withdrawn after the survey):
the platform has long had a single-author vocabulary for these three — `error.code` uses what is **already** in the union, and "which one exactly" goes into `error.detail.reason`
(literals exported by `lib/exec-env/residency.ts`: `residency-ack-required` / `audit-unavailable`).

| Case | status | code | detail.reason |
|---|---|---|---|
| The target exists but is not serviceable | 409 | `CONFLICT` | `target-not-ready` |
| Cross-jurisdiction, disclaimer not acknowledged | 409 | `CONFLICT` | `residency-ack-required` |
| The regional audit write fails ⇒ **refuse to save** | 503 | `UPSTREAM_ERROR` | `audit-unavailable` |

Rationale: `error.code` may have only **one** vocabulary (api-response.ts says so); a second set would make the frontend and the acceptance scripts each maintain two mappings.
The single exit of the mapping = `cardsError()` in `src/lib/genbi/cards-http.ts` (🔴 it **cannot** live in a route file —
Next App Router routes may only export fixed names; exporting an extra helper is rejected by the route type check).

## 6. Prototype

### 6.1 The assistant's answer card (peer of "Raise as request"; the `extra` at `page.tsx:70-78`)

```
┌─ 🤖 Assistant ───────────────────────── [💾 Save conversation] [📄 Raise as request]  tokens in 812/out 260 ─┐
│ Conclusion: 1,204 customers in East China, a 38% share.                                                       │
│ Matched tables: [public.customers Finalized] semantic retrieval hit                                            │
│ …chart / table / SQL / reasoning…                                                                              │
└───────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 6.2 Top entry + save dialog

```
🤖 Ask-Your-Data GenBI                      [🗂 My cards 12/100]  [＋ New chat]

┌─ Save conversation as card ─────────────────────────────────────────────────┐
│ Title  [East China customer distribution and category breakdown____] 40/80  │
│ Will save: all 4 turns of this conversation (questions / conclusions / SQL / │
│            data / charts / matched tables / definitions / masked columns /  │
│            reasoning)                                                       │
│ Ownership: 🌍 us-east-1 (tgt_use1_a) · workspace proj-default               │
│ ⓘ The conversation body and the **title** are saved only in us-east-1 and   │
│   never leave that region.                                                  │
│ 12/100 used                                               [Cancel] [Save]   │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 6.3 The "My cards" drawer (**no new menu leaf**; see section 9, anti-pattern ⑤)

```
┌─ 🗂 My cards   12/100 used   [Current scope: us-east-1 ▾]  ──────────────────────────────────┐
│ 🔎 [Search titles]                                                        Sort [Latest ▾]     │
│ ──────────────────────────────────────────────────────────────────────────────────────────── │
│ East China customer distribution and category breakdown   4 turns · 09-12 10:31 · 🌍us-east-1 │
│    [Open and continue]  [Delete]                                                              │
│ Order amount YoY and Top 10 products                      7 turns · 09-11 16:02 · 🌍us-east-1 │
│    [Open and continue]  [Delete]                                                              │
│ (title is in us-east-1 and cannot be read right now)      3 turns · 09-10 09:14 · 🌍us-east-1 │
│    [Retry]  [Open and continue]  [Delete]      ← 🔴 degrade, do not disappear (revision 1.5) │
│ ──────────────────────────────────────────────────────────────────────────────────────────── │
│ ⓘ 12 cards in the current execution scope; 3 more in other scopes (switch the top-bar scope   │
│   to view them)                                                                               │
└───────────────────────────────────────────────────────────────────────────────────────────────┘

When the quota is full (the 101st save):
┌─ Save failed ───────────────────────────────────────────────────────────────┐
│ ⚠️ 100/100 cards saved; the per-user limit is reached.                       │
│ The platform will not delete your saved cards automatically — please delete │
│ the ones you no longer need first.                                          │
│                                        [Open My cards (sorted by earliest)] │
└─────────────────────────────────────────────────────────────────────────────┘

Opening a card that is not in the current view:
┌─ This card belongs to us-east-1 (tgt_use1_a) ───────────────────────────────┐
│ Continuing the conversation will run on **that region's** data warehouse.   │
│ The top-bar execution scope will be switched to us-east-1.                  │
│                     [View read-only]  [Switch to us-east-1 and continue]    │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 7. Execution flow

### 7.1 Save (POST)

```
Frontend turns[] (the complete GenBiResult held in memory)
  │  ① Validate: turns ≤ 200 and bytes ≤ 20MB; otherwise 400 stating which limit was exceeded
  ├─ ② Resolve the place: targetId ← the target of this conversation (not "the current view" — the view may already have been switched away)
  │     bucket name ← the descriptor's resource bag datalakeBucket (missing ⇒ throw; never guess a name)
  ├─ ③ Cross-jurisdiction? → residencyAudit(entry="genbi-card-save", sqlText=each turn's SQL, title)
  │     write fails ⇒ refuse outright (no best-effort)
  ├─ ④ PutObject the regional body (SSE-KMS) + compute sha256
  ├─ ⑤ Idempotency lookup on GSI byConversation
  │     ├─ hit ⇒ Update the pointer (bytes/turnCount/updatedAt/bodySha256); quota **unchanged**
  │     └─ miss ⇒ TransactWriteItems (Put the pointer + Update quota, condition n < 100)
  │            condition fails ⇒ 409 + delete the regional body just written (compensation); no orphan left behind
  └─ ⑥ 200 { cardId, used, limit }
```

🔴 The order is **body first, pointer second**: the reverse (pointer first, body second) produces "it is in the list but fails to open"; whereas a failure after body-first merely leaves one more orphan object, which is caught by the compensation in ⑤ and the cleanup of section 7.3. **A visible orphan beats a lying pointer** — the same rule as "residue stays visible" from the execution-environment decommission work.

### 7.2 Open and continue (GET body + POST resume)

```
Click "Open and continue"
  ├─ ① GET /cards/[cardId] → userSub check (not mine ⇒ 404; existence is not leaked)
  ├─ ② cross-jurisdiction ⇒ fetch the body through the residency gate
  ├─ ③ re-mask by the **current** data classification (the stricter of stored and current)
  ├─ ④ targetId ≠ the current view ⇒ dialog "switch region and continue / view read-only" (section 6.3)
  ├─ ⑤ "continue" chosen ⇒ POST /cards/[cardId]/resume
  │        replaceConversation(conversationId, turns)  ← overwriting, idempotent
  └─ ⑥ the frontend renders turns as the conversation thread + sets conversationId back to the original ⇒ follow-ups build on the context
```

### 7.3 Delete (two-phase; the quota slot is released **immediately**)

```
① Set the central pointer to state="deleting" + quota.n -= 1 inside the TransactWrite   ← from the user's point of view the slot frees up immediately
② Delete the regional S3 body object
③ Delete the central pointer
Failure at ② ⇒ the card disappears from the list and leaves a "Cleanup incomplete · Retry" entry (residue stays visible; the execution-environment decommission rule)
```

🔴 No soft delete / recycle bin: the requirement said "delete"; a soft delete would make "100/100 used" and "only 60 cards in the list" contradict each other.

---

## 8. Construction sequence (7 steps; each can pass the gate on its own)

| Step | Content | Deliverable | Effort |
|---|---|---|---|
| 1 | **Contract**: finalize this document + add a section to the multi-region interaction design (the four interactions: save / collection / full quota / region switch) + a new acceptance segment + the feature-map entries + the schedule entries | Documents | 2–3h |
| 2 | **Central storage + quota single author** `src/lib/genbi/cards-store.ts` (the only writer; TransactWrite; idempotency GSI) + infra CDK table creation + TaskRole authorization + 🔴 `infra/iam/platform-taskrole-calls.json` **in the same commit** (a recorded lesson: the coverage of a manifest-driven gate is the criterion itself) + unit tests (concurrent collision on the limit / repeated saves do not consume quota) | Code + unit tests | 5–8h |
| 3 | **Regional body store** (reusing the three disciplines of `residency-store.ts`; bucket name only from the resource bag's `datalakeBucket`, throw if missing) + compensating delete | Code + unit tests | 3–5h |
| 4 | **Memory replay** `replaceConversation` (both the selfmanaged and the agentcore backend) + idempotency + unit tests | Code + unit tests | 3–5h |
| 5 | **Five routes** (residency gate / classification re-masking / `?scope=` filtering / 409 on full quota / 404 on unauthorized access) | Code + unit tests | 4–6h |
| 6 | **Frontend**: save button (peer of "Raise as request") + naming dialog + the "My cards n/100" drawer + open and continue + automatic region switch with restatement + delete confirmation + full-quota guidance + empty state | Pages | 6–10h |
| 7 | **Headless acceptance segment** (criteria GC-1..GC-16 of section 9) + a run in a real environment + mutation targets (at least one mutation per criterion that turns red) | The headless acceptance script (kept outside the repository) | 5–8h |

**Progress (2026-09-13)**: steps 1–6 code all landed · step 7 **script written (921 lines, 43 assertions) and registered as a segment of the full multi-region acceptance run**;
**3054 unit tests all green**, `tsc` 0, `contract-drift` 62/62, two mutation batches **7/7 all red** each.

🔴 **But it has not entered a real environment even once ⇒ by the rule "registering is not passing", this work is not yet closed**; the only blocker = the temporary test account's credentials expired (the profile needs to be refreshed).

⚠️ Correcting one outdated conclusion of my own: **this acceptance segment does not need a core-only execution environment** (that was a carrier requirement of the data-quality acceptance items) —
the carriers it needs are "two targets + a second user + a stale descriptor", **all of which it can create itself**, independent of VPC slots.

**Total 28–45h** (≈ 4–7 effective working days). **Prerequisites**: none (it does not depend on the other scheduled work packages); file surface = `src/lib/genbi/**` + `src/app/genbi/**` + one new table ⇒ **no overlap with the parallel series of work packages; can run in parallel**.

---

## 9. Headless acceptance criteria (one dedicated segment; 🔴 page-level evidence, CLI/API only as debugging truth)

| Id | Criterion | Why it is written this way (where the discriminating power comes from) |
|---|---|---|
| **GC-1** | Save → **refresh the page** → open from the card collection, and **deep-compare field by field** with the `turns` from before saving: turn count / each turn's question / answer / sql / columns / **all rows** / chart spec / matched tables / reference definitions / masked columns / reasoning steps | 🔴 Not "opened without an error". Mind the recorded lesson on byte-exact comparison traps: `rows` is a **sequence**, compared in order; `matchedTables` / `usedContext` are **sets**, compared as sets; **a different key order after the DDB round trip is not a difference** |
| **GC-2** | **Continuing really continues**: open an old card → ask a follow-up that **can only be answered from the earlier context** (first question "count customers by region" → follow-up "and by category?") ⇒ the new SQL carries the tables and definitions of the earlier turn; **control group** = a brand-new `conversationId` asking the same sentence ⇒ cannot answer / asks back | Without a control group it is an **empty assertion** (live data may make "continued" and "not continued" produce the same result) |
| **GC-3** | **The limit is real**: create 100 cards → the 101st POST returns **409** and the copy contains "100"; at 99 cards, **5 concurrent POSTs succeed exactly once**, final `quota#.n == 100` (not 104) | The concurrent half is the key; testing only the serial 101st does not detect the "Count first, then Put" hole |
| **GC-4** | **Repeated saves do not consume quota**: the same `conversationId` clicked 3 times ⇒ card count +1, `updatedAt` advances, `n` only +1 | |
| **GC-5** | **Delete releases the quota with zero residue**: delete 1 card ⇒ the list shrinks by 1, `n` −1, `head-object` on the regional S3 object returns **404**, the central pointer is gone | A "zero residue" criterion can only mean **really checking the object** (a recorded lesson: RETAIN orphans and dry-run false greens) |
| **GC-6** | **The body really is in that region, and not in the home region**: a non-home card ⇒ the target's bucket has the object, **the home bucket has no** object with the same key | 🔴 The negative half is mandatory — asserting only "the region has it" is equally true for an implementation that "writes to both" |
| **GC-7** | **The central pointer contains no data values**: scan all `card#` rows of `bgp-genbi-cards`, assert **none** of the fields `rows/columns/answer/sql/steps` **or `title`** exist | Negative and structural; anyone who later "just" stores answer / title in the pointer turns red on the spot. Since revision 1.5 `title` is on the blacklist too |
| **GC-16** | 🔴 **The card is still listed when its title cannot be read** (revision 1.5): delete a card's regional `head.json` ⇒ that row **is still there** in the list, `title` is empty and a placeholder is shown, `titleUnavailableCount ≥ 1`; [Open and continue] / [Delete] still work | Asserting only "the title shows when things are normal" would leave an implementation that "filters out whatever cannot be read" all green — and that implementation makes the user think the cards are lost |
| **GC-8** | **Unauthorized access fails closed**: user B takes A's `cardId` ⇒ GET / DELETE both return **404** (not 403 — existence is not leaked); not visible in the list | |
| **GC-9** | **Filtered by execution scope**: the home view sees only home cards; switching to `tgt_use1_a` sees only that region's; **switching between two multi-region groups really changes the list** | The last clause pins the same defect as the `deps` hole found in the earlier scope-switching work |
| **GC-10** | **Opening a card from another scope follows the protocol of the [multi-region interaction design](./multi-region-execution-interaction.md), section 9.7**, asserting the four cases one by one: ① the dialog contains all three of **targetId + region + object identifier** (region alone is not enough — one region may have several targets);<br>② click [Switch region and continue] ⇒ the top-bar view **really changes** + **the URL changes** + the question box is enabled;<br>③ click [View read-only] ⇒ the top bar **does not change**, the question box is disabled **with a reason given**, **zero side effects** (zero new ledger / memory entries — assert on the source of truth, not on "no error");<br>④ the target is **visible but not serviceable** ⇒ there is **no** [Switch region and continue] button, only read-only + reason + a direct entry | The "zero side effects" of ③ and the "button must not appear at all" of ④ are where the discriminating power lies: asserting only ①② would leave an implementation that "always allows the switch" all green |
| **GC-11** | **Classification re-masking**: the column is plaintext at save time → mark the column sensitive → reopen ⇒ **the column is masked**. 🔴 Must be run as a **non-platform-administrator** (an admin is exempted from masking outright via `isPlatformAdmin`; with an admin this criterion is always green); the SQL may only reference **probe tables created for this run** (referencing real tables mixes the live classification in ⇒ impossible to tell whether the column I marked took effect or was masked anyway) | Pins "cards are not a back door around data classification". ⚠️ **Measured in revision 1.6: this criterion could never have held before** — see gap ① in the header. Only writing the criterion revealed it; this is exactly "while fixing a criterion, ask the second question too: is the product's behavior right?" |
| **GC-12** | **Cross-jurisdiction**: saving a card of a cross-jurisdiction target writes a regional audit record, and the central summary **does not contain** SQL / results; if the audit write fails ⇒ the save **is refused** | ✅ Turned real on 2026-10-11: "regional audit written / central summary without SQL" is judged for real by criterion GC-12b of the cross-jurisdiction acceptance segment on the EU-simulation execution region of a second test account (the regional audit table shows the row of this save · the central summary with the same auditId has no SQL text · the card can be opened);<br>"not serviceable ⇒ refused, with zero jurisdiction wording in the reason" = GC-12a of this feature's segment;<br>"refuse when the audit write fails / pass the residency gate before writing the body" = sequence assertions in the cards-service unit tests.<br>~~carrier-dependency registration~~ |
| **GC-13** | **Over-limit refusal is explicit**: create 201 turns / >20MB ⇒ **400** and the copy states whether it is "turns" or "bytes" and by how much | No silent truncation |
| **GC-14** | **Page-level end to end**: a headless browser really clicks through (save → name → visible in the collection → open → continue → delete), asserting the real DOM | Headless page-level acceptance may not be skipped |
| **GC-15** | **Deleting a workspace may not silently leave cards behind** (revision 1.6 ruling = **block + list the details**, no cascade): ① an empty workspace can be deleted (**positive control**); ② with one card saved in the workspace ⇒ deleting the workspace returns **400** and the details name "session cards"; ③ after deleting that card the workspace **can be deleted** (proving the card was indeed the blocker) | ⚠️ **Measured in revision 1.6: the card table was not in the deletion resource inventory at all** ⇒ the behavior was "silently keep them", exactly the kind this criterion forbids. Without ③, the 400 of ② could come from another resource type — ① and ③ are where the discriminating power lies |

### Anti-pattern list (⛔ these practices are explicitly forbidden in this work)

1. ⛔ **LRU auto-eviction** of cards when the quota is full — violates guardrail 1 "nothing gets lost".
2. ⛔ **Best-effort save** (copying `recordGenBiHistory`'s try/catch that swallows exceptions) — cards are user assets; a failure must be made known to the user.
3. ⛔ **Stuffing the body into a single DynamoDB item** — 400KB blows up **silently** around turn 3–5, and it blows up on the write side, so the user only sees "save failed".
4. ⛔ **Using `conversationId` directly as the S3 key** — it is a user-controlled string (`conv-<ts>-<rand>` is merely a frontend convention) ⇒ path-traversal risk; always `cardId = ulid()`.
5. ⛔ **Adding a menu leaf** — it would trigger the entire ratchet mechanism for full coverage of the 31 leaves. Use a drawer; if a standalone page is wanted later, it **must wire `ScopeDecl` in the same batch**.
6. ⛔ **A dual path "same jurisdiction takes route A, cross-jurisdiction takes route B"** — proven in this repository: two copies **fork even in their failure semantics**. The body always lands in that region, defined in one place.

---

## 10. ✅ Decided on 2026-09-12 (3 items)

| # | Question | My default | The other path | Trade-off |
|---|---|---|---|---|
| ① | Store the title centrally, or also keep it in the region? | ✅ **Decided: also in the region** (my default overruled) | My original default was "store centrally" | Landing: see the revision header and section 4.1a. My worry "region unreachable ⇒ the list is simply empty" is solved by **degrade, do not disappear**: cards are always listed, only the title slot shows a placeholder (pinned by criterion GC-16) |
| ② | What 100 means | ✅ **Decided: 100 per user, globally** | 100 per user per workspace | Matches my default; implementation = `TransactWriteItems` in the same central table (section 3.2) |
| ③ | Scheduling order | ✅ **Decided: as proposed** | — | That is, "after the fixture work item and before the next scheduled work package, or in parallel with it" |

---

## 11. Relationship to existing modules (no reinvention)

| Reused | Source | How it is used |
|---|---|---|
| The three disciplines of region-side storage | `src/lib/exec-env/residency-store.ts` | The body store copies the disciplines verbatim (resource names only from the resource bag / no Update·Delete of business data / no business decisions) |
| Residency gate + consent + regional audit | The [multi-region specification](./multi-region-execution-spec.md), sections 3.2 / 3.3 (the residency gate is already delivered) | Called directly when saving / opening a cross-jurisdiction card; **no new gate** |
| Execution-scope read rule | The multi-region specification, section 2.6.3 + `toScopeParam` | The list route takes `?scope=`; a card is bound to a target |
| Data classification masking | [Classification and masking](./classification-masking.md) | Re-applied on open, taking the stricter |
| Conversation memory | `src/lib/genbi/memory.ts` | A second exit `replaceConversation` is added, implemented by both backends |
| "Raise as request" | [GenBI requirement pipeline](./genbi-requirement-pipeline.md) | **Unchanged**, side by side with this feature; both draw on the same turn / the same conversation |

---

## 12. 🔴 Known risks and registered items (added in revision 1.2 after surveying the real infrastructure; **not resolved within this work**)

| # | Fact | Impact | Handling |
|---|---|---|---|
| ① | The body buckets (home and non-home `datalakeBucket`) are both **SSE-S3**, not a CMK | Card bodies hold real business data rows yet only get S3-managed keys; they do not get the CMK treatment the `residency` bucket has | A CMK needs **one key per region + grants to three parties** (the platform TaskRole / Glue / EMR all read this bucket) ⇒ a separate step. This work **states it honestly** and does not pretend there is KMS |
| ② | 🔴 **Home's `datalakeBucket` is `DESTROY + autoDeleteObjects: true`** (`platform-stack.ts:57`); non-home is `RETAIN` without autoDelete (`exec-env/core-stack.ts:64-68`; the file header says "deliberately the opposite") | Destroying the platform stack ⇒ **home card bodies are deleted together with the objects** while the central pointers remain ⇒ a batch of cards that "fail to open" | Belongs to the line "the home bucket is still DESTROY" recorded in the first phase of the multi-region execution work; this work does not change it. ⚠️ But this work must **make it visible**: when the body is missing on open ⇒ say explicitly "the body is no longer in that region" + offer to delete the card, instead of throwing an incomprehensible error |
| ③ | Deleting an execution environment ⇒ that region's card bodies stay with the bucket (RETAIN) but the environment is gone; **the central pointers dangle** | Clicking the card in "My cards" fails, while the quota slot stays occupied | Folded into the cleanup list of the execution-environment decommission work: the **impact preview** of deleting an environment must list "this region holds the bodies of N session cards" (guardrail 1 "nothing gets lost" = inform first), and the cleanup removes the corresponding pointers as well |
| ④ | "`TransactWriteItems` needs no separate IAM action" was only found as a **documentation-level statement** this round and not confirmed in a real environment (the authoritative page is JS-rendered; the action table could not be scraped) | If an action beyond `dynamedb:ConditionCheckItem` is actually required, saving fails with AccessDenied | The design already avoids it (only Put + a conditional Update, both actions the TaskRole has); **the truth is established by GC-3 on the spot in a real environment** |
