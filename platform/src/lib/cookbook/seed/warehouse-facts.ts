// @kf-batch 50-B27-codegen-place
// 模块 45 seed — 「Glue / EMR 作业怎么连**本区**数仓」的**唯一作者**(规则文本 + 反例判据)。
//
// 🔴🔴 B-27(2026-10-01 装配层判据当场抓到):配方库原来教所有 AI 生成路径(规划大脑 / Copilot / 作业开发 AI 生成)
//   「workgroup=bgp-workgroup、database=dev 是**平台固定真实值,直接写死**」—— 单区时代的事实,多区后成了**根源**:
//   每一份 AI 写出来的 Glue/EMR 作业都把主控区数仓的工作组实名写进代码 ⇒ 绑到别的区跑,要么那个名字在该区不存在,
//   要么(名字恰好相同时)查的是错的库。而 Glue 那边平台**根本没注入**数仓事实,代码想读也没处读。
// ⇒ 平台在作业参数里注入本区数仓三事实(Glue:`--bgp_redshift_*`;EMR:`spark.bgp.redshift*`,同一组值),
//   配方统一改教「读注入值、不给缺省」,并加一条 warn 级判据把「字面量工作组」标出来(不拦:存量主控区作业照常跑)。

import type { CookbookEngine, DialectRule } from "../types";

/** Glue 作业读本区数仓事实的唯一写法(规则 / 模板 / 提示词共用)。 */
export const GLUE_WAREHOUSE_HOWTO =
  "连接事实一律取**平台注入的作业参数**(本区实名,多区执行时每个区各不相同):" +
  "`args = getResolvedOptions(sys.argv, ['JOB_NAME','ds','bgp_region','bgp_redshift_workgroup','bgp_redshift_database','bgp_redshift_secret_arn'])`," +
  "`boto3.client('redshift-data', region_name=args['bgp_region'])`,`execute_statement(WorkgroupName=args['bgp_redshift_workgroup'], " +
  "Database=args['bgp_redshift_database'], SecretArn=args['bgp_redshift_secret_arn'], Sql=...)`;" +
  "【严禁】把工作组/库名写成字面量(写死 = 所有区都打到同一个区)或写 <your-workgroup> 之类占位符";

/** EMR 作业读本区数仓事实的唯一写法(同一组值,经 Spark conf 注入)。 */
export const EMR_WAREHOUSE_HOWTO =
  "连接事实一律取**平台注入的 Spark conf**(本区实名,**不给缺省值** —— 缺省值就是把别的区写死):" +
  "`spark.conf.get('spark.bgp.region')`、`spark.conf.get('spark.bgp.redshiftWorkgroup')`、" +
  "`spark.conf.get('spark.bgp.redshiftDatabase')`、`spark.conf.get('spark.bgp.redshiftSecretArn')`;" +
  "client 带 region_name、execute_statement 带 SecretArn;【严禁】把工作组/库名写成字面量或写 <your-workgroup> 占位符";

/** 命中 = 代码里把数仓工作组写成了字面量(`WorkgroupName='xxx'` / `WORKGROUP = 'xxx'`)。 */
export const HARDCODED_WORKGROUP_PATTERN = /(?:WorkgroupName\s*=\s*|\bWORKGROUP\s*=\s*)['"][A-Za-z0-9][\w-]*['"]/;

export function hardcodedWarehouseRule(engine: Extract<CookbookEngine, "glue" | "emr">): DialectRule {
  return {
    id: `${engine}.no-hardcoded-warehouse`,
    engine,
    title: "数仓工作组 / 库名不要写成字面量(读平台注入的本区事实)",
    rule: engine === "glue" ? GLUE_WAREHOUSE_HOWTO : EMR_WAREHOUSE_HOWTO,
    antiPattern: HARDCODED_WORKGROUP_PATTERN,
    // 🔴 warn 不是 error:存量主控区作业写死主控区名字是**能跑的**,硬拦会把用户正在用的作业打停;
    //    这条的作用是在生成 / 保存 / 运行前把它标出来(页面「检出 N 处方言问题」),不是改写也不是拦截。
    severity: "warn",
    target: "code",
  };
}
