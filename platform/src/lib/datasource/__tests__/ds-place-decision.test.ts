// @kf-batch 50-WP31-place-first-class 序 31 二刀 ⑤ —— 数据源落点的决策记账 + 接缝调用点判据。
// 【缺陷原形】测试账号 observe 未归因榜:`ec2 / secretsmanager / glue / rds … /api/datasources`(建源)、
//   `secretsmanager.GetSecretValue /api/datasources/<id>/tables`(浏览表)、`glue.GetJobRun /api/datasources`(发现推进)、
//   `s3 … /s3-external`、`rds / secretsmanager … /api/datasources/discover`、`secretsmanager.DeleteSecret /api/internal/dataplane-jobs/step`
//   —— 客户端全建对了区,账本上一笔决策都没有(主控区源在 resolveDsPlace 的早退分支里连 resolveGlueBinding 那笔都没有)。
// 零 mock:主控区路径不碰外部;接缝用源码字面(「写了」≠「接上了」—— 调用点必须存在)。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveDsPlace, noteDatasourceRowPlace, DS_PLACE_VIA, DS_ROW_PLACE_VIA } from "@/lib/datasource/ds-place";
import { __setRequestStoreProvider, decisionsOfCurrentRequest } from "@/lib/place/context";

const SRC = resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(resolve(SRC, rel), "utf8");

let store: object;
beforeEach(() => {
  store = {};
  __setRequestStoreProvider(() => store);
});
afterEach(() => __setRequestStoreProvider(null));

describe("resolveDsPlace 记落点决策", () => {
  it("主控区:回 home 之前就记 {tgt_home, resolveDsPlace}(早退分支此前一笔都不记)", async () => {
    const p = await resolveDsPlace("tgt_home");
    expect(p.home).toBe(true);
    expect(decisionsOfCurrentRequest().decisions).toEqual([{ targetId: "tgt_home", via: DS_PLACE_VIA }]);
  });
  it("非法 id 抛在记账之前(它不是一个落点)", async () => {
    await expect(resolveDsPlace("nope")).rejects.toThrow(/非法 targetId/);
    expect(decisionsOfCurrentRequest().decisions).toEqual([]);
  });
  it("请求外(泵 / reconciler)调用:不抛、不记", async () => {
    __setRequestStoreProvider(() => undefined);
    await resolveDsPlace("tgt_home");
    expect(decisionsOfCurrentRequest().decisions).toEqual([]);
  });
});

describe("noteDatasourceRowPlace 按行上的章记账", () => {
  it("有章 ⇒ 记该 target;无章(存量源)⇒ 主控区(与 datasourceOwnerTarget 同一读法)", () => {
    noteDatasourceRowPlace({ ownerTargetId: "tgt_usw2_a" });
    noteDatasourceRowPlace({});
    expect(decisionsOfCurrentRequest().decisions).toEqual([
      { targetId: "tgt_usw2_a", via: DS_ROW_PLACE_VIA },
      { targetId: "tgt_home", via: DS_ROW_PLACE_VIA },
    ]);
  });
  it("章非法 ⇒ 不抛、不记(业务路径自己的 targetOfStamp 会抛可读错误)", () => {
    expect(() => noteDatasourceRowPlace({ ownerTargetId: "garbage" })).not.toThrow();
    expect(() => noteDatasourceRowPlace(null)).not.toThrow();
    expect(decisionsOfCurrentRequest().decisions.filter((d) => d.via === DS_ROW_PLACE_VIA).length).toBe(1); // null ⇒ 无章 = 主控区
  });
});

describe("接缝:每条「按行做事」的路径在第一个 AWS 调用之前调了记账(源码调用点,不是 import)", () => {
  const CALLERS = [
    "app/api/datasources/[id]/tables/route.ts",
    "app/api/datasources/[id]/schemas/route.ts",
    "app/api/datasources/[id]/route.ts",
    "lib/datasource/reachability-probe.ts",
    "lib/datasource/glue-reach.ts",
    "lib/datasource/long-ops.ts",
  ];
  it.each(CALLERS)("%s 含 noteDatasourceRowPlace( 调用", (rel) => {
    const src = read(rel);
    expect(src).toMatch(/\bnoteDatasourceRowPlace\(/);
    expect(src).toMatch(/import \{[^}]*\bnoteDatasourceRowPlace\b[^}]*\} from "@\/lib\/datasource\/ds-place"/);
  });
  it("reachability-probe:两个入口各记一笔(检测 / 建源收口)", () => {
    expect(read("lib/datasource/reachability-probe.ts").match(/\bnoteDatasourceRowPlace\(row\)/g)?.length).toBe(2);
  });
  // 2026-10-23 …9435 升到 3eed4c4 后 observe 复验:`glue.GetJobRun /api/datasources` 仍未归因 —— 列表 GET 经 settleGlueProbeRows →
  //   readGlueProbe → readDiscovery 打 GetJobRun,而此前只在 advanceDiscovery 记了一笔。glue-reach 三个打 Glue 的入口都要在第一个 await 之前记。
  it("glue-reach:advanceDiscovery / startGlueProbe / readGlueProbe 三个入口各记一笔,且都是函数体第一条语句", () => {
    const src = read("lib/datasource/glue-reach.ts");
    expect(src.match(/\bnoteDatasourceRowPlace\(ds\)/g)?.length).toBe(3);
    for (const fn of ["advanceDiscovery", "startGlueProbe", "readGlueProbe"]) {
      const m = new RegExp(`export async function ${fn}\\([^)]*\\)[^{]*\\{\\s*\\n\\s*noteDatasourceRowPlace\\(ds\\);`).exec(src);
      expect(m, `${fn} 的第一条语句必须是 noteDatasourceRowPlace(ds)`).toBeTruthy();
    }
    // 列表 / 单条 / 心跳 GET 推进「验证中」行的唯一作者确实经 readGlueProbe(接缝在 glue-reach 一处,不在三个路由各写一遍)
    expect(read("lib/datasource/glue-probe-settle.ts")).toMatch(/\bawait readGlueProbe\(/);
  });
  it("[id] 路由:PUT 在 getSecret 之前、DELETE 在清理之前各一笔", () => {
    const src = read("app/api/datasources/[id]/route.ts");
    expect(src.match(/\bnoteDatasourceRowPlace\((cur|Item)\)/g)?.length).toBe(2);
    expect(src.indexOf("noteDatasourceRowPlace(cur)")).toBeLessThan(src.indexOf("await getSecret(cur.secretArn)"));
  });
  it("discover 路由点名落点(requestedTargetId ⇒ 缺即 400)并经 resolveDsPlace 解析;建源弹窗把 landingTargetId 传过去", () => {
    const route = read("app/api/datasources/discover/route.ts");
    expect(route).toMatch(/requestedTargetId\(req\.nextUrl\.searchParams\.get\("targetId"\)/);
    expect(route).toMatch(/resolveDsPlace\(/);
    expect(route).not.toMatch(/discoverRdsInstances\(\)/);
    expect(read("app/datasources/DataSourceModal.tsx")).toMatch(/\/api\/datasources\/discover\?targetId=\$\{encodeURIComponent\(landingTargetId\)\}/);
  });
  it("回收作业步(删该区 secret)与网络顾问 L1 探测各记一笔决策", () => {
    const reclaim = read("lib/exec-env/project-cred-reclaim.ts");
    expect(reclaim).toMatch(/notePlaceDecision\(\{ targetId: job\.targetId, via: PROJECT_CRED_RECLAIM_VIA \}\)/);
    expect(reclaim.indexOf("notePlaceDecision({ targetId: job.targetId")).toBeLessThan(reclaim.indexOf("await getTargetRaw(job.targetId)"));
    const probe = read("lib/network-advisor/environment-probe.ts");
    // @kf-batch 41-B115-netadvisor-place —— 序 31 二刀 ⑤ 时这里记的是「主控区 + homeReason」(如实记);B-115 根治后记**请求落点本身**(req.targetId),再没有 homeReason
    expect(probe).toMatch(/notePlaceDecision\(\{ targetId: req\.targetId, via: NETWORK_ADVISOR_PROBE_VIA \}\)/);
    expect(probe, "B-115 根治后不许再回到「探测恒主控区」").not.toMatch(/homeReason:\s*"network-advisor/);
  });
});
