// @kf-batch 50-WP7-sync-pushdown(施工序 3)
// 同步执行逐区下推的**接线判据**(与 flink-place.test.ts 同款:钉源码接缝,防「写了没接上」)。
// 🔴 如实声明边界:文本判据挡不住变异 —— 行为判据在段 `o4`(E-217..E-228,部署后无头真验);
// 这里只保证四条**结构性事实**在源码层不被悄悄退回:
//   ① start 路由不再有钉死主控区的模块级客户端/env 落点;
//   ② 两条 409(跨区取数 / 通道未逐区)接在执行入口上;SC-5 的旧码在本路由消失(改判的代码侧事实);
//   ③ run 章按真落点显式盖(resolveRunStamp 第二参),两处(建行 + 收口)都传;
//   ④ OM 回填(启动推送 + 成功后 4 个 backfill)只在 home 调。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// @kf-batch 37-sync-backfill —— glue 通道启动核心已从路由原样搬到 lib/sync/start-run.ts(补数中心要复用)⇒
//   本组判据看的「启动链」= 路由 + 启动核心两份源码合起来;另加一条:路由**在调用位置**接上了启动核心。
const startRouteSrc = readFileSync(
  join(__dirname, "..", "..", "..", "app", "api", "sync", "[id]", "start", "route.ts"),
  "utf8"
);
const startCoreSrc = readFileSync(join(__dirname, "..", "start-run.ts"), "utf8");
const startSrc = startRouteSrc + "\n" + startCoreSrc;
const realtimeSrc = readFileSync(
  join(__dirname, "..", "..", "..", "app", "api", "sync", "[id]", "start-realtime", "route.ts"),
  "utf8"
);

/** 负向断言先剥 TS 整行注释(本仓红线:负向文本断言按行剥注释)。 */
function codeOnly(src: string): string {
  return src.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
}

describe("WP-7 施工序3:start 路由下推接线", () => {
  const code = codeOnly(startSrc);

  it("⓪ 路由在调用位置接上启动核心(剥掉 import 行再看),且只有一处", () => {
    const routeCode = codeOnly(startRouteSrc).replace(/^\s*import[\s\S]*?;\s*$/gm, "");
    expect((routeCode.match(/startGlueSyncRun\(\{/g) || []).length).toBe(1);
    expect(routeCode).toContain('triggeredBy: "manual"');
    // 搬走的那一段不许在路由里留第二份
    expect(routeCode).not.toContain("StartJobRunCommand");
    expect(routeCode).not.toContain("async function pollGlueJob");
  });

  it("① 模块级 home 单例退役:不再 new 区域客户端 / env 取脚本桶与执行角色", () => {
    expect(code).not.toContain("new GlueClient");
    expect(code).not.toContain("new S3Client");
    expect(code).not.toContain("new S3TablesClient");
    expect(code).not.toContain("new CloudWatchLogsClient");
    expect(code).not.toContain("process.env.GLUE_SCRIPTS_BUCKET");
    expect(code).not.toContain("process.env.GLUE_ROLE_ARN");
    // 客户端一律按落点区取(按 region 缓存的工厂)。
    expect(code).toContain("glueClientFor(landing.region)");
    expect(code).toContain("s3ClientFor(landing.region)");
    expect(code).toContain("s3tablesClientFor(landing.region)");
    expect(code).toContain("logsClientFor(landing.region)");
  });

  it("② 两条 409 接在入口上;SC-5 的旧码从本路由消失(scq SC-5 改判的代码侧事实)", () => {
    expect(code).toContain('"CROSS_REGION_SOURCE"');
    expect(code).toContain('"CHANNEL_NOT_PUSHED_DOWN"');
    expect(code).not.toContain("TARGET_PUSHDOWN_UNAVAILABLE");
    // 跨区判据的两个操作数都来自单一作者(源章字段常量 / 章归一口),不是手写字符串比较。
    // @kf-batch 50-o4REG-sync-om-per-target —— 源章的读法收成单一作者(内部按 DATASOURCE_OWNER_TARGET_ATTR 读)
    expect(code).toContain("datasourceOwnerTarget(ds");
    expect(code).toContain("bindingTargets(task");
  });

  it("③ run 章按真落点显式盖(第二参),建行与收口两处都传", () => {
    expect(code).toContain("resolveRunStamp(task, tid)");
    expect(code).toContain("resolveRunStamp(task, landing.targetId)");
    // 🔴 不带第二参的 resolveRunStamp(task) 在本文件绝迹 —— 同步任务的区维在 targets[],
    // 裸调必然盖 home(改这条判据前先读 run-records.resolveRunStamp 的说明)。
    expect(code).not.toMatch(/resolveRunStamp\(task\)/);
    // 审计也盖真落点。
    expect(code).toContain("targetId: tid");
  });

  // @kf-batch 50-o4REG-sync-om-per-target —— 原判据「OM 回填只在 home 调」随登记 o4-REG 交付**改判**:
  //   坐标按落点由 om-sync-coords 一处算(主控区逐字节不变,其它区进 per-target service),路由不再判区。
  //   行为判据在 lib/openmetadata/__tests__/om-sync-per-target.test.ts(真跑推送,只 mock OM HTTP)。
  it("④ OM 启动推送与成功回填:每个区都推,落点 = 本次执行的 landing/rsb + 源章;路由里不再按 home 分叉", () => {
    expect(code).toContain("syncOmPlaceOf(landing, rsb, dsOwner)");
    expect(code).toContain("pushSyncToOpenMetadata(task, ds as DataSource, omPlace)");
    expect(code).toContain("backfillSyncOmAfterSuccess(om.task, om.ds, om.place)");
    expect(code).not.toContain("if (landing.home) pushSyncToOpenMetadata");
    expect(code).not.toContain("if (landing.home) try {");
    // 主控区口径的四个回填不许再直接出现在路由里(它们的唯一调用方是 backfillSyncOmAfterSuccess 的主控区分支)
    expect(code).not.toContain("pushRedshiftSchemaToOpenMetadata");
    expect(code).not.toContain("repushSyncLineageToOM");
  });
});

describe("WP-7 施工序3:start-realtime(dms)通道卡", () => {
  it("非 home 章任务走 DMS ⇒ 409 CHANNEL_NOT_PUSHED_DOWN(fail-closed,不替它在主控区跑)", () => {
    const code = codeOnly(realtimeSrc);
    expect(code).toContain("boundToHomeOnly(task)");
    expect(code).toContain('"CHANNEL_NOT_PUSHED_DOWN"');
  });
});

// ── 施工序 4:对账 / 下线 / 4 个读路由按章取区 ─────────────────────────────────
// 现状(改前)是坏的:home 客户端查非 home 的 JobRun 必然查不到 ⇒ 对账让任务永卡 running、
// 下线把「没找到」当「已停」(孤儿计费)、日志/状态/输出全空 —— 只是下推前建不出非 home 任务,没人撞上。
const STEP4_FILES: Array<[string, string, string]> = [
  // [名字, 相对 src 的路径, 必须出现的按章取区表达式]
  ["reconcile", "lib/sync/reconcile.ts", "regionOfTarget(tid)"],
  ["teardown", "lib/sync/teardown.ts", "regionOfTarget(tid)"],
  ["glue-status", "app/api/sync/[id]/glue-status/route.ts", "regionOfTarget(tid)"],
  ["logs", "app/api/sync/[id]/logs/route.ts", "regionOfTarget(tid)"],
  ["output", "app/api/sync/[id]/output/route.ts", "regionOfTarget(tid)"],
  ["runs-logs", "app/api/sync/[id]/runs/[runId]/logs/route.ts", "resolveGlueBinding({ targetId:"],
];

describe("WP-7 施工序4:对账/下线/读路由按章取区", () => {
  const srcRoot = join(__dirname, "..", "..", "..");
  for (const [name, rel, anchor] of STEP4_FILES) {
    it(`${name}:模块级 home 客户端绝迹,按章解析`, () => {
      const code = codeOnly(readFileSync(join(srcRoot, rel), "utf8"));
      expect(code, `${name} 又出现了模块级 env 客户端`).not.toMatch(
        /new (GlueClient|S3Client|CloudWatchLogsClient)\(\{ region: process\.env/
      );
      expect(code, `${name} 没按任务/run 的章取区`).toContain(anchor);
    });
  }

  it("reconcile / glue-status 的收口盖章都显式传章(裸 resolveRunStamp(task) 绝迹)", () => {
    for (const rel of ["lib/sync/reconcile.ts", "app/api/sync/[id]/glue-status/route.ts"]) {
      const code = codeOnly(readFileSync(join(srcRoot, rel), "utf8"));
      expect(code, `${rel} 有裸盖章`).not.toMatch(/resolveRunStamp\(task\)/);
    }
  });

  it("teardown:区解析失败必须走 hardFailure(不知道在哪跑 ≠ 没东西可停)", () => {
    const code = codeOnly(readFileSync(join(srcRoot, "lib/sync/teardown.ts"), "utf8"));
    expect(code).toContain('what: "resolveTargetRegion"');
  });
});

// @kf-batch 50-WP7-sync-pushdown(施工序 7 · 段 o4 E-218 抓到的真缺陷)
// 向导在**挂载时**用 initialValue 把 home 的落点值填回去(S3/Redshift 区块是选完 targetType
// 才挂载,比「选源时清空」晚)⇒ 页面上非 home 任务照样显示主控区的桶名。根治 = 前端**一个落点
// 默认值都不给**(留空 = 服务端按该章的描述符解析,唯一作者在 start 路由 / resolveRedshiftBinding)。
describe("WP-7 施工序7:同步向导不持有 home 落点值(E-218 的代码侧棘轮)", () => {
  const srcRoot = join(__dirname, "..", "..", "..");
  const wizard = codeOnly(readFileSync(join(srcRoot, "app/sync/SyncTaskModal.tsx"), "utf8"));

  it("① 落点字段一个 initialValue 都不给(表桶 / workgroup / 库)", () => {
    expect(wizard, "表桶又被预填成 home 的桶名").not.toContain('initialValue="bgp-table-bucket"');
    expect(wizard, "workgroup 又被预填成 home 的 workgroup").not.toContain("initialValue={HOME_WORKGROUP}");
    // 「库」也一样:home 的 dev 在别区可能压根不存在,填错即 409。
    expect(wizard).not.toMatch(/name=\{\["redshiftConfig", "database"\]\}[^\n]*initialValue=/);
  });

  it("② 向导不再引用 home 的 workgroup 常量(前端第二个落点真值源彻底断掉)", () => {
    expect(wizard, "HOME_WORKGROUP 又被 import 回向导了").not.toContain("HOME_WORKGROUP");
  });

  it("③ 不再硬编码 `workgroup=bgp-workgroup` 预拉库清单(那是别区用户会选中的错库)", () => {
    expect(wizard).not.toContain("databases?workgroup=bgp-workgroup");
    // 换源可能换区 ⇒ 上一个区的库清单必须立即作废。
    expect(wizard).toContain("setRsDatabases([])");
  });

  it("④ 详情页「是否 S3 Tables 落点」由 targetType 判,不靠桶名填了没有", () => {
    const detail = codeOnly(readFileSync(join(srcRoot, "app/sync/[id]/page.tsx"), "utf8"));
    expect(detail).toMatch(/isS3Tables\s*=\s*task\.targetType === "s3-tables"/);
  });

  it("⑤ 兄弟路径:OM 同步血缘**回填**也只对 home 任务重放(与 start 路由同一不变量)", () => {
    const lineage = codeOnly(readFileSync(join(srcRoot, "lib/governance/lineage-service.ts"), "utf8"));
    expect(lineage).toMatch(/if \(!isHome\(bindingTargets\(task\)\[0\]\)\) continue;/);
  });
});
