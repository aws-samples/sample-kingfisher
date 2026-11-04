// @kf-batch 50-WP4-o1-scope
// `GET /api/etl-jobs` 的执行范围过滤(合同 SPEC v3.36 §2.6;判据 E-150 / E-154 / E-156 / E-158)。
//
// 🔴 为什么必须可执行:本单元最容易出的两个错都不是「忘了写」,而是「写在了错的位置」——
//   ① 在**对账之前**过滤 ⇒ 缺省 global 下的副作用变了(别区那几条不再被回写状态);
//   ② 用 `contains(targets)` 下推给 DDB ⇒ 存量无 `targets` 的行在 home 视角下消失。
// 两个都只能靠跑一遍发现。

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

type Row = Record<string, unknown>;
let rows: Row[] = [];
const scans: Array<Record<string, any>> = [];
const reconciled: string[] = [];

vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { ETL_JOBS: "bgp-etl-jobs", ENGINE_JOBS: "bgp-engine-jobs" },
  docClient: {
    send: vi.fn(async (cmd: { input?: Record<string, unknown> }) => {
      scans.push((cmd.input ?? {}) as Record<string, any>);
      return { Items: rows };
    }),
  },
}));

vi.mock("@/lib/projects/guard", async () => {
  const actual = await vi.importActual<typeof import("@/lib/projects/guard")>("@/lib/projects/guard");
  return {
    projectFilter: actual.projectFilter,
    envFilter: actual.envFilter,
    getActiveEnv: actual.getActiveEnv,
    requireProject: vi.fn(async () => ({ identity: {}, projectId: "proj-a", role: "viewer" })),
  };
});

vi.mock("@/lib/exec-env/registry", () => ({
  // 🔴 范围校验走 `getTargetRaw`(不带可服务性准入);桩里**故意不给** `getTarget`,
  //    哪天有人改回去调它,这个文件立刻报「不是函数」(全量硬门实撞过那个形态)。
  getTargetRaw: vi.fn(async (id: string) =>
    ["tgt_home", "tgt_usw2_a"].includes(id) ? { targetId: id, ready: true } : null
  ),
  descriptorViolation: vi.fn(() => null),
}));

// 对账:记录被对账的行,但不改内容(用来断「过滤发生在对账之后」)
vi.mock("@/lib/etl/job-service", () => ({
  reconcileEtlJob: vi.fn(async (it: Row) => {
    reconciled.push(String(it.jobId));
    return it;
  }),
}));

vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn() }));
vi.mock("@/lib/versions/version-service", () => ({ snapshotVersion: vi.fn() }));
vi.mock("@/lib/openmetadata/om-push", () => ({ pushSqlLineageToOpenMetadata: vi.fn() }));
vi.mock("@/lib/governance/lineage-service", () => ({ recordComputeLineage: vi.fn() }));

import { GET } from "../route";

function req(qs = ""): NextRequest {
  return new NextRequest(`https://x.test/api/etl-jobs${qs}`);
}

beforeEach(() => {
  scans.length = 0;
  reconciled.length = 0;
  rows = [
    { jobId: "a", targets: ["tgt_home"] },
    { jobId: "b", targets: ["tgt_usw2_a"] },
    { jobId: "c", targets: ["tgt_home", "tgt_usw2_a"] },
    { jobId: "d" },
  ];
});

describe("缺省(不带 scope)= 现状", () => {
  it("全部返回,且**没有**往 DDB 下推任何 target 过滤(回滚点 E-158)", async () => {
    const res = await GET(req());
    const b = await res.json();
    expect(res.status).toBe(200);
    expect(b.data.map((x: Row) => x.jobId)).toEqual(["a", "b", "c", "d"]);
    expect(scans[0].FilterExpression).not.toContain("targets");
    expect(scans[0].FilterExpression).not.toContain("scope");
  });

  it("显式 scope=global 与缺省等价", async () => {
    const b = await (await GET(req("?scope=global"))).json();
    expect(b.data.map((x: Row) => x.jobId)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("target 视角", () => {
  it("🔴 home 视角包含存量无 targets 的行(三级回落)", async () => {
    const b = await (await GET(req("?scope=tgt_home"))).json();
    expect(b.data.map((x: Row) => x.jobId)).toEqual(["a", "c", "d"]);
  });

  it("非 home 视角只留绑了它的", async () => {
    const b = await (await GET(req("?scope=tgt_usw2_a"))).json();
    expect(b.data.map((x: Row) => x.jobId)).toEqual(["b", "c"]);
  });

  it("🔴 过滤发生在**对账之后**:别区那几条仍被对账(否则缺省之外多了副作用变化)", async () => {
    await GET(req("?scope=tgt_usw2_a"));
    expect(reconciled.sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("🔴 不许把过滤下推成 DDB 表达式(存量行会消失)", async () => {
    await GET(req("?scope=tgt_home"));
    expect(scans[0].FilterExpression).not.toMatch(/contains\(/);
  });
});

describe("compare 视角", () => {
  it("并集", async () => {
    const b = await (await GET(req("?scope=cmp:tgt_home,tgt_usw2_a"))).json();
    expect(b.data.map((x: Row) => x.jobId)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("拒因(一律不回落)", () => {
  it("文法非法 ⇒ 400 INVALID_SCOPE,且**一条数据都不返回**", async () => {
    const res = await GET(req("?scope=us-west-2"));
    expect(res.status).toBe(400);
    const b = await res.json();
    expect(b.error.code).toBe("INVALID_SCOPE");
    expect(b.data).toBeUndefined();
  });

  it("不存在的 target ⇒ 404 TARGET_NOT_FOUND,不回落 home 数据", async () => {
    const res = await GET(req("?scope=tgt_zzz9"));
    expect(res.status).toBe(404);
    const b = await res.json();
    expect(b.error.code).toBe("TARGET_NOT_FOUND");
    expect(JSON.stringify(b)).not.toContain("jobId");
  });

  it("🔴 请求头篡改无效(E-156):头指向 usw2、URL 说 home ⇒ 按 home 过滤", async () => {
    const res = await GET(
      new NextRequest("https://x.test/api/etl-jobs?scope=tgt_home", {
        headers: { "x-bgp-target-id": "tgt_usw2_a" },
      })
    );
    const b = await res.json();
    expect(b.data.map((x: Row) => x.jobId)).toEqual(["a", "c", "d"]);
  });
});
