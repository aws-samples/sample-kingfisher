// 数据湖表桶路由的两条棘轮 + 四入口接线(源码字面判据;「写了」≠「接上了」):
//   ① `spark.sql.catalog.` 字面只许出现在唯一作者 lib/lake/routes.ts(注入)与三处**用户脚本范例文案**(配方库 / 诊断证据,不是平台注入);
//      改动前 job-service.ts / start-run.ts / emr/spec.ts 各手写一份 ⇒ 多一条路由就得改三处,漏一处 = 那条路仍只认平台表桶。
//   ② 平台代码不再读 EMR_S3TABLES_WAREHOUSE_ARN(恒指主控区平台表桶);warehouse 由作业被选中的路由派生。
//   ③ 四入口(Glue 作业 / EMR 提交 · 扇出 · 工作流节点 / 同步启动 / Flink)都按路由解析并把被选中的路由交给预检(lakeRoutes)。
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const SRC = resolve(__dirname, "../../..");
const rel = (abs: string) => abs.slice(SRC.length + 1);
const codeOnly = (abs: string) =>
  readFileSync(abs, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => {
    const t = l.trim();
    if (t.startsWith("//") || t.startsWith("*")) return "";
    const i = l.indexOf("//");
    return i >= 0 ? l.slice(0, i) : l;
  }).join("\n");
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { if (e !== "__tests__" && e !== "__golden__" && e !== "node_modules") walk(p, out); }
    else if (/\.tsx?$/.test(e)) out.push(p);
  }
  return out;
}
const PRODUCT = walk(SRC);

describe("① spark.sql.catalog. 字面棘轮", () => {
  const ALLOWED = [
    "lib/lake/routes.ts", // 唯一作者
    "lib/cookbook/seed/emr.ts", // 配方库里给 AI / 用户看的脚本范例(文案),不是平台注入
    "lib/cookbook/seed/s3tables.ts",
    "lib/diagnostics/evidence.ts", // 诊断证据的模式串
  ];
  it("出现过该字面的产品源文件 ⊆ 允许清单,且唯一作者里真有它(反向控制)", () => {
    const hits = PRODUCT.filter((f) => codeOnly(f).includes("spark.sql.catalog.")).map(rel).sort();
    expect(hits.filter((f) => !ALLOWED.includes(f)), "新出现的 spark.sql.catalog. 手写字面 —— 请改走 lib/lake/routes.ts#sparkCatalogConf").toEqual([]);
    expect(hits).toContain("lib/lake/routes.ts");
  });
  it("三个注入点各自调唯一作者,不再内联目录属性", () => {
    expect(codeOnly(join(SRC, "lib/etl/job-service.ts"))).toMatch(/sparkCatalogConf\(lake\.selected, \{ engine: "glue", account, defaultAlias: lake\.defaultAlias \}\)/);
    expect(codeOnly(join(SRC, "lib/sync/start-run.ts"))).toMatch(/sparkCatalogConf\(\[lakeRoute\], \{ engine: "glue", account: process\.env\.AWS_ACCOUNT_ID \?\? "" \}\)/);
    expect(codeOnly(join(SRC, "lib/engines/emr/job-spec.ts"))).toMatch(/sparkCatalogConf\(routes, \{ engine: "emr", account: opts\.account, defaultAlias: opts\.defaultAlias \}\)/);
    for (const f of ["lib/etl/job-service.ts", "lib/sync/start-run.ts", "lib/engines/emr/spec.ts", "lib/engines/emr/job-spec.ts"]) {
      expect(codeOnly(join(SRC, f)), f).not.toContain("catalog-impl=");
    }
  });
});

describe("② 不再读 EMR_S3TABLES_WAREHOUSE_ARN;S3TABLES_WAREHOUSE_ARN 导出已删", () => {
  it("平台源码零读点(只许留在注释里)", () => {
    const readers = PRODUCT.filter((f) => /EMR_S3TABLES_WAREHOUSE_ARN|S3TABLES_WAREHOUSE_ARN\b/.test(codeOnly(f))).map(rel);
    expect(readers).toEqual([]);
  });
});

describe("②b 升级脚本:主控区 EMR / Flink 栈随升级刷新(角色 s3tables 面「本区任意表桶」要能落到存量环境)", () => {
  // 2026-11-06 测试账号真撞:redeploy-platform.sh 只部署平台栈及其 CDK 依赖,BgpEmrStack / BgpFlinkStack 是 -c 门控的可选栈、平台栈不依赖它们 ⇒
  //   升级后两栈 LastUpdatedTime 停在安装日,主控区 EMR 作业 / Flink sink 写客户自有表桶仍 AccessDenied(设计稿 §8「Deployment」要求 home 升级覆盖两栈)。
  it("2f 步:对 BgpEmrStack / BgpFlinkStack 先 describe-stacks 存在才 cdk deploy、--exclusively、带各自的 -c enable-emr=1 / enable-flink=1 门控、失败 die;位于 2c‴ 之后、第 3 步平台栈之前", () => {
    const REPO = resolve(SRC, "../..");
    const rp = readFileSync(join(REPO, "scripts/redeploy-platform.sh"), "utf8");
    expect(rp).toMatch(/for pair in "BgpEmrStack:enable-emr" "BgpFlinkStack:enable-flink"; do/);
    expect(rp).toMatch(/if aws cloudformation describe-stacks --stack-name "\$stack" --profile "\$PROFILE" --region "\$REGION" >\/dev\/null 2>&1; then\n\s+npx cdk deploy "\$stack" --exclusively --require-approval never --profile "\$PROFILE" -c "\$flag=1" \\\n\s+\|\| die "\$stack 部署失败/);
    expect(rp).toMatch(/else\n\s+info "\s+\$stack 不存在/);
    const i2f = rp.indexOf('say "2f) 主控区 EMR / Flink 栈');
    expect(i2f).toBeGreaterThan(rp.indexOf('node "$HERE/lib/lake-routes-migrate.mjs"'));
    expect(i2f).toBeLessThan(rp.indexOf("npx cdk deploy BgpPlatformStack --require-approval never"));
    // 门控名必须与 infra/bin/app.ts 的 tryGetContext 同字面(改一处不改另一处 ⇒ 这里红)
    const app = readFileSync(join(REPO, "infra/bin/app.ts"), "utf8");
    expect(app).toMatch(/tryGetContext\("enable-emr"\) === "1"/);
    expect(app).toMatch(/tryGetContext\("enable-flink"\) === "1"/);
  });
});

describe("③ 四入口接线:按路由解析 + 被选中的路由交给预检", () => {
  it("Glue 作业:ensureGlueJob 经 resolveJobLakeRoutes(按落点)并把 lake.selected 交给预检;--bgp_lake_catalogs 是保留键且真注入", () => {
    const code = codeOnly(join(SRC, "lib/etl/job-service.ts"));
    expect(code).toMatch(/const lake = await resolveJobLakeRoutes\(landing\.targetId, normalizeLakeDeclaration\(job\.glueConfig\), \{ landing \}\)/);
    expect(code).toMatch(/lakeRoutes: lake\.selected/);
    expect(code).toMatch(/\[GLUE_LAKE_CATALOGS_ARG\]: lakeCatalogsArgument\(lake\.selected\)/);
    expect(code).toMatch(/GLUE_LAKE_CATALOGS_ARG,\s*\n/); // 在 RESERVED_ARGS 里
    expect(code).toMatch(/rejectUserCatalogConf\(splitGlueConfValue\(String\(v\)\), lake\.selected/);
    expect(code).toMatch(/assertGlueConfBudget\(defaultArgs\["--conf"\]\)/);
  });
  it("EMR:提交 / 扇出 / 工作流节点三条路都经 emrLakeRoutesFor 并把 lake.selected 交给预检;spark 参数经 emrSparkSubmitParametersFor 带 lake", () => {
    for (const f of ["lib/engines/emr/provider.ts", "lib/engines/emr/schedule-fanout.ts", "lib/workflow/job-node-prepare.ts", "lib/workflow/job-node-spec.ts"]) {
      expect(codeOnly(join(SRC, f)), f).toMatch(/await emrLakeRoutesFor\(/);
    }
    for (const f of ["lib/engines/emr/provider.ts", "lib/engines/emr/schedule-fanout.ts", "lib/workflow/job-node-prepare.ts"]) {
      expect(codeOnly(join(SRC, f)), f).toMatch(/lakeRoutes: lake\.selected/);
    }
    expect(codeOnly(join(SRC, "lib/engines/emr/schedule-fanout.ts"))).toMatch(/emrSparkSubmitParametersFor\(job, landing, s3tJar, await emrRedshiftFactsFor\(targetId\), lake\)/);
    expect(codeOnly(join(SRC, "lib/engines/emr/job-spec.ts"))).toMatch(/emrS3TablesCatalogParameters\(s3tJar, lake\.selected, \{ account, defaultAlias: lake\.defaultAlias \}\)/);
    expect(codeOnly(join(SRC, "lib/engines/emr/spec.ts"))).toMatch(/EMR_LAKE_CATALOGS_CONF,\s*\n\]\)/); // 保留键
  });
  it("同步启动:路由判定前移(tableBucketRejection → effectiveLakeRoute),写 S3 Tables 的任务按该路由 write 量预检,脚本目录别名 = 路由别名", () => {
    const code = codeOnly(join(SRC, "lib/sync/start-run.ts"));
    expect(code).toMatch(/lakeRoutes: writeS3 \? \[\{ \.\.\.lakeRoute, access: "write" \}\] : \[\]/);
    expect(code).toMatch(/generateGlueScript\(task, ds as DataSource, \{ landing, rsb, lakeCatalogAlias: lakeRoute\.alias \}\)/);
    const gen = codeOnly(join(SRC, "lib/sync/glue-script-generator.ts"));
    expect(gen).toMatch(/lakeCatalogAlias: string;/); // 必填,不是可选
    expect(gen).toMatch(/LAKE_ALIAS_RE\.test\(/);
  });
  it("Flink:SQL 真写 S3 Tables sink 才按平台路由 write 量(flinkLakeRoutesFor);预检入口把它交给 lakeRoutes", () => {
    const svc = codeOnly(join(SRC, "lib/realtime/flink-service.ts"));
    expect(svc).toMatch(/flinkLakeRoutesFor\(/);
    expect(svc).toMatch(/lakeRoutes: flinkLakeRoutesFor\(/);
  });
  it("预检入口:execution-role/preflight 把 lakeRoutes 派生成探针交给 preflightRole(extraProbes);role-advisor/preflight 把 extraProbes 并进必备清单并给第 ④ 条出路", () => {
    expect(codeOnly(join(SRC, "lib/execution-role/preflight.ts"))).toMatch(/extraProbes: lakeRouteProbes\(input\.lakeRoutes \?\? \[\], \{ engine: input\.engine, account \}\)/);
    const ra = codeOnly(join(SRC, "lib/role-advisor/preflight.ts"));
    expect(ra).toMatch(/\.\.\.\(opts\.extraProbes \?\? \[\]\)/);
    expect(ra).toMatch(/g\.sid\.startsWith\(LAKE_ROUTE_SID_PREFIX\)/);
    expect(ra).toContain("④ 数据湖表桶权限不够");
  });
  it("保存路由:etl-jobs / engines 的 POST 与 PUT 都按每个绑定区校验声明(checkLakeDeclarationForTargets),拒因经 lakeRouteErrorResponse 带 code", () => {
    for (const f of ["app/api/etl-jobs/route.ts", "app/api/etl-jobs/[id]/route.ts", "app/api/engines/[engine]/route.ts", "app/api/engines/[engine]/[id]/route.ts"]) {
      const code = codeOnly(join(SRC, f));
      expect(code, f).toMatch(/await checkLakeDeclarationForTargets\(\{/);
      expect(code, f).toMatch(/lakeRouteErrorResponse\(e\)/);
    }
    // 运行路径把 LakeRouteError 归「用户可修 ⇒ 被拒」
    expect(codeOnly(join(SRC, "app/api/etl-jobs/[id]/run/route.ts"))).toMatch(/e instanceof LakeRouteError/);
    expect(codeOnly(join(SRC, "lib/engines/long-ops.ts"))).toMatch(/e instanceof LakeRouteError/);
  });
  it("读面:Athena 侧薄壳只经路由作者(resolveLakeRoutes / routeForNamespace),不再 `return places[0]` 回落;候选清单带路由元数据", () => {
    const s3t = codeOnly(join(SRC, "lib/athena/s3tables.ts"));
    expect(s3t).toMatch(/const route = await routeForNamespace\(targetId, namespace\)/);
    expect(s3t).not.toMatch(/return places\[0\]/);
    expect(s3t).not.toMatch(/listExternalTableBuckets/);
    const cand = codeOnly(join(SRC, "lib/lake/table-bucket-candidates.ts"));
    expect(cand).toMatch(/resolveLakeRoutes\(place\.targetId, \{ fresh: true \}\)/);
    expect(cand).toMatch(/alias: route\.alias, tier: route\.tier, writable: route\.writable/);
  });
});
