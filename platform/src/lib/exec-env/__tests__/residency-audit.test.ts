// residency-audit.ts —— 可审计闭包的单测(50 SPEC v3.23 §3.2 / §3.3;ACCEPTANCE 单测面)。
//
// 打桩只到 AWS SDK 边界(中央 docClient / 区域 docClient / 注册表读 / run 行写通道),审计 item 形状、同意判定、fail-closed 方向全部真跑。
// 变异靶(注释里的 M-x 与 ACCEPTANCE 对应):
//   M-a 删掉 `if (isHome(targetId)) return null` 之前的短路 ⇒ 「home 零区域客户端调用」红
//   M-b `requireResidencyAck` 改成 hasAck 失败也放行 ⇒ 「缺同意 409」红
//   M-c 区域写失败吞掉不抛 ⇒ 「写不成即拒」红
//   M-d 中央摘要塞进 sqlText / operatorSub ⇒ 「中央无 PII / 无原文」红
//   M-e 观测后补写不做 pending 抢占 ⇒ 「claim 失败不审」红
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";

const h = vi.hoisted(() => ({
  targets: {} as Record<string, Record<string, unknown>>,
  acks: new Set<string>(),
  central: [] as Array<{ table: string; item: Record<string, any> }>,
  centralGets: 0,
  regional: [] as Array<{ table: string; item: Record<string, any> }>,
  regionalClientCalls: 0,
  failRegional: false,
  failCentral: false,
  runUpdates: [] as Array<Record<string, any>>,
  claimResult: true,
}));

class ConditionalCheckFailedException extends Error {
  name = "ConditionalCheckFailedException";
}

vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { AUDIT: "bgp-audit", RESIDENCY_ACKS: "bgp-residency-acks", TASK_RUNS: "bgp-task-runs" },
  docClient: {
    send: vi.fn(async (cmd: any) => {
      const n = cmd.constructor.name;
      const input = cmd.input || {};
      if (n === "GetCommand") {
        h.centralGets++;
        if (input.TableName === "bgp-residency-acks") {
          const k = `${input.Key.pk}|${input.Key.sk}`;
          return h.acks.has(k) ? { Item: { pk: input.Key.pk, sk: input.Key.sk } } : {};
        }
        return {};
      }
      if (n === "PutCommand") {
        if (input.TableName === "bgp-audit" && h.failCentral) throw new Error("central down");
        if (input.TableName === "bgp-residency-acks") {
          const k = `${input.Item.pk}|${input.Item.sk}`;
          if (h.acks.has(k)) throw new ConditionalCheckFailedException("exists");
          h.acks.add(k);
        }
        h.central.push({ table: input.TableName, item: input.Item });
        return {};
      }
      if (n === "QueryCommand") return { Items: [] };
      return {};
    }),
  },
}));

vi.mock("@/lib/exec-env/target-clients", () => ({
  dynamoDocClientFor: vi.fn(async () => {
    h.regionalClientCalls++;
    return {
      send: async (cmd: any) => {
        if (h.failRegional) throw new Error("region table unreachable");
        h.regional.push({ table: cmd.input.TableName, item: cmd.input.Item });
        return {};
      },
    };
  }),
}));

vi.mock("@/lib/exec-env/registry", () => {
  class TargetNotReadyError extends Error {
    constructor(readonly targetId: string, readonly why: string) {
      super(`${targetId}: ${why}`);
      this.name = "TargetNotReadyError";
    }
  }
  return {
    TargetNotReadyError,
    getTargetRaw: vi.fn(async (id: string) => h.targets[id] ?? null),
    requireReadyTarget: vi.fn(async (id: string) => {
      const t = h.targets[id];
      if (!t) throw new TargetNotReadyError(id, "注册表里没有该描述符");
      return t;
    }),
  };
});

vi.mock("@/lib/monitor/run-records", () => ({
  updateRunRecord: vi.fn(async (args: Record<string, any>) => {
    h.runUpdates.push(args);
    // 第一次(claim)按 h.claimResult;第二次(定稿)恒成功
    return h.runUpdates.length === 1 ? h.claimResult : true;
  }),
}));

import {
  residencyAudit,
  requireResidencyAck,
  requireResidencyAckForTargets,
  residencyErrorResponse,
  auditObservedScheduledRun,
  userActor,
  SERVICE_ACTOR,
  MWAA_ACTOR,
  auditActorOrService,
} from "@/lib/exec-env/residency-audit";
import { AuditUnavailable, ResidencyAckRequired, RESIDENCY_ACK_REQUIRED, AUDIT_UNAVAILABLE } from "@/lib/exec-env/residency";
import { DISCLAIMER_TEXT, DISCLAIMER_TEXT_HASH, DISCLAIMER_VERSION } from "@/lib/residency/disclaimer";
import { __resetAckCache, putAck, hasAck, ACK_CACHE_TTL_MS } from "@/lib/exec-env/residency-store";
import { requireReadyTarget, getTargetRaw } from "@/lib/exec-env/registry";
import { dynamoDocClientFor } from "@/lib/exec-env/target-clients";
import type { Identity } from "@/lib/auth/identity";

const HOME = "tgt_home";
const SAME = "tgt_usw2_a";
const EU = "tgt_usw2_b";
const USER: Identity = { sub: "sub-A", username: "alice", email: "alice@example.com", groups: [], isPlatformAdmin: false, isManager: false, isDeveloper: false, demo: false };
const SQL = "select secret_col from customers where id = 42";

function seedTargets() {
  h.targets = {
    [HOME]: { targetId: HOME, jurisdiction: "home", region: "us-east-1", components: ["core"], resources: {} },
    [SAME]: { targetId: SAME, jurisdiction: "home", region: "us-west-2", components: ["core", "redshift"], resources: {} },
    [EU]: {
      targetId: EU,
      jurisdiction: "eu-sim",
      region: "us-west-2",
      components: ["core", "redshift", "residency-api"],
      resources: {
        residencyAuditTable: "bgp-region-audit-tgt-usw2-b",
        residencyResultsTable: "bgp-region-results-tgt-usw2-b",
        residencyBucket: "bgp-region-results-123456789012-tgt-usw2-b",
      },
    },
  };
}

function ackFor(sub: string, target: string) {
  h.acks.add(`${sub}|${target}#${DISCLAIMER_VERSION}`);
}

beforeEach(() => {
  seedTargets();
  h.acks.clear();
  h.central = [];
  h.centralGets = 0;
  h.regional = [];
  h.regionalClientCalls = 0;
  h.failRegional = false;
  h.failCentral = false;
  h.runUpdates = [];
  h.claimResult = true;
  __resetAckCache();
  vi.mocked(requireReadyTarget).mockClear();
  vi.mocked(getTargetRaw).mockClear();
  vi.mocked(dynamoDocClientFor).mockClear();
});

describe("🔴 home / 同法域:一字不变、零区域客户端(home 请求零区域客户端调用)", () => {
  it("home ⇒ null,且**不读注册表、不建区域客户端、不写中央**(M-a 靶)", async () => {
    const r = await residencyAudit({ actor: userActor(USER), targetId: HOME, entry: "execute", sqlText: SQL });
    expect(r).toBeNull();
    expect(vi.mocked(requireReadyTarget)).not.toHaveBeenCalled();
    expect(vi.mocked(dynamoDocClientFor)).not.toHaveBeenCalled();
    expect(h.central).toEqual([]);
  });
  it("knownJurisdiction=home(绑定已解析同法域)⇒ null 且不读注册表", async () => {
    const r = await residencyAudit({ actor: userActor(USER), targetId: SAME, entry: "execute", sqlText: SQL, knownJurisdiction: "home" });
    expect(r).toBeNull();
    expect(vi.mocked(requireReadyTarget)).not.toHaveBeenCalled();
  });
  it("同法域非 home ⇒ 走准入一次后 null;区域客户端仍零调用", async () => {
    const r = await residencyAudit({ actor: userActor(USER), targetId: SAME, entry: "run-submit", triggeredBy: "manual" });
    expect(r).toBeNull();
    expect(vi.mocked(requireReadyTarget)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dynamoDocClientFor)).not.toHaveBeenCalled();
  });
  it("准入内核拒(未注册 / stale)⇒ 原样抛 TargetNotReadyError,绝不 ?? home", async () => {
    await expect(residencyAudit({ actor: userActor(USER), targetId: "tgt_ghost", entry: "execute" })).rejects.toMatchObject({ name: "TargetNotReadyError" });
  });
});

describe("🔴 跨法域:同意前置", () => {
  it("缺同意 ⇒ 抛 ResidencyAckRequired,带当前版本 + 逐字文案 + 哈希;区域客户端零调用(M-b 靶)", async () => {
    const p = residencyAudit({ actor: userActor(USER), targetId: EU, entry: "execute", sqlText: SQL });
    await expect(p).rejects.toBeInstanceOf(ResidencyAckRequired);
    const e = (await p.catch((x) => x)) as ResidencyAckRequired;
    expect(e.reason).toBe(RESIDENCY_ACK_REQUIRED);
    expect(e.targetId).toBe(EU);
    expect(e.disclaimer).toEqual({ version: DISCLAIMER_VERSION, text: DISCLAIMER_TEXT, textHash: DISCLAIMER_TEXT_HASH });
    expect(vi.mocked(dynamoDocClientFor)).not.toHaveBeenCalled();
    expect(h.regional).toEqual([]);
  });
  it("requireResidencyAck:home / 同法域空操作;跨法域按 (sub, target, 版本) 查同意", async () => {
    await expect(requireResidencyAck(USER, HOME)).resolves.toBeUndefined();
    await expect(requireResidencyAck(USER, SAME)).resolves.toBeUndefined();
    await expect(requireResidencyAck(USER, EU)).rejects.toBeInstanceOf(ResidencyAckRequired);
    ackFor("sub-A", EU);
    await expect(requireResidencyAck(USER, EU)).resolves.toBeUndefined();
    // 别的用户仍要同意(同意是个人行为)
    await expect(requireResidencyAck({ ...USER, sub: "sub-B" }, EU)).rejects.toBeInstanceOf(ResidencyAckRequired);
  });
  it("多 target 扇出:先判全部,按入参顺序报第一个缺同意的", async () => {
    await expect(requireResidencyAckForTargets(USER, [HOME, SAME, EU])).rejects.toMatchObject({ targetId: EU });
    ackFor("sub-A", EU);
    await expect(requireResidencyAckForTargets(USER, [HOME, SAME, EU])).resolves.toBeUndefined();
  });
  it("putAck 幂等:第二次 created:false;hasAck 只增缓存 ⇒ 同意后不再打库", async () => {
    const rec = { userSub: "sub-A", username: "alice", targetId: EU, version: DISCLAIMER_VERSION, textHash: DISCLAIMER_TEXT_HASH, at: "2026-09-05T00:00:00.000Z" };
    expect(await putAck(rec)).toEqual({ created: true });
    expect(await putAck(rec)).toEqual({ created: false });
    const gets = h.centralGets;
    expect(await hasAck("sub-A", EU, DISCLAIMER_VERSION)).toBe(true);
    expect(h.centralGets).toBe(gets); // 命中缓存,没打库
    expect(await hasAck("sub-C", EU, DISCLAIMER_VERSION)).toBe(false); // 「没有」不缓存 ⇒ 每次都真查
  });
  it("hasAck 正向缓存**有界**(ACK_CACHE_TTL_MS):TTL 内不打库;过期后回 DDB;行已被带外删除 ⇒ 转为「没有」(多实例不再分歧)", async () => {
    const rec = { userSub: "sub-D", username: "dora", targetId: EU, version: DISCLAIMER_VERSION, textHash: DISCLAIMER_TEXT_HASH, at: "2026-09-05T00:00:00.000Z" };
    // 🔴 putAck 用**真**时钟盖缓存戳(Date.now() + TTL),而本测试把 t0 取在 putAck 之后:机器一忙、两次 Date.now() 差 ≥1ms,
    //   `t0 + TTL - 1` 就已过期 ⇒ 回库一次 ⇒ 假红(2026-10-18 kf-glm 全量 vitest 与硬门并跑时抖了一次,单跑 3/3 绿)。
    //   ⇒ 只冻结 Date(不动定时器 / Promise),让 putAck 的戳与 t0 是同一个瞬间;结束后复原真时钟。
    const t0 = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(t0);
    try {
      await putAck(rec);
      const gets = h.centralGets;
      expect(await hasAck("sub-D", EU, DISCLAIMER_VERSION, t0 + ACK_CACHE_TTL_MS - 1)).toBe(true);
      expect(h.centralGets).toBe(gets); // TTL 内命中缓存
      h.acks.delete(`sub-D|${EU}#${DISCLAIMER_VERSION}`); // 带外删除(合规处置 / 验收环境重置)
      expect(await hasAck("sub-D", EU, DISCLAIMER_VERSION, t0 + ACK_CACHE_TTL_MS + 1)).toBe(false);
      expect(h.centralGets).toBe(gets + 1); // 过期 ⇒ 回库一次 ⇒ 对齐为「没有」
      // 变异自检:若缓存不过期(TTL 无穷大),上面那次会仍返回 true —— 本测试即红
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("🔴 跨法域:双写形状 + 写不成即拒(M-c / M-d)", () => {
  it("区域全量(operator / SQL 原文 / entry / authKind)+ 中央摘要(同 auditId、只有 sqlHash、无 SQL 无 operator)", async () => {
    ackFor("sub-A", EU);
    const r = await residencyAudit({ actor: userActor(USER), targetId: EU, entry: "execute", sqlText: SQL, projectId: "proj-a", rows: 3, durationMs: 120 });
    expect(r).toBeTruthy();
    expect(r!.jurisdiction).toBe("eu-sim");
    expect(r!.region).toBe("us-west-2");
    // 区域
    expect(h.regional).toHaveLength(1);
    const reg = h.regional[0];
    expect(reg.table).toBe("bgp-region-audit-tgt-usw2-b");
    expect(reg.item.pk).toMatch(/^audit#tgt_usw2_b#\d{8}$/);
    expect(reg.item.sk).toBe(`${reg.item.ts}#${r!.auditId}`);
    expect(reg.item).toMatchObject({ auditId: r!.auditId, entry: "execute", authKind: "cognito-user-jwt", operatorSub: "sub-A", operator: "alice@example.com", sqlText: SQL, projectId: "proj-a", jurisdiction: "eu-sim" });
    // 中央
    const cen = h.central.filter((c) => c.table === "bgp-audit");
    expect(cen).toHaveLength(1);
    const item = cen[0].item;
    expect(item.action).toBe("residency.execute");
    expect(item.actor).toBe("system:residency");
    expect(item.actorSub).toBeUndefined();
    expect(item.resourceType).toBe("exec-env");
    expect(item.resourceId).toBe(EU);
    expect(item.detail).toMatchObject({ auditId: r!.auditId, targetId: EU, entry: "execute", rows: 3, durationMs: 120, sqlHash: createHash("sha256").update(SQL).digest("hex") });
    const flat = JSON.stringify(item);
    expect(flat).not.toContain(SQL);
    expect(flat).not.toContain("secret_col");
    expect(flat).not.toContain("sub-A");
    expect(flat).not.toContain("alice");
  });
  it("🔴 区域写失败 ⇒ AuditUnavailable(reason=audit-unavailable),中央不写(M-c 靶)", async () => {
    ackFor("sub-A", EU);
    h.failRegional = true;
    const p = residencyAudit({ actor: userActor(USER), targetId: EU, entry: "result", statementId: "stmt-1" });
    await expect(p).rejects.toBeInstanceOf(AuditUnavailable);
    const e = (await p.catch((x) => x)) as AuditUnavailable;
    expect(e.reason).toBe(AUDIT_UNAVAILABLE);
    expect(h.central.filter((c) => c.table === "bgp-audit")).toEqual([]);
  });
  it("🔴 中央摘要写失败 ⇒ 同样 AuditUnavailable(审计完整性对两侧一样严)", async () => {
    ackFor("sub-A", EU);
    h.failCentral = true;
    await expect(residencyAudit({ actor: userActor(USER), targetId: EU, entry: "history" })).rejects.toBeInstanceOf(AuditUnavailable);
  });
  it("skipAck(系统主体):不查同意、照写审计,authKind 如实为 service / mwaa", async () => {
    const r = await residencyAudit({ actor: SERVICE_ACTOR, targetId: EU, entry: "run-submit", triggeredBy: "backfill", skipAck: true });
    expect(r).toBeTruthy();
    expect(h.regional[0].item).toMatchObject({ authKind: "service", triggeredBy: "backfill", operatorSub: "service:platform" });
    expect(h.centralGets).toBe(0); // 没查过同意表
  });
  it("auditActorOrService:用户 actor 走同意前置;缺省 / 系统主体 skipAck", () => {
    expect(auditActorOrService(userActor(USER))).toEqual({ actor: userActor(USER), skipAck: false });
    expect(auditActorOrService(undefined)).toEqual({ actor: SERVICE_ACTOR, skipAck: true });
    expect(auditActorOrService(MWAA_ACTOR)).toEqual({ actor: MWAA_ACTOR, skipAck: true });
  });
});

describe("🔴 错误 → 响应映射(SPEC §3.2 v3.23 的 409 / 503 形状,单作者)", () => {
  it("ResidencyAckRequired ⇒ 409 CONFLICT + detail.reason/targetId/disclaimer", async () => {
    const res = residencyErrorResponse(new ResidencyAckRequired(EU, { version: "v1", text: "T", textHash: "H" }))!;
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.detail).toEqual({ reason: RESIDENCY_ACK_REQUIRED, targetId: EU, disclaimer: { version: "v1", text: "T", textHash: "H" } });
  });
  it("AuditUnavailable ⇒ 503 UPSTREAM_ERROR + detail.reason;其它错误 ⇒ null", async () => {
    const res = residencyErrorResponse(new AuditUnavailable(EU, "boom"))!;
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe("UPSTREAM_ERROR");
    expect(body.error.detail).toEqual({ reason: AUDIT_UNAVAILABLE, targetId: EU });
    expect(residencyErrorResponse(new Error("x"))).toBeNull();
  });
});

describe("🔴 定时 run 的观测后补写(pending 抢占协议,M-e 靶)", () => {
  const run = { taskId: "job-1", runId: "01RUN", targetId: EU, triggeredBy: "schedule" };
  it("非定时 / home / 同法域 ⇒ 零 I/O", async () => {
    expect(await auditObservedScheduledRun({ ...run, triggeredBy: "manual" })).toEqual({ audited: false });
    expect(await auditObservedScheduledRun({ ...run, targetId: HOME })).toEqual({ audited: false });
    expect(await auditObservedScheduledRun({ ...run, targetId: SAME })).toEqual({ audited: false });
    expect(h.runUpdates).toEqual([]);
    expect(h.regional).toEqual([]);
  });
  it("首次观测:claim(pending#)→ 区域审计(authKind=mwaa, triggeredBy=schedule, 不查同意)→ 定稿为真 auditId", async () => {
    const r = await auditObservedScheduledRun(run);
    expect(r.audited).toBe(true);
    expect(h.runUpdates).toHaveLength(2);
    expect(h.runUpdates[0]).toMatchObject({ taskId: "job-1", runId: "01RUN", extraCondition: "attribute_not_exists(residencyAuditId)" });
    expect(String(h.runUpdates[0].set.residencyAuditId)).toMatch(/^pending#/);
    expect(h.runUpdates[1]).toMatchObject({ extraCondition: "residencyAuditId = :prev", extraConditionValues: { ":prev": h.runUpdates[0].set.residencyAuditId } });
    expect(h.runUpdates[1].set.residencyAuditId).toBe(r.auditId);
    expect(h.regional[0].item).toMatchObject({ entry: "run-submit", triggeredBy: "schedule", authKind: "mwaa" });
    expect(h.centralGets).toBe(0);
  });
  it("已有真 auditId ⇒ 直接返回,不再写", async () => {
    const r = await auditObservedScheduledRun({ ...run, residencyAuditId: "01EXISTING" });
    expect(r).toEqual({ audited: true, auditId: "01EXISTING" });
    expect(h.runUpdates).toEqual([]);
  });
  it("🔴 claim 没抢到(别的实例先写了)⇒ 不写审计(M-e 靶)", async () => {
    h.claimResult = false;
    const r = await auditObservedScheduledRun(run);
    expect(r).toEqual({ audited: false });
    expect(h.regional).toEqual([]);
    expect(h.runUpdates).toHaveLength(1);
  });
  it("区域写失败 ⇒ 行上留 pending,不定稿;下次观测带着旧 pending 重试(条件写 = :prev)", async () => {
    h.failRegional = true;
    const r = await auditObservedScheduledRun(run);
    expect(r).toEqual({ audited: false });
    expect(h.runUpdates).toHaveLength(1);
    const pending = String(h.runUpdates[0].set.residencyAuditId);
    h.failRegional = false;
    h.runUpdates = [];
    const r2 = await auditObservedScheduledRun({ ...run, residencyAuditId: pending });
    expect(r2.audited).toBe(true);
    expect(h.runUpdates[0]).toMatchObject({ extraCondition: "residencyAuditId = :prev", extraConditionValues: { ":prev": pending } });
  });
});
