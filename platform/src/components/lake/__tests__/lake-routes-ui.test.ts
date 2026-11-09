// 数据湖表桶路由(设计稿 §6.9)—— 系统设置「数据湖表桶与路由」卡与作业「数据湖表桶」块的**服务端真渲染**判据 + 四处接线。
//   🔴 这是提交前门禁,不是验收:页面功能的验收只认部署后无头浏览器操纵页面(动作在页面做、证据取 DOM / 截图)。
// 判什么:① 首帧(SSR)按 props 渲染出页面判据要抓的 testid 与文案,且首帧零 fetch(水合铁律:浏览器状态挂载后再读);
//   ② 非 admin / 没选执行环境两种空态的文案;③ 示例脚本按引擎读路由图的那一行与 routes-grammar 的保留键同源;
//   ④ 接线:系统设置页 / 离线计算页 / EMR 面板 / 同步向导 / 导览文案真的用了这两块(「写了」≠「接上了」)。
// 真的 I18nProvider(不 mock 兄弟模块):它读 localStorage / 拉 /api/public/locale 都在 effect 里,SSR 不执行。
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import LakeRoutesCard from "@/components/lake/LakeRoutesCard";
import JobLakeBucketsBlock, { lakeExampleSnippet } from "@/components/lake/JobLakeBucketsBlock";
import I18nProvider from "@/lib/i18n/I18nProvider";
import { GLUE_LAKE_CATALOGS_ARG, EMR_LAKE_CATALOGS_CONF, PLATFORM_ROUTE_ALIAS } from "@/lib/lake/routes-grammar";

const h = React.createElement;
const SRC = resolve(__dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(resolve(SRC, rel), "utf8");
const testids = (html: string) => Array.from(html.matchAll(/data-testid="([^"]+)"/g)).map((m) => m[1]).sort();

function ssr(el: React.ReactElement): { html: string; fetches: number } {
  const spy = vi.fn(async () => { throw new Error("SSR 不许发请求"); });
  const orig = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = spy;
  try {
    return { html: renderToStaticMarkup(h(I18nProvider, null, el)), fetches: spy.mock.calls.length };
  } finally {
    (globalThis as { fetch: unknown }).fetch = orig;
  }
}

describe("① LakeRoutesCard 首帧(admin + 已选执行环境)", () => {
  const { html, fetches } = ssr(h(LakeRoutesCard, { targetId: "tgt_home", displayName: "主控区", region: "us-east-1", isPlatformAdmin: true, id: "lake-ext-buckets" }));
  it("零 fetch;根节点 id=lake-ext-buckets + testid settings-lake-ext-buckets;表 / 刷新 / 登记表单的全部 testid 都在(antd Select / Switch / Table 透传已探过)", () => {
    expect(fetches).toBe(0);
    expect(html).toMatch(/<div id="lake-ext-buckets" data-testid="settings-lake-ext-buckets"/);
    expect(testids(html)).toEqual([
      "lake-ext-bucket-table", "lake-route-add", "lake-route-alias-input", "lake-route-bucket", "lake-route-label", "lake-route-namespaces-input",
      "lake-route-reload", "lake-route-table", "lake-route-tier-select", "lake-route-writable-switch", "settings-lake-ext-buckets",
    ]);
  });
  it("标题点名执行环境与区;路由表空态「这个执行环境还没有路由」;登记按钮「登记到 主控区」;不出现非 admin 提示", () => {
    expect(html).toContain("数据湖表桶与路由 · 主控区 (us-east-1)");
    expect(html).toContain("这个执行环境还没有路由");
    expect(html).toContain("登记到 主控区");
    expect(html).toContain("隐式缺省路由(别名固定 s3tablescatalog)");
    expect(html).not.toContain("需要平台管理员");
  });
});

describe("② LakeRoutesCard 两种空态", () => {
  it("非 admin + 没选执行环境:只有表与刷新,没有登记表单;文案「登记 / 修改 / 撤销需要平台管理员(bgp-admin)」与「先在顶栏选中一个执行环境」", () => {
    const { html, fetches } = ssr(h(LakeRoutesCard, { targetId: "", isPlatformAdmin: false }));
    expect(fetches).toBe(0);
    expect(testids(html)).toEqual(["lake-ext-bucket-table", "lake-route-reload", "lake-route-table", "settings-lake-ext-buckets"]);
    expect(html).toContain("登记 / 修改 / 撤销需要平台管理员(bgp-admin)");
    expect(html).toContain("先在顶栏选中一个执行环境");
    expect(html).not.toContain("这个执行环境还没有路由");
  });
});

describe("③ JobLakeBucketsBlock 首帧与示例脚本", () => {
  it("声明了子集 ⇒ 多选 / 每桶读写 / 缺省目录 / 可用目录清单 / 复制示例 / 刷新 全在,access 行带 data-bucket;多区提示原话;零 fetch", () => {
    const { html, fetches } = ssr(h(JobLakeBucketsBlock, { targetId: "tgt_home", engine: "glue", value: { lakeBuckets: [{ bucket: "cust-agg", access: "write" }], defaultCatalogAlias: "agg" }, onChange: () => {}, multiTargetHint: true }));
    expect(fetches).toBe(0);
    expect(testids(html)).toEqual(["job-default-catalog", "job-lake-access", "job-lake-access-list", "job-lake-block", "job-lake-buckets", "job-lake-catalogs-hint", "job-lake-copy-example", "job-lake-reload"]);
    expect(html).toMatch(/data-testid="job-lake-access"[^>]*data-bucket="cust-agg"|data-bucket="cust-agg"[^>]*data-testid="job-lake-access"/);
    expect(html).toContain("作业绑了多个区:这里按第一个区的路由表显示,保存时每个绑定区各按自己的路由表校验");
    expect(html).toContain("本作业可用的目录:");
    expect(html).toContain("复制三段名示例");
    expect(html).toContain("数据湖表桶(不选 = 本区全部路由;选了子集则只注入这些目录、按桶量权限):");
  });
  it("不声明 ⇒ 没有 access 行;不带多区提示", () => {
    const { html } = ssr(h(JobLakeBucketsBlock, { targetId: "tgt_home", engine: "emr", value: {}, onChange: () => {} }));
    expect(testids(html)).not.toContain("job-lake-access-list");
    expect(testids(html)).not.toContain("job-lake-access");
    expect(html).not.toContain("作业绑了多个区");
  });
  it("lakeExampleSnippet:Glue 用 getResolvedOptions 读 bgp_lake_catalogs、EMR 用 spark.conf.get(spark.bgp.lakeCatalogs)—— 键名与 routes-grammar 保留键同源;三段名 INSERT OVERWRITE;缺省目录加两段名说明;无路由回平台别名", () => {
    const routes = [{ alias: "ods" }, { alias: "agg" }];
    const glue = lakeExampleSnippet("glue", routes, "agg");
    expect(glue).toContain(`getResolvedOptions(sys.argv, ["JOB_NAME", "${GLUE_LAKE_CATALOGS_ARG.slice(2)}"])`);
    expect(glue).toContain(`args["${GLUE_LAKE_CATALOGS_ARG.slice(2)}"].split(",")`);
    expect(GLUE_LAKE_CATALOGS_ARG.slice(2)).toBe("bgp_lake_catalogs");
    expect(glue).toContain('spark.sql("INSERT OVERWRITE TABLE agg.<命名空间>.<结果表> SELECT * FROM ods.<命名空间>.<源表>")');
    expect(glue).toContain("# 缺省目录 agg:两段名 <命名空间>.<表> 等价于 agg.<命名空间>.<表>");
    expect(glue).not.toContain("spark.conf.get");
    const emr = lakeExampleSnippet("emr", routes);
    expect(emr).toContain(`spark.conf.get("${EMR_LAKE_CATALOGS_CONF}").split(",")`);
    expect(EMR_LAKE_CATALOGS_CONF).toBe("spark.bgp.lakeCatalogs");
    expect(emr).not.toContain("getResolvedOptions");
    expect(emr).not.toContain("缺省目录");
    const none = lakeExampleSnippet("glue", []);
    expect(none).toContain(`INSERT OVERWRITE TABLE ${PLATFORM_ROUTE_ALIAS}.<命名空间>.<结果表> SELECT * FROM ${PLATFORM_ROUTE_ALIAS}.<命名空间>.<源表>`);
    expect(lakeExampleSnippet("glue", [{ alias: "only" }])).toContain("INSERT OVERWRITE TABLE only.<命名空间>.<结果表> SELECT * FROM only.<命名空间>.<源表>");
  });
});

describe("④ 接线(源码调用点;import 行不算)", () => {
  it("两块的读请求 URL 都带 targetId=(执行范围判据:服务端真读范围)", () => {
    for (const f of ["components/lake/LakeRoutesCard.tsx", "components/lake/JobLakeBucketsBlock.tsx"]) {
      expect(read(f), f).toContain("fetch(`/api/lake-routes?targetId=${encodeURIComponent(targetId)}`)");
    }
  });
  it("系统设置页:Card id=lake-ext-buckets 里挂 LakeRoutesCard,落点 = 执行范围落到的执行环境,身份 = bgp-admin 组", () => {
    const s = read("app/settings/page.tsx");
    expect(s).toContain("const lakeTargetId = landingOfScope(scope);");
    expect(s).toMatch(/<Card id="lake-ext-buckets"[^\n]*>\s*\n\s*<LakeRoutesCard targetId=\{lakeTargetId\} displayName=\{config\?\.displayName\} region=\{config\?\.region\} isPlatformAdmin=\{isPlatformAdmin\} \/>/);
    expect(s).toMatch(/groupsFromToken\(await getToken\(\)\)\.includes\("bgp-admin"\)/);
  });
  it("离线计算页:engine=glue、落点 = 第一个绑定区、值来自 glueConfig.lakeBuckets / defaultCatalogAlias 且 onChange 写回;EMR 面板:engine=emr,保存 payload 带 lakeBuckets / defaultCatalogAlias(不声明 ⇒ null)", () => {
    const etl = read("app/etl-jobs/page.tsx");
    expect(etl).toMatch(/<JobLakeBucketsBlock\s+engine="glue"\s+targetId=\{targets\[0\] \|\| HOME_TARGET\}\s+multiTargetHint=\{targets\.length > 1\}\s+value=\{\{ lakeBuckets: glueCfg\.lakeBuckets, defaultCatalogAlias: glueCfg\.defaultCatalogAlias \}\}\s+onChange=\{\(v\) => setGlueCfg\(\{ \.\.\.glueCfg, lakeBuckets: v\.lakeBuckets, defaultCatalogAlias: v\.defaultCatalogAlias \}\)\}/);
    const emr = read("components/engines/EmrJobPanel.tsx");
    expect(emr).toContain('<JobLakeBucketsBlock engine="emr" targetId={targets[0] || HOME_TARGET} multiTargetHint={targets.length > 1} value={lake} onChange={setLake} />');
    expect(emr).toMatch(/return \{\s*\n\s*script, spec, network, sparkConf: conf,[\s\S]{0,200}lakeBuckets: lake\.lakeBuckets \?\? null,\s*\n\s*defaultCatalogAlias: lake\.defaultCatalogAlias \?\? null,/);
    expect(emr).toContain("const [lake, setLake] = useState<JobLakeDeclarationValue>({ lakeBuckets: job.lakeBuckets, defaultCatalogAlias: job.defaultCatalogAlias });");
  });
  it("同步向导:Table Bucket 下拉带 writeIntent(只列可写路由、未登记标出),extra 文案指路「系统设置 → 数据湖表桶与路由」;导览 /sync /etl-jobs /settings 三页各有一句", () => {
    const sync = read("app/sync/SyncTaskModal.tsx");
    expect(sync).toMatch(/<TableBucketPicker targetId=\{watchDsOwnerTarget\}[^\n]*\bwriteIntent\b[^\n]*data-testid="sync-s3t-bucket-picker"/);
    expect(sync).toContain("须先在「系统设置 → 数据湖表桶与路由」把它登记为可写路由(下拉显示 桶 · 别名 · 分层,只列可写路由)");
    const guide = read("lib/guide/content.ts");
    const section = (page: string) => { const i = guide.indexOf(`\n  "${page}": {`); const j = guide.indexOf("\n  \"/", i + 5); return guide.slice(i, j < 0 ? undefined : j); };
    expect(section("/sync")).toContain("客户自有表桶要先在「系统设置 → 数据湖表桶与路由」登记,主控区与执行区同一规则");
    expect(section("/etl-jobs")).toContain("「高级属性 → 数据湖表桶」");
    expect(section("/settings")).toContain("「数据湖表桶与路由」卡:把客户自己的 S3 Tables 表桶登记为路由");
  });
});
