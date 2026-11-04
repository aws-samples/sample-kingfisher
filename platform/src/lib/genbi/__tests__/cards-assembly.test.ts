// @kf-batch 54-genbi-session-cards
// 🔴🔴 **装配层判据(2026-09-13 立)** —— 只 mock **真外部**(DDB / S3 / 注册表 / 模型侧),
// `cards-service` ↔ `cards-store` ↔ `cards-body-store` **之间一律不 mock**。
//
// 【为什么必须有这一层:一天里 4 个自埋的缺陷全长在接缝上,而 93 条单测 + 60 个变异全绿】
//  · `cardId` 两个作者 ⇒ 每张卡都打不开 —— service 的测 mock 掉 store,而那个 mock **回一个自己编的 id**;
//  · 并发争抢被当 500 + 每次漏一个孤儿正文 —— mock 的 store **从不产生** `TransactionConflict`,那条路一次没跑;
//  · 执行环境删掉后卡片永久卡住 —— `getTargetRaw` 被 mock,「target 不存在」这一格不在夹具矩阵里;
//  · §9.7 够不着 —— 两边各自测过,没有任何测试问「用户能不能从入口走到那儿」(那一条归页面级 GC-9b)。
// 共同病根:**mock 抹平了接缝**。单元测试证明每个零件对,装配起来仍然是坏的。
// ⇒ 本文件把发现成本从「部署 15 分钟 + 真环境跑一轮」拉回 `vitest` 的 30 秒。
//
// 🔴 纪律:任何新增的跨模块协作(A 生成、B 落盘;A 抛、B 补偿)都要在这里加一条,而不是在各自的单测里。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";

// ── 真外部 ①:内存 DynamoDB(语义与 cards-store.test.ts 那份同源:条件求值 + 事务全或无)──
const ddb = new Map<string, Record<string, any>>();
const kk = (pk: string, sk: string) => `${pk}|${sk}`;
const hooks = vi.hoisted(() => ({ conflictOnce: false, conflictAlways: false, transactCalls: 0 }));

function condOk(cond: string, row: any, names: Record<string, string>, vals: Record<string, any>): boolean {
  const c = (cond || "").trim();
  if (!c) return true;
  if (c === "attribute_not_exists(pk)") return row === undefined;
  if (c === "attribute_not_exists(#n) OR #n < :limit") {
    const n = row?.[names["#n"]];
    return n === undefined || n < vals[":limit"];
  }
  if (c === "#n > :zero") return typeof row?.[names["#n"]] === "number" && row[names["#n"]] > vals[":zero"];
  if (c === "attribute_exists(pk) AND #st = :ready") return row !== undefined && row[names["#st"]] === vals[":ready"];
  throw new Error(`装配层 mock 不认识这条 ConditionExpression:${c}`);
}
function applyUpdate(row: any, ue: string, names: Record<string, string>, vals: Record<string, any>) {
  for (const m of ue.matchAll(/ADD\s+(#?\w+)\s+(:\w+)/g)) {
    const attr = names[m[1]] ?? m[1];
    row[attr] = (typeof row[attr] === "number" ? row[attr] : 0) + vals[m[2]];
  }
  const setPart = ue.startsWith("SET ") ? ue.slice(4) : "";
  for (const assign of setPart ? setPart.split(",") : []) {
    const [lhs, rhs] = assign.split("=").map((x) => x.trim());
    if (lhs && rhs) row[names[lhs] ?? lhs] = vals[rhs];
  }
}
function conflict() {
  const e = new TransactionCanceledException({ $metadata: {}, message: "cancelled" });
  (e as any).CancellationReasons = [{ Code: "None" }, { Code: "TransactionConflict" }];
  return e;
}

// @kf-batch 50-WP28-platform-action-node —— 刷新会写 run 台账(手动那次)⇒ 记下来给判据看
const runRows = vi.hoisted(() => [] as Array<Record<string, any>>);
vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { GENBI_CARDS: "bgp-genbi-cards", TASK_RUNS: "bgp-task-runs" },
  docClient: {
    send: async (cmd: any) => {
      const i = cmd.input;
      if (i.TransactItems) {
        hooks.transactCalls += 1;
        if (hooks.conflictAlways) throw conflict();
        if (hooks.conflictOnce) { hooks.conflictOnce = false; throw conflict(); }
        const reasons: { Code: string }[] = [];
        let failed = false;
        for (const it of i.TransactItems) {
          const spec = it.Put ?? it.Update;
          const key = it.Put ? { pk: spec.Item.pk, sk: spec.Item.sk } : spec.Key;
          const ok = condOk(spec.ConditionExpression, ddb.get(kk(key.pk, key.sk)), spec.ExpressionAttributeNames || {}, spec.ExpressionAttributeValues || {});
          reasons.push({ Code: ok ? "None" : "ConditionalCheckFailed" });
          if (!ok) failed = true;
        }
        if (failed) {
          const e = new TransactionCanceledException({ $metadata: {}, message: "cancelled" });
          (e as any).CancellationReasons = reasons;
          throw e;
        }
        for (const it of i.TransactItems) {
          if (it.Put) { ddb.set(kk(it.Put.Item.pk, it.Put.Item.sk), { ...it.Put.Item }); continue; }
          const u = it.Update;
          const key = kk(u.Key.pk, u.Key.sk);
          const row = ddb.get(key) ?? { ...u.Key };
          applyUpdate(row, u.UpdateExpression, u.ExpressionAttributeNames || {}, u.ExpressionAttributeValues || {});
          ddb.set(key, row);
        }
        return {};
      }
      if (i.TableName === "bgp-task-runs" && i.Item) { runRows.push({ ...i.Item }); return {}; }
      if (i.UpdateExpression) {
        const key = kk(i.Key.pk, i.Key.sk);
        const row = ddb.get(key);
        if (!condOk(i.ConditionExpression, row, i.ExpressionAttributeNames || {}, i.ExpressionAttributeValues || {})) {
          const e = new Error("ConditionalCheckFailedException"); e.name = "ConditionalCheckFailedException"; throw e;
        }
        const r = row ?? { ...i.Key };
        applyUpdate(r, i.UpdateExpression, i.ExpressionAttributeNames || {}, i.ExpressionAttributeValues || {});
        ddb.set(key, r);
        return {};
      }
      if (i.Key) {
        if (cmd.constructor?.name === "DeleteCommand" || cmd.__del) { ddb.delete(kk(i.Key.pk, i.Key.sk)); return {}; }
        return { Item: ddb.get(kk(i.Key.pk, i.Key.sk)) };
      }
      if (i.KeyConditionExpression) {
        const pk = i.ExpressionAttributeValues[":u"];
        let rows = [...ddb.values()].filter((r) => r.pk === pk);
        if (i.IndexName) {
          const conv = i.ExpressionAttributeValues[":c"];
          rows = rows.filter((r) => r.conversationId === conv);
        } else {
          rows = rows.filter((r) => String(r.sk || "").startsWith(i.ExpressionAttributeValues[":p"]));
        }
        return { Items: rows };
      }
      return {};
    },
  },
}));
vi.mock("@aws-sdk/lib-dynamodb", async (orig) => {
  const real = (await orig()) as any;
  return { ...real, DeleteCommand: class { __del = true; constructor(public input: any) {} } };
});

// ── 真外部 ②:内存 S3 ──
const s3store = new Map<string, string>();
const s3key = (b: string, k: string) => `${b}/${k}`;
vi.mock("@aws-sdk/client-s3", () => ({
  PutObjectCommand: class { __k = "put"; constructor(public input: any) {} },
  GetObjectCommand: class { __k = "get"; constructor(public input: any) {} },
  DeleteObjectCommand: class { __k = "del"; constructor(public input: any) {} },
}));
vi.mock("@/lib/exec-env/target-clients", async (orig) => {
  const real = (await orig()) as any;
  return {
    ...real,
    s3ClientFor: async () => ({
      send: async (cmd: any) => {
        const { Bucket, Key, Body } = cmd.input;
        if (cmd.__k === "put") { s3store.set(s3key(Bucket, Key), String(Body)); return {}; }
        if (cmd.__k === "del") { s3store.delete(s3key(Bucket, Key)); return {}; }
        const v = s3store.get(s3key(Bucket, Key));
        if (v === undefined) { const e = new Error("NoSuchKey"); e.name = "NoSuchKey"; throw e; }
        return { Body: { transformToString: async () => v } };
      },
    }),
  };
});

// ── 真外部 ③:注册表(返回**真实形状**的描述符;`gone` 那一格必须能造出来)──
const reg = vi.hoisted(() => ({ present: true, ready: true }));
const DESC = {
  targetId: "tgt_use1_a", region: "us-east-1", status: "active", ready: true,
  resources: {
    datalakeBucket: "bgp-datalake-000000000000-tgt-use1-a",
    scriptsBucket: "bgp-glue-scripts-000000000000-tgt-use1-a",
    tableBucket: "bgp-table-bucket-tgt-use1-a",
    glueRoleArn: "arn:aws:iam::000000000000:role/BgpExecEnv-tgt-use1-a-glue-role",
  },
};
vi.mock("@/lib/exec-env/registry", () => ({
  getTargetRaw: async () => (reg.present ? DESC : null),
  requireReadyTarget: async () => {
    if (!reg.ready) { const e = new Error("not ready") as any; e.name = "TargetNotReadyError"; throw e; }
    return DESC;
  },
  TargetNotReadyError: class extends Error {},
}));
const seen = vi.hoisted(() => ({ maskIdentities: [] as any[], scheduledAudits: [] as any[], userAudits: [] as any[], sqlFail: "" , records: [[{ stringValue: "华北" }, { longValue: 77 }]] as any[] }));
vi.mock("@/lib/exec-env/residency-audit", () => ({
  residencyAudit: async (i: any) => { seen.userAudits.push(i); return null; },
  scheduledResidencyAudit: async (i: any) => { seen.scheduledAudits.push(i); return null; },
  userActor: (identity: any) => ({ identity, authKind: "cognito-user-jwt" }),
  auditActorOrService: () => ({ actor: { kind: "user", id: "u" } }),
}));
vi.mock("@/lib/governance/masking", () => ({
  maskRows: async (i: any) => { seen.maskIdentities.push(i.identity); return { rows: i.rows, maskedColumns: [] }; },
}));
// 真外部 ④:数仓(刷新重跑 SQL 的那一跳;runSelect 本身是兄弟模块,真跑)
vi.mock("@/lib/redshift/direct-query", () => ({
  resolveDirectQueryPlace: async (scope: any) => ({ targetId: scope.targetId, region: "us-east-1", workgroup: "wg", database: "dev" }),
  directQueryRaw: async () => {
    if (seen.sqlFail) throw new Error(seen.sqlFail);
    return { columns: ["region", "n"], records: seen.records, totalNumRows: seen.records.length };
  },
}));
vi.mock("@/lib/genbi/memory", () => ({ replaceConversation: async (_c: string, t: any[]) => ({ backend: "selfmanaged", cleared: 0, written: t.length, skipped: false }) }));

// 真外部 ⑤:平台动作的调度对象(lib/scheduler —— 载体发布 / 下线打的是 MWAA Serverless,这里只记顺序)
const sched = vi.hoisted(() => ({ rows: new Map<string, any>(), calls: [] as string[] }));
vi.mock("@/lib/scheduler/action-schedules", () => ({
  getActionSchedule: async (id: string) => (sched.rows.has(id) ? { ...sched.rows.get(id) } : null),
  listActionSchedules: async (kind: string) => [...sched.rows.values()].filter((r) => r.kind === kind),
  createActionSchedule: async (input: any) => { sched.calls.push("create"); const row = { ...input, userId: "default-user", scheduleEnabled: false }; sched.rows.set(input.taskId, row); return { ...row }; },
  updateActionScheduleDraft: async (row: any, patch: any) => {
    if (row.scheduleEnabled) throw new Error("启用中不能改参数");
    sched.calls.push("update"); const next = { ...row, ...patch }; sched.rows.set(row.taskId, next); return { ...next };
  },
  setActionScheduleEnabled: async (row: any, o: any) => {
    sched.calls.push(o.enabled ? `enable:${o.cron}` : "disable");
    const next = { ...sched.rows.get(row.taskId), scheduleEnabled: o.enabled, cronExpression: o.enabled ? o.cron : sched.rows.get(row.taskId).cronExpression };
    sched.rows.set(row.taskId, next);
    return { enabled: o.enabled, cronExpression: next.cronExpression, dagId: "d" };
  },
  deleteActionSchedule: async (row: any) => { sched.calls.push("delete"); sched.rows.delete(row.taskId); },
  isCarrierArmed: () => false,
}));
vi.mock("@/lib/auth/cognito-users", () => ({ getUserAuthState: async (u: string) => authState.get(u) ?? (() => { throw new Error("UserNotFound"); })() }));
vi.mock("@/lib/projects/project-service", () => ({ getMember: async (p: string, u: string) => (members.has(`${p}|${u}`) ? { role: "viewer" } : null) }));
const authState = new Map<string, { sub: string; enabled: boolean; groups: string[] }>();
const members = new Set<string>();

import { saveCard, openCard, deleteCard, listCards } from "@/lib/genbi/cards-service";
import { configureCardSchedule, removeCardSchedule, assertCardAuthorStillAuthorized, assertCardStillSchedulable } from "@/lib/genbi/cards-schedule";
import { readQuota, CARD_LIMIT, getCardPointer, CARD_REFRESH_SNAPSHOT_KEEP } from "@/lib/genbi/cards-store";
import { refreshCardOnce, cardScheduleTaskId } from "@/lib/genbi/cards-refresh";

const SUB = "sub-assembly";
const turn = (q: string) => ({
  i: 0, question: q, askedAt: "2026-09-13T00:00:00.000Z", elapsedMs: 1,
  result: { answer: `答:${q}`, sql: "select region, n from public.customers", columns: ["region", "n"],
            rows: [["华东", "1204"], [null, "0"]], rowCount: 2, chart: { type: "bar" }, steps: [],
            usage: {}, maskedColumns: [] as string[], matchedTables: [], usedContext: [] },
  error: null,
});
const save = (over: any = {}) => saveCard({
  userSub: SUB, identity: null, projectId: "proj-default", targetId: "tgt_use1_a",
  engine: "redshift", database: "dev", conversationId: "conv-1", title: "装配层",
  turns: [turn("按地区统计客户数")] as any, ...over,
});

beforeEach(() => {
  ddb.clear(); s3store.clear();
  hooks.conflictOnce = false; hooks.conflictAlways = false; hooks.transactCalls = 0;
  reg.present = true; reg.ready = true;
  runRows.length = 0;
  sched.rows.clear(); sched.calls.length = 0; authState.clear(); members.clear();
  seen.maskIdentities.length = 0; seen.scheduledAudits.length = 0; seen.userAudits.length = 0; seen.sqlFail = "";
  seen.records = [[{ stringValue: "华北" }, { longValue: 77 }]];
});

describe("🔴🔴 装配层:service ↔ store ↔ body-store 之间不 mock", () => {
  it("① 存了就一定读得回来(cardId 分叉 = 每张卡都打不开;这条会当场逮住)", async () => {
    const r = await save();
    const opened = await openCard(SUB, r.cardId, null);
    expect(opened.bodyMissing, "🔴 存进去读不回来 —— 指针与正文指向了两个位置").toBe(false);
    expect(opened.body.turns.length).toBe(1);
    expect(opened.body.turns[0].question).toBe("按地区统计客户数");
    // 承重:指针里的 cardId 必须与正文对象 key 里那一段逐字相同
    expect(opened.pointer.bodyRef.key).toContain(r.cardId);
    // 而且 S3 里真的只有这一份(不是写了两个 key)
    expect([...s3store.keys()].filter((k) => k.endsWith("body.json")).length).toBe(1);
  });

  it("② 深比:rows / null / 嵌套图表规格一字不差地往返", async () => {
    const r = await save();
    const opened = await openCard(SUB, r.cardId, null);
    expect((opened.body.turns[0].result as any).rows).toEqual([["华东", "1204"], [null, "0"]]);
    expect((opened.body.turns[0].result as any).chart).toEqual({ type: "bar" });
  });

  it("③ 争抢一次 ⇒ 平台吸收后成功,且**不留孤儿正文**(S3 里恰好一份)", async () => {
    hooks.conflictOnce = true;
    const r = await save();
    expect(hooks.transactCalls, "没有真的重试过").toBeGreaterThan(1);
    expect(await readQuota(SUB)).toBe(1);
    expect([...s3store.keys()].filter((k) => k.endsWith("body.json")).length, "重试写了两份正文").toBe(1);
    expect((await openCard(SUB, r.cardId, null)).bodyMissing).toBe(false);
  });

  it("④ 争抢用尽 ⇒ 抛,而且**刚写的正文被补偿删掉**(不留孤儿)", async () => {
    hooks.conflictAlways = true;
    await expect(save()).rejects.toBeTruthy();
    expect([...s3store.keys()].length, "🔴 指针写失败却留下了孤儿正文对象").toBe(0);
    expect(await readQuota(SUB)).toBe(0);
  });

  it("⑤ 满额 ⇒ 第 101 张被拒,且**它的正文没留下来**;计数器恰好 100", async () => {
    for (let i = 0; i < CARD_LIMIT; i++) await save({ conversationId: `conv-${i}` });
    expect(await readQuota(SUB)).toBe(CARD_LIMIT);
    const before = s3store.size;
    await expect(save({ conversationId: "conv-overflow" })).rejects.toMatchObject({ name: "CardQuotaExceeded" });
    expect(s3store.size, "满额被拒却留下了孤儿正文").toBe(before);
    expect(await readQuota(SUB)).toBe(CARD_LIMIT);
  });

  it("⑥ 重复保存同一段对话:一张卡、一份正文、额度只 +1", async () => {
    const a = await save();
    const b = await save({ turns: [turn("q1"), turn("q2")] as any });
    expect(b.cardId).toBe(a.cardId);
    expect(b.created).toBe(false);
    expect(await readQuota(SUB)).toBe(1);
    expect([...s3store.keys()].filter((k) => k.endsWith("body.json")).length).toBe(1);
    expect((await openCard(SUB, a.cardId, null)).body.turns.length).toBe(2);
  });

  it("⑦ 删除:正文 + 头 + 指针三样都没了,额度回落", async () => {
    const r = await save();
    expect(s3store.size).toBe(2);                       // body + head
    const d = await deleteCard(SUB, r.cardId);
    expect(d.bodyCleaned).toBe(true);
    expect(s3store.size, "该区正文/头没删干净").toBe(0);
    expect((await listCards(SUB)).items.length).toBe(0);
    expect(await readQuota(SUB)).toBe(0);
  });

  it("⑧ 🔴 执行环境已不在注册表 ⇒ 终态:指针删掉 + 回 bodyOrphaned(不留永远删不掉的一行)", async () => {
    const r = await save();
    reg.present = false;                                 // 该 target 从注册表消失
    const d = await deleteCard(SUB, r.cardId);
    expect(d.bodyCleaned).toBe(false);
    expect(d.bodyOrphaned?.key, "孤儿落点必须带出来给运维").toBeTruthy();
    expect((await listCards(SUB)).items.length, "🔴 留下了一行永远删不掉的卡").toBe(0);
  });
});

// @kf-batch 50-WP28-platform-action-node(WP-29 问数 · CAP-GENBI)
describe("🔴🔴 装配层:卡片刷新(refresh ↔ store ↔ body-store ↔ runSelect 之间不 mock)", () => {
  const USER = { sub: SUB, username: "u1", groups: [], isPlatformAdmin: false, isManager: false, isDeveloper: false, demo: false } as any;
  const manual = { triggeredBy: "manual" as const, actor: { kind: "user" as const, identity: USER } };

  it("R1 刷新的是**同一张**卡:正文换成新数据、额度不动、留一份快照 + latest、指针盖非数据戳、手动那次进台账", async () => {
    const r = await save();
    const shaBefore = (await getCardPointer(SUB, r.cardId))!.bodySha256;
    seen.maskIdentities.length = 0; seen.userAudits.length = 0;
    const out = await refreshCardOnce(SUB, r.cardId, manual);
    // 最严口径脱敏(刷新这一次;打开卡片时还会再脱一次,那是另一条路)
    expect(seen.maskIdentities).toEqual([null]);
    expect(seen.userAudits[0]).toMatchObject({ entry: "execute", targetId: "tgt_use1_a" });
    const opened = await openCard(SUB, r.cardId, null);
    const res = opened.body.turns[0].result as any;
    expect(res.rows).toEqual([["华北", "77"]]);
    expect(res.refreshedAt).toBe(out.refreshedAt);
    expect(res.answer, "文字结论保持保存时的样子(只换数据)").toBe("答:按地区统计客户数");
    expect(await readQuota(SUB), "刷新不许占额度").toBe(1);
    const keys = [...s3store.keys()];
    expect(keys.filter((k) => k.endsWith(`/runs/${out.snapshotId}.json`)).length).toBe(1);
    expect(keys.filter((k) => k.endsWith("/latest.json")).length).toBe(1);
    const p = await getCardPointer(SUB, r.cardId);
    expect(p).toMatchObject({ lastRefreshedAt: out.refreshedAt, lastRefreshStatus: "succeeded", lastRefreshSnapshotId: out.snapshotId, refreshCount: 1, refreshSnapshots: [out.snapshotId] });
    expect(p!.bodySha256, "正文改写后指针摘要必须跟上").not.toBe(shaBefore);
    // 🔴 中央指针仍然不含任何数据值(标题 / 行 / SQL 都不许进来)
    for (const k of ["rows", "columns", "sql", "title", "result"]) expect(Object.keys(p!)).not.toContain(k);
    // 手动那次:台账一行,taskId = 卡片调度对象 id,taskType = genbi-card
    expect(runRows).toHaveLength(1);
    expect(runRows[0]).toMatchObject({ taskId: cardScheduleTaskId(r.cardId), runId: out.snapshotId, taskType: "genbi-card", status: "succeeded", triggeredBy: "manual", targetId: "tgt_use1_a", projectId: "proj-default", rowCount: 1 });
  });

  it("R2 没有可重跑的 SQL ⇒ 拒(不报成功),不留快照,台账记 failed", async () => {
    const t = turn("纯文字");
    (t.result as any).sql = null;
    const r = await save({ turns: [t] as any });
    await expect(refreshCardOnce(SUB, r.cardId, manual)).rejects.toMatchObject({ name: "CardNotRefreshable" });
    expect([...s3store.keys()].some((k) => k.includes("/runs/"))).toBe(false);
    expect(runRows[0]).toMatchObject({ status: "failed" });
    expect((await getCardPointer(SUB, r.cardId))!.lastRefreshStatus).toBe("failed");
  });

  it("R3 重跑 SQL 失败 ⇒ CardRefreshFailed 带真因;正文不动;指针记 failed", async () => {
    const r = await save();
    seen.sqlFail = "relation public.customers does not exist";
    await expect(refreshCardOnce(SUB, r.cardId, manual)).rejects.toMatchObject({ name: "CardRefreshFailed" });
    const opened = await openCard(SUB, r.cardId, null);
    expect((opened.body.turns[0].result as any).rows).toEqual([["华东", "1204"], [null, "0"]]);
    expect((await getCardPointer(SUB, r.cardId))!.lastRefreshStatus).toBe("failed");
    expect(String(runRows[0].error)).toContain("does not exist");
  });

  it("R4 定时那次:不重复写台账(由 DAG 收口);驻留审计替**作者**校验同意", async () => {
    const r = await save();
    seen.userAudits.length = 0;
    await refreshCardOnce(SUB, r.cardId, { triggeredBy: "schedule", actor: { kind: "schedule", authorSub: SUB } });
    expect(runRows).toHaveLength(0);
    expect(seen.scheduledAudits[0]).toMatchObject({ onBehalfOfSub: SUB, targetId: "tgt_use1_a", entry: "execute" });
    expect(seen.userAudits).toHaveLength(0);
  });

  it("R5 快照保留份数有上限(超出的最旧那份当场删);删卡把正文 / 头 / 快照 / latest 全清干净", async () => {
    const r = await save();
    for (let i = 0; i < CARD_REFRESH_SNAPSHOT_KEEP + 2; i++) await refreshCardOnce(SUB, r.cardId, manual);
    const runs = [...s3store.keys()].filter((k) => k.includes("/runs/"));
    expect(runs.length).toBe(CARD_REFRESH_SNAPSHOT_KEEP);
    const p = await getCardPointer(SUB, r.cardId);
    expect(p!.refreshSnapshots!.length).toBe(CARD_REFRESH_SNAPSHOT_KEEP);
    expect(p!.refreshCount).toBe(CARD_REFRESH_SNAPSHOT_KEEP + 2);
    const d = await deleteCard(SUB, r.cardId);
    expect(d.bodyCleaned).toBe(true);
    expect([...s3store.keys()], "删卡后该区还留着快照 / latest(带业务数据行的孤儿)").toEqual([]);
  });

  it("R6 卡片不可承接 / 不存在 ⇒ 抛,不回落主控区", async () => {
    const r = await save();
    reg.ready = false;
    await expect(refreshCardOnce(SUB, r.cardId, manual)).rejects.toBeTruthy();
    reg.ready = true;
    await expect(refreshCardOnce(SUB, "01NOPE0000000000000000000", manual)).rejects.toMatchObject({ name: "CardNotFound" });
  });
});

describe("🔴 卡片定时刷新的配置面(cards-schedule ↔ store ↔ body-store 不 mock)", () => {
  const ME = { sub: SUB, username: "u1", groups: [], isPlatformAdmin: false, isManager: false, isDeveloper: false, demo: false } as any;

  it("C1 纯文字卡不许配定时(每次都会失败的空跑)", async () => {
    const t = turn("纯文字");
    (t.result as any).sql = null;
    const r = await save({ turns: [t] as any });
    await expect(configureCardSchedule(ME, r.cardId, { cronExpression: "0 8 * * *", enabled: true })).rejects.toMatchObject({ name: "CardNotRefreshable" });
    expect(sched.calls).toEqual([]);
  });

  it("C2 新建并启用:落点 = 卡片自己的区;参数带作者;名字**不含标题**", async () => {
    const r = await save();
    const out = await configureCardSchedule(ME, r.cardId, { cronExpression: "0 8 * * *", enabled: true });
    expect(sched.calls).toEqual(["create", "enable:0 8 * * *"]);
    const row = sched.rows.get(cardScheduleTaskId(r.cardId));
    expect(row).toMatchObject({ kind: "genbi-card", targets: ["tgt_use1_a"], projectId: "proj-default", action: "genbi.card-refresh", ownerSub: SUB, ownerUsername: "u1" });
    expect(row.params).toEqual({ cardId: r.cardId, ownerSub: SUB, ownerUsername: "u1" });
    expect(row.name).not.toContain("装配层"); // 标题只留在区域侧
    expect(out.scheduleEnabled).toBe(true);
  });

  it("C3 启用中改 cron:先撤载体 → 改草稿 → 再启用(启用中不许直接改参数)", async () => {
    const r = await save();
    await configureCardSchedule(ME, r.cardId, { cronExpression: "0 8 * * *", enabled: true });
    sched.calls.length = 0;
    await configureCardSchedule(ME, r.cardId, { cronExpression: "*/10 * * * *", enabled: true });
    expect(sched.calls).toEqual(["disable", "update", "enable:*/10 * * * *"]);
  });

  it("C4 停用;删卡前先撤调度对象;别人的卡 404", async () => {
    const r = await save();
    await configureCardSchedule(ME, r.cardId, { cronExpression: "0 8 * * *", enabled: true });
    sched.calls.length = 0;
    await configureCardSchedule(ME, r.cardId, { cronExpression: "0 8 * * *", enabled: false });
    expect(sched.calls).toEqual(["disable"]);
    await removeCardSchedule(r.cardId);
    expect(sched.calls).toEqual(["disable", "delete"]);
    await expect(configureCardSchedule({ ...ME, sub: "someone-else" }, r.cardId, { cronExpression: "0 8 * * *", enabled: true })).rejects.toMatchObject({ name: "CardNotFound" });
  });

  it("C5 定时执行前的作者重验 fail-closed:禁用 / sub 变了 / 移出项目 ⇒ 拒;平台管理员 / 成员 ⇒ 放行", async () => {
    authState.set("u1", { sub: SUB, enabled: true, groups: [] });
    await expect(assertCardAuthorStillAuthorized("u1", SUB, "proj-default")).rejects.toThrow(/不是项目/);
    members.add("proj-default|u1");
    await expect(assertCardAuthorStillAuthorized("u1", SUB, "proj-default")).resolves.toBeUndefined();
    authState.set("u1", { sub: SUB, enabled: false, groups: [] });
    await expect(assertCardAuthorStillAuthorized("u1", SUB, "proj-default")).rejects.toThrow(/禁用/);
    authState.set("u1", { sub: "other", enabled: true, groups: [] });
    await expect(assertCardAuthorStillAuthorized("u1", SUB, "proj-default")).rejects.toThrow(/sub 不一致/);
    authState.set("adm", { sub: "s-adm", enabled: true, groups: ["bgp-admin"] });
    await expect(assertCardAuthorStillAuthorized("adm", "s-adm", "proj-other")).resolves.toBeUndefined();
    await expect(assertCardAuthorStillAuthorized("ghost", "s", "proj-default")).rejects.toThrow(/UserNotFound/);
  });

  it("C6 卡片改存到别的区 / 不在了 ⇒ 定时那次拒(不在错的区取数)", async () => {
    const r = await save();
    await expect(assertCardStillSchedulable(SUB, r.cardId, "tgt_use1_a", "proj-default")).resolves.toBeUndefined();
    await expect(assertCardStillSchedulable(SUB, r.cardId, "tgt_usw2_a", "proj-default")).rejects.toThrow(/改存到/);
    await expect(assertCardStillSchedulable(SUB, r.cardId, "tgt_use1_a", "proj-x")).rejects.toThrow(/归属项目/);
    await expect(assertCardStillSchedulable(SUB, "01NOPE0000000000000000000", "tgt_use1_a", "proj-default")).rejects.toThrow(/不存在/);
  });
});

