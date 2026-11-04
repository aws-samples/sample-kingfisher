// @kf-batch 50-WP30-discard
// 🔴🔴 WP-30 路 A「弃置」装配层:discard ↔ deploy-control(CFN 处置)↔ recovery(会话收口)↔ lifecycle(唯一写通道)
//   之间**一律不 mock**;只 mock 真外部 —— DynamoDB(一张内存行 + **忠实的条件表达式求值器**)、CloudFormation、CodeBuild。
//
// 为什么必须是装配层(而不是给 discard.ts 单测 mock 掉 recovery / lifecycle):
//   弃置的正确性全在**接缝**上 —— 「先查栈再写」的顺序、收口会话后**重读**再判、收口写的 post-image 能不能被弃置写的
//   条件接住(version 3→4→5)、`operation` 删键而不是置 undefined。mock 掉兄弟模块,这些全看不见(mock-hides-the-seam)。
//
// 夹具 = 2026-10-01 新账号第一章 `w5a` 真撞出来的 `tgt_apn1_a` 描述符(脱敏):ap-northeast-1 注册一次性 T3 ⇒
//   部署 build FAILED(B-29:AZ 写死 a/b)⇒ 卡在 provisioning + 一个没人收口的部署会话 + 部署锁,目标区一个栈都没有。
import { describe, it, expect, vi, beforeEach } from "vitest";

type Item = Record<string, any>;
const h = vi.hoisted(() => ({
  item: null as Item | null,
  ddb: [] as { name: string; input: any }[],
  cfn: [] as { region: string; name: string; input: any }[],
  cb: [] as { name: string; input: any }[],
  /** StackName → 状态;没有 = 「does not exist」 */
  stacks: {} as Record<string, string>,
  cfnDenied: false,
  buildStatus: "FAILED" as string,
  /** 在第 N 次 UpdateCommand **之前**改行(模拟并发写入方) */
  beforeUpdate: null as null | ((n: number, item: Item) => void),
  updates: 0,
  /** 三个外部的**统一**调用序列(判「先查栈再写」只能跨流比) */
  seq: [] as string[],
}));

// ── 忠实的 DynamoDB 表达式求值器(只覆盖本链路真实发出的语法:整属性 SET/REMOVE + = / <> / attribute_(not_)exists / OR;认不出的片段直接抛)───────────────────
function resolvePath(item: Item, path: string, names: Record<string, string>): { found: boolean; value?: unknown } {
  let cur: any = item;
  for (const seg of path.trim().split(".")) {
    const key = seg.startsWith("#") ? names[seg] : seg;
    if (key === undefined) throw new Error(`ValidationException: 未定义的名字 ${seg}`);
    if (cur === null || typeof cur !== "object" || !(key in cur)) return { found: false };
    cur = cur[key];
  }
  return { found: true, value: cur };
}
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${k}:${canon((v as any)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
function splitTop(expr: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0, buf = "";
  const toks = expr.split(/(\(|\)|\s+)/);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === "(") depth++;
    if (t === ")") depth--;
    if (depth === 0 && t === sep) { out.push(buf); buf = ""; continue; }
    buf += t;
  }
  out.push(buf);
  return out.map((s) => s.trim()).filter(Boolean);
}
function evalCond(expr: string, item: Item, names: Record<string, string>, values: Record<string, unknown>, used: Set<string>): boolean {
  const s = expr.trim();
  const ands = splitTop(s, "AND");
  // 🔴 不短路:每个片段都要求值(否则后面片段里的 names/values 记不成「已用」⇒ 夹具假报 ValidationException)
  if (ands.length > 1) return ands.map((a) => evalCond(a, item, names, values, used)).every(Boolean);
  const ors = splitTop(s, "OR");
  if (ors.length > 1) return ors.map((a) => evalCond(a, item, names, values, used)).some(Boolean);
  if (s.startsWith("(") && s.endsWith(")")) return evalCond(s.slice(1, -1), item, names, values, used);
  const fn = s.match(/^(attribute_exists|attribute_not_exists)\(([^)]+)\)$/);
  if (fn) {
    fn[2].split(".").forEach((p) => used.add(p.trim()));
    const r = resolvePath(item, fn[2], names);
    return fn[1] === "attribute_exists" ? r.found : !r.found;
  }
  const cmp = s.match(/^(\S+)\s*(=|<>)\s*(:\w+)$/);
  if (cmp) {
    cmp[1].split(".").forEach((p) => used.add(p));
    used.add(cmp[3]);
    if (!(cmp[3] in values)) throw new Error(`ValidationException: 未定义的值 ${cmp[3]}`);
    const r = resolvePath(item, cmp[1], names);
    const eq = r.found && canon(r.value) === canon(values[cmp[3]]);
    return cmp[2] === "=" ? eq : r.found && !eq;
  }
  throw new Error(`求值器不认识的条件片段(夹具要先扩充,别静默放行):${s}`);
}
function applyUpdate(item: Item, expr: string, names: Record<string, string>, values: Record<string, unknown>, used: Set<string>): Item {
  const next: Item = structuredClone(item);
  const m = expr.match(/^SET (.*?)(?: REMOVE (.*))?$/);
  if (!m) throw new Error(`求值器不认识的更新表达式:${expr}`);
  for (const a of m[1].split(",")) {
    const [lhs, rhs] = a.split("=").map((x) => x.trim());
    if (lhs.includes(".")) throw new Error(`本链路只应整属性 SET,却出现 ${lhs}`);
    const key = lhs.startsWith("#") ? names[lhs] : lhs;
    used.add(lhs); used.add(rhs);
    if (!(rhs in values)) throw new Error(`ValidationException: 未定义的值 ${rhs}`);
    if (values[rhs] === undefined) throw new Error(`ValidationException: ${rhs} 是 undefined(DocumentClient 会直接抛)`);
    next[key] = structuredClone(values[rhs]);
  }
  for (const r of (m[2] || "").split(",").map((x) => x.trim()).filter(Boolean)) {
    used.add(r);
    delete next[r.startsWith("#") ? names[r] : r];
  }
  return next;
}
function hasUndefinedDeep(v: unknown): boolean {
  if (v === undefined) return true;
  if (Array.isArray(v)) return v.some(hasUndefinedDeep);
  if (v && typeof v === "object") return Object.values(v).some(hasUndefinedDeep);
  return false;
}

vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { EXECUTION_ENVS: "bgp-execution-envs" },
  docClient: {
    send: async (cmd: any) => {
      const name = cmd.constructor.name;
      h.ddb.push({ name, input: structuredClone(cmd.input) });
      h.seq.push(`ddb:${name}`);
      if (name === "GetCommand") return { Item: h.item ? structuredClone(h.item) : undefined };
      if (name === "UpdateCommand") {
        h.updates += 1;
        if (h.beforeUpdate && h.item) h.beforeUpdate(h.updates, h.item);
        const { UpdateExpression, ConditionExpression, ExpressionAttributeNames: N = {}, ExpressionAttributeValues: V = {} } = cmd.input;
        if (hasUndefinedDeep(V)) throw Object.assign(new Error("Pass options.removeUndefinedValues=true"), { name: "Error" });
        const used = new Set<string>();
        const ok = h.item !== null && evalCond(ConditionExpression, h.item, N, V, used);
        const nextItem = h.item ? applyUpdate(h.item, UpdateExpression, N, V, used) : null;
        // DynamoDB 拒绝没被表达式用到的 names / values(真环境 ValidationException,unit mock 常测不出)
        const unusedN = Object.keys(N).filter((k) => !used.has(k));
        const unusedV = Object.keys(V).filter((k) => !used.has(k));
        if (unusedN.length || unusedV.length) throw Object.assign(new Error(`ValidationException: unused ${[...unusedN, ...unusedV].join(",")}`), { name: "ValidationException" });
        if (!ok) throw Object.assign(new Error("The conditional request failed"), { name: "ConditionalCheckFailedException" });
        h.item = nextItem;
        return {};
      }
      throw new Error(`装配夹具未预期的 DDB 调用:${name}`);
    },
  },
}));

vi.mock("@aws-sdk/client-cloudformation", async (orig) => {
  const real: any = await orig();
  class FakeCfn {
    region: string;
    constructor(cfg: { region: string }) { this.region = cfg.region; }
    async send(cmd: any) {
      const name = cmd.constructor.name;
      h.cfn.push({ region: this.region, name, input: cmd.input });
      h.seq.push(`cfn:${name}`);
      if (h.cfnDenied) throw Object.assign(new Error("User: arn:aws:sts::123456789012:assumed-role/x is not authorized to perform cloudformation:DescribeStacks"), { name: "AccessDenied" });
      const st = h.stacks[cmd.input.StackName];
      if (name === "DescribeStacksCommand") {
        if (!st) throw Object.assign(new Error(`Stack with id ${cmd.input.StackName} does not exist`), { name: "ValidationError" });
        return { Stacks: [{ StackName: cmd.input.StackName, StackStatus: st }] };
      }
      if (name === "ListChangeSetsCommand") return { Summaries: [] };
      if (name === "DescribeStackEventsCommand") return { StackEvents: [] };
      throw new Error(`装配夹具未预期的 CFN 调用:${name}`);
    }
  }
  return { ...real, CloudFormationClient: FakeCfn };
});

vi.mock("@aws-sdk/client-codebuild", async (orig) => {
  const real: any = await orig();
  class FakeCb {
    async send(cmd: any) {
      h.cb.push({ name: cmd.constructor.name, input: cmd.input });
      h.seq.push(`cb:${cmd.constructor.name}`);
      if (cmd.constructor.name === "BatchGetBuildsCommand") return { builds: [{ id: cmd.input.ids[0], buildStatus: h.buildStatus }] };
      throw new Error(`装配夹具未预期的 CodeBuild 调用:${cmd.constructor.name}`);
    }
  }
  return { ...real, CodeBuildClient: FakeCb };
});

import { discardTarget, DiscardRefused } from "../discard";
import { transitionPhase, PhaseTransitionError, LifecycleConflictError, PHASE_EDGES, TARGET_PHASES } from "../lifecycle";

// ── 夹具:真实 tgt_apn1_a 描述符(2026-10-01 读自 DDB,账号号已脱敏)──────────────────────────
const OP = "op_380484eb37c6b75e";
const BUILD = "bgp-exec-env-deploy:8665a8e1-5ab6-4198-9b60-c71fc6550dd2";
const PROBE = {
  at: "2026-10-01T07:59:36.873Z", ok: false,
  items: [
    { name: "datalakeBucket", ok: false, error: "描述符缺 resources.datalakeBucket(先 finalizeTargetResources 回写资源袋)" },
    { name: "scriptsBucket", ok: false, error: "描述符缺 resources.scriptsBucket(先 finalizeTargetResources 回写资源袋)" },
  ],
};
const apn1 = (): Item => ({
  pk: "env", sk: "tgt_apn1_a", targetId: "tgt_apn1_a", region: "ap-northeast-1", accountId: "123456789012", partition: "aws",
  jurisdiction: "eu-sim", createdBy: "admin", version: 3, status: "initializing", ready: false,
  components: ["core", "redshift"], vpcCidr: "10.129.0.0/16", credentialEpoch: 0, credentialIsolationState: "provisioning",
  credentialStateUpdatedAt: "2026-10-01T07:59:35.866Z", provisioningDeadlineAt: "2026-10-31T07:59:35.866Z",
  lockEpoch: 1, deployLockToken: OP, deployLockOperationId: OP, deployLockExpiresAt: 1790849725001,
  lastOperationId: OP, lastBuildId: BUILD, probe: PROBE, updatedAt: "2026-10-01T08:32:11.901Z",
  spec: { intent: "serve", desiredComponents: ["core", "redshift"] },
  observed: {
    phase: "provisioning", health: "unknown", components: ["core", "redshift"], probe: PROBE,
    operation: {
      kind: "deploy", operationId: OP, lockEpoch: 1, buildId: BUILD, disruptive: true,
      openSnapshotHash: "5ebc513e2426bed4c106774a4bb0ece144fc4b0d3ceb7cecd39b256ba04716c3",
      sourceRef: "4056af22876cd3fbcae3d03189327a493e6b8453012c6ae4cd07e2e98701a737.zip", startedAt: "2026-10-01T08:00:25.001Z",
    },
  },
});
/** 刚注册、还没点过部署(无会话、无锁)的描述符 */
const registeredOnly = (): Item => {
  const x = apn1();
  delete x.deployLockToken; delete x.deployLockOperationId; delete x.deployLockExpiresAt; delete x.lastOperationId; delete x.lastBuildId;
  x.status = "registered"; x.lockEpoch = 0;
  x.observed = { phase: "registered", health: "unknown", components: ["core"] };
  x.components = ["core"];
  return x;
};
const ACTOR = { username: "admin", decisionId: "discard-20261001-a1" };
const writes = () => h.ddb.filter((x) => x.name === "UpdateCommand");
const refusal = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return e as DiscardRefused; }
  throw new Error("应当被拒却成功了");
};

beforeEach(() => {
  h.item = apn1(); h.ddb.length = 0; h.cfn.length = 0; h.cb.length = 0;
  h.stacks = {}; h.cfnDenied = false; h.buildStatus = "FAILED"; h.beforeUpdate = null; h.updates = 0; h.seq.length = 0;
});

describe("🔴🔴 装配层:弃置真实形状的 tgt_apn1_a(部署失败 + 未收口会话 + 部署锁 + 目标区零栈)", () => {
  it("成功:先收口失败会话(唯一失败写入方)再退役 ⇒ gone / deleted / intent=delete;锁与会话都没了;两次写 version 3→4→5", async () => {
    const r = await discardTarget("tgt_apn1_a", ACTOR);
    expect(r).toMatchObject({ targetId: "tgt_apn1_a", region: "ap-northeast-1", recoveredOperationId: OP, before: { phase: "provisioning", status: "initializing", operation: OP } });
    const it = h.item!;
    expect(it.observed.phase).toBe("gone");
    expect(it.status, "投影必须是「已删除」(列表 / 一区一套名额都按它)").toBe("deleted");
    expect(it.spec.intent).toBe("delete");
    expect("operation" in it.observed, "operation 必须删键,不是置 undefined").toBe(false);
    expect(it.deployLockToken).toBeUndefined();
    expect(it.deployLockOperationId).toBeUndefined();
    expect(it.version).toBe(5);
    expect(writes().length, "收口一次 + 退役一次").toBe(2);
    // 收口那一笔写的是**失败处置**(诊断留痕),不是弃置自己发明的写法
    expect(JSON.stringify(writes()[0].input.ExpressionAttributeValues)).toContain(ACTOR.decisionId);
    // 目标区的栈是在 ap-northeast-1 查的,base / core / redshift 三个候选都查到
    expect(new Set(h.cfn.map((c) => c.region))).toEqual(new Set(["ap-northeast-1"]));
    expect(new Set(h.cfn.filter((c) => c.name === "DescribeStacksCommand").map((c) => c.input.StackName)))
      .toEqual(new Set(["BgpExecEnv-tgt-apn1-a-base", "BgpExecEnv-tgt-apn1-a-core", "BgpExecEnv-tgt-apn1-a-redshift"]));
  });

  it("🔴 顺序:CFN 现查(全部候选栈)发生在**任何**写之前;收口后**重读**描述符再退役", async () => {
    await discardTarget("tgt_apn1_a", ACTOR);
    const firstWrite = h.seq.indexOf("ddb:UpdateCommand");
    const cfnBeforeWrite = h.seq.slice(0, firstWrite).filter((x) => x === "cfn:DescribeStacksCommand").length;
    expect(firstWrite).toBeGreaterThan(0);
    // 6 = 弃置自己先查一遍(3 个候选)+ recoverFailedSession 的 CFN 闸再查一遍(3 个);弃置那遍必须在碰会话(CodeBuild)之前
    expect(cfnBeforeWrite, "第一笔写之前:弃置现查 + 恢复闸各查一遍三个候选栈").toBe(6);
    expect(h.seq.slice(0, h.seq.indexOf("cb:BatchGetBuildsCommand")).filter((x) => x === "cfn:DescribeStacksCommand").length,
      "弃置必须**先**查栈再去判会话").toBe(3);
    const secondWrite = h.seq.lastIndexOf("ddb:UpdateCommand");
    expect(secondWrite).toBeGreaterThan(firstWrite);
    expect(h.seq.slice(firstWrite + 1, secondWrite), "收口写之后、退役写之前必须重读").toContain("ddb:GetCommand");
  });

  it("🔴 目标区有本环境的栈(哪怕是已回滚完的 ROLLBACK_COMPLETE)⇒ 409 指向路 B,**零写**,描述符原样", async () => {
    h.stacks["BgpExecEnv-tgt-apn1-a-core"] = "ROLLBACK_COMPLETE";
    const before = structuredClone(h.item);
    const e = await refusal(discardTarget("tgt_apn1_a", ACTOR));
    expect(e).toBeInstanceOf(DiscardRefused);
    expect(e.httpStatus).toBe(409);
    expect(e.message).toMatch(/BgpExecEnv-tgt-apn1-a-core\[ROLLBACK_COMPLETE\]/);
    expect(e.message).toMatch(/申请删除/);
    expect(writes()).toEqual([]);
    expect(h.item).toEqual(before);
    expect(h.cb, "有栈就不该再去碰会话").toEqual([]);
  });

  it("🔴 CFN 查不清(权限 / 网络)⇒ fail-closed 409,零写;报错里不泄账号号", async () => {
    h.cfnDenied = true;
    const e = await refusal(discardTarget("tgt_apn1_a", ACTOR));
    expect(e.httpStatus).toBe(409);
    expect(e.message).toMatch(/查不清/);
    expect(e.message).not.toMatch(/\d{12}/);
    expect(writes()).toEqual([]);
  });

  it("🔴 部署 build 还在跑 ⇒ 409(等它结束),零写", async () => {
    h.buildStatus = "IN_PROGRESS";
    const e = await refusal(discardTarget("tgt_apn1_a", ACTOR));
    expect(e.httpStatus).toBe(409);
    expect(e.message).toContain(OP);
    expect(writes()).toEqual([]);
    expect(h.item!.observed.operation.operationId).toBe(OP);
  });

  it("🔴 并发:收口之后、退役之前有人回写了资源袋 ⇒ 条件写拒(LifecycleConflictError),不许变 gone", async () => {
    h.beforeUpdate = (n, item) => { if (n === 2) item.resources = { datalakeBucket: "x" }; };
    await expect(discardTarget("tgt_apn1_a", ACTOR)).rejects.toBeInstanceOf(LifecycleConflictError);
    expect(h.item!.observed.phase).toBe("provisioning");
  });

  it("🔴 并发:退役那一刻又有人拿到了部署锁 ⇒ 条件写拒,不许变 gone", async () => {
    h.beforeUpdate = (n, item) => { if (n === 2) { item.deployLockToken = "op_other"; } };
    await expect(discardTarget("tgt_apn1_a", ACTOR)).rejects.toBeInstanceOf(LifecycleConflictError);
    expect(h.item!.observed.phase).toBe("provisioning");
  });

  it("刚注册、从没部署:无会话可收口 ⇒ 直接一次写退役(不碰 CodeBuild)", async () => {
    h.item = registeredOnly();
    const r = await discardTarget("tgt_apn1_a", ACTOR);
    expect(r.recoveredOperationId).toBeUndefined();
    expect(writes().length).toBe(1);
    expect(h.cb).toEqual([]);
    expect(h.item!.observed.phase).toBe("gone");
    expect(h.item!.status).toBe("deleted");
  });

  it("存量描述符没有 ready 属性 ⇒ 仍可弃置(条件写的「从没 ready」不许把「缺属性」误拒)", async () => {
    h.item = registeredOnly();
    delete h.item.ready;
    await discardTarget("tgt_apn1_a", ACTOR);
    expect(h.item!.observed.phase).toBe("gone");
  });
});

describe("🔴 拒绝面(判定在 lib,路由原样映射;全部零写)", () => {
  it("主控区 ⇒ 403,连描述符以外的东西都不查", async () => {
    h.item = { ...apn1(), targetId: "tgt_home", sk: "tgt_home", region: "us-east-1" };
    const e = await refusal(discardTarget("tgt_home", ACTOR));
    expect(e.httpStatus).toBe(403);
    expect(h.cfn).toEqual([]);
    expect(writes()).toEqual([]);
  });
  it("不存在 ⇒ 404", async () => {
    h.item = null;
    expect((await refusal(discardTarget("tgt_apn1_a", ACTOR))).httpStatus).toBe(404);
  });
  it("装出来过(phase=ready)⇒ 409 指向路 B,不查 CFN", async () => {
    const x = apn1();
    x.observed = { phase: "ready", health: "healthy", components: ["core"], probe: { ...PROBE, ok: true, items: [] } };
    x.ready = true; x.status = "active";
    delete x.deployLockToken; delete x.deployLockOperationId; delete x.deployLockExpiresAt;
    h.item = x;
    const e = await refusal(discardTarget("tgt_apn1_a", ACTOR));
    expect(e.httpStatus).toBe(409);
    expect(e.message).toMatch(/申请删除/);
    expect(h.cfn).toEqual([]);
  });
  it("回写过资源袋 ⇒ 409(说明目标区建出过东西)", async () => {
    h.item = { ...registeredOnly(), resources: { datalakeBucket: "b" } };
    const e = await refusal(discardTarget("tgt_apn1_a", ACTOR));
    expect(e.httpStatus).toBe(409);
    expect(e.message).toMatch(/资源清单/);
    expect(writes()).toEqual([]);
  });
  it("已经 gone ⇒ 409(幂等地说清楚,不再写)", async () => {
    await discardTarget("tgt_apn1_a", ACTOR);
    const n = writes().length;
    const e = await refusal(discardTarget("tgt_apn1_a", ACTOR));
    expect(e.httpStatus).toBe(409);
    expect(writes().length).toBe(n);
  });
});

describe("🔴🔴 lifecycle:弃置边 ⇔ DiscardFence **成对**(同 enable 手法;边与 fence 任一单独出现都抛,在任何 DDB 调用之前)", () => {
  const post = (phase: string) => ({ spec: { intent: "delete" as const, desiredComponents: ["core"] }, observed: { phase, health: "unknown", components: [] } as any });
  const fence = (fromPhase: "registered" | "provisioning") => ({ expectedVersion: 3, fromPhase, noStacksVerifiedAt: "2026-10-01T09:00:00.000Z" });

  it("PHASE_EDGES:→gone 只有 registered / provisioning(弃置)与 decommissioning(路 B 销毁完成)三个来源", () => {
    const into = TARGET_PHASES.filter((p) => PHASE_EDGES[p].includes("gone"));
    expect([...into].sort()).toEqual(["decommissioning", "provisioning", "registered"]);
  });
  for (const from of ["registered", "provisioning"] as const) {
    it(`${from}→gone 不带 DiscardFence ⇒ 抛 PhaseTransitionError,零 DDB 调用`, async () => {
      await expect(transitionPhase("tgt_apn1_a", { from, expectedVersion: 3, post: post("gone"), reason: "x" })).rejects.toBeInstanceOf(PhaseTransitionError);
      expect(h.ddb).toEqual([]);
    });
  }
  it("DiscardFence 用在别的边(provisioning→verifying)⇒ 抛", async () => {
    await expect(transitionPhase("tgt_apn1_a", { from: "provisioning", expectedVersion: 3, post: post("verifying"), discardFence: fence("provisioning"), reason: "x" }))
      .rejects.toBeInstanceOf(PhaseTransitionError);
    expect(h.ddb).toEqual([]);
  });
  it("DiscardFence 用在 decommissioning→gone(路 B 的边)⇒ 抛", async () => {
    await expect(transitionPhase("tgt_apn1_a", { from: "decommissioning", expectedVersion: 3, post: post("gone"), discardFence: fence("provisioning"), reason: "x" }))
      .rejects.toBeInstanceOf(PhaseTransitionError);
  });
  it("fence 与调用不一致(fromPhase / version 对不上、时刻不是严格 ISO、post 带 operation、intent≠delete)⇒ 抛", async () => {
    const base = { from: "provisioning" as const, expectedVersion: 3, reason: "x" };
    await expect(transitionPhase("tgt_apn1_a", { ...base, post: post("gone"), discardFence: fence("registered") })).rejects.toBeInstanceOf(PhaseTransitionError);
    await expect(transitionPhase("tgt_apn1_a", { ...base, post: post("gone"), discardFence: { ...fence("provisioning"), expectedVersion: 2 } })).rejects.toBeInstanceOf(PhaseTransitionError);
    await expect(transitionPhase("tgt_apn1_a", { ...base, post: post("gone"), discardFence: { ...fence("provisioning"), noStacksVerifiedAt: "2026-10-01" } })).rejects.toBeInstanceOf(PhaseTransitionError);
    const withOp = post("gone"); withOp.observed.operation = { kind: "deploy", operationId: "op_x" };
    await expect(transitionPhase("tgt_apn1_a", { ...base, post: withOp, discardFence: fence("provisioning") })).rejects.toBeInstanceOf(PhaseTransitionError);
    const serve = post("gone"); (serve.spec as any).intent = "serve";
    await expect(transitionPhase("tgt_apn1_a", { ...base, post: serve, discardFence: fence("provisioning") })).rejects.toBeInstanceOf(PhaseTransitionError);
    expect(h.ddb).toEqual([]);
  });
});
