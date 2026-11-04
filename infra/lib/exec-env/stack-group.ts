// @kf-batch 50-P50.2a-exec-env-stackgroup
// 执行环境**栈组装配**(50 DESIGN §4.1a / SPEC §3.5:`BgpExecEnv-<targetSlug>-*`)。
//
// 【承重不变量,synth-gate 逐条打】
// ① **栈名空间与控制面 23 栈零相交** —— 全部以 `BgpExecEnv-<slug>-` 开头,
//    于是 `cdk deploy 'BgpExecEnv-<slug>-*'` 能精准锁定、**绝不误动控制面**;
// ② **零控制面构造引用** —— 组内自建 VPC/CMK/SG,不吃 home 的任何构造(§4.1a-2);
// ③ **组件条件装配** —— 只实例化勾选了的组件栈,没勾的**根本不存在**(不是建了但停用);
// ④ **栈名经命名 SSOT** —— 不在这里拼字符串(`execEnvStackName` 是唯一出口)。
//
// 🔴 `id` 与 `stackName` 取同一个值:CDK 默认由构造 id 派生 CFN 栈名,
//    两者写成一样才能让 `cdk deploy 'BgpExecEnv-…-*'`(按 id 通配)与真实栈名对得上。
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { execEnvStackName } from "../shared/naming";
import { BASE_STACK_SUFFIX, type ExecEnvContext } from "./context";
import { ExecEnvBaseStack } from "./base-stack";
import { ExecEnvCoreStack } from "./core-stack";
import { ExecEnvRedshiftStack } from "./redshift-stack";
import { ExecEnvDmsStack } from "./dms-stack";
import { ExecEnvFlinkStack } from "./flink-stack";
// @kf-batch 50-W5-seg1-WP10a:residency-api 片 1(区域审计 / 结果存储;跨法域 target 的唯一技术前置)
import { ExecEnvResidencyStack } from "./residency-stack";
// @kf-batch 50-WP13-mwaa-region:每个 target 自己的 MWAA(用户拍板「每个区域的定时任务都是自己区域的 MWAA 执行的」)
import { ExecEnvMwaaStack } from "./mwaa-stack";
// @kf-batch 50-WP15-airflow-serverless:MWAA Serverless 入口(经典 mwaa 保留,两者并列)
import { ExecEnvAirflowServerlessStack } from "./airflow-serverless-stack";

/** 已实现组件栈的组件键(P50.3a 起:core 之外多了三个)。报错文案与门禁都从这里取,免得手抄两份。 */
export const IMPLEMENTED_COMPONENTS = ["core", "redshift", "dms", "flink", "residency-api", "mwaa", "airflow-serverless"] as const;

// @kf-batch 50-WP22-external-components
// 🔴 **由平台自己的栈部署**的组件:描述符可以如实声称它,但它**不属于本栈组的部署面** ⇒ 这里**跳过**,
//    既不建栈也不报错。与 `platform/src/lib/exec-env/implemented-components.ts` 的同名常量由 parity 门禁钉住。
//    (agentcore 由 `BgpAgentCoreStack` 部署;它以前挂在「尚未实现」里,导致装了它的 home
//     连补装别的组件都做不到 —— 见 WORK-PACKAGES WP-22。)
export const EXTERNAL_COMPONENTS = ["agentcore"] as const;

export interface ExecEnvStackGroup {
  base: ExecEnvBaseStack;
  core: ExecEnvCoreStack;
  /** 可选组件栈:**没勾就根本不存在**(不是建了但停用)。 */
  redshift?: ExecEnvRedshiftStack;
  dms?: ExecEnvDmsStack;
  flink?: ExecEnvFlinkStack;
  /** @kf-batch 50-W5-seg1-WP10a residency-api 片 1(区域审计表 / 结果表 / 结果桶) */
  residency?: ExecEnvResidencyStack;
  /** @kf-batch 50-WP13-mwaa-region 本 target 自己的 Airflow(DAG 桶 + 环境 + 执行角色) */
  mwaa?: ExecEnvMwaaStack;
  /** @kf-batch 50-WP15-airflow-serverless 本 target 的 MWAA Serverless 入口(定义桶 + 工作 SG + 执行角色;workflow 由平台按作业建) */
  airflowServerless?: ExecEnvAirflowServerlessStack;
  /** 本次装配出来的全部 CFN 栈名(供 synth-gate 与部署脚本用)。 */
  stackNames: string[];
}

export function createExecEnvStackGroup(scope: Construct, ctx: ExecEnvContext): ExecEnvStackGroup {
  const env = { account: ctx.account, region: ctx.region };
  const stackNames: string[] = [];

  const mk = (component: string) => {
    const name = execEnvStackName(ctx.targetId, component);
    stackNames.push(name);
    return name;
  };

  const baseName = mk(BASE_STACK_SUFFIX);
  const base = new ExecEnvBaseStack(scope, baseName, {
    env,
    stackName: baseName,
    description: `BGP exec-env base (VPC + data-domain CMK) target=${ctx.targetId} region=${ctx.region}`,
    ctx,
  });

  const coreName = mk("core");
  const core = new ExecEnvCoreStack(scope, coreName, {
    env,
    stackName: coreName,
    description: `BGP exec-env core component target=${ctx.targetId} region=${ctx.region}`,
    ctx,
    vpc: base.vpc,
    // @kf-batch 50-W5-seg1-WP3:EMR 执行角色要解密本 target 的桶 / 流 ⇒ core 也吃底座的 CMK
    dataKey: base.dataKey,
  });
  // core 用底座的 VPC ⇒ 显式声明依赖,免得 CDK 只靠隐式引用推导(跨栈引用会生成 Export/ImportValue,
  // 依赖必须显式,否则并行部署时 core 可能先于 base)。
  core.addDependency(base);

  // ── 可选组件(P50.3a 落地 redshift / dms / flink)──────────────────────────
  // 🔴 条件装配:没勾的组件**根本不生成栈**(§4.1a-3)。空壳会让"已支持"的假象进模板与验收。
  const has = (c: string) => ctx.components.includes(c as (typeof ctx.components)[number]);
  const group: ExecEnvStackGroup = { base, core, stackNames };

  if (has("redshift")) {
    const n = mk("redshift");
    group.redshift = new ExecEnvRedshiftStack(scope, n, {
      env,
      stackName: n,
      description: `BGP exec-env redshift component target=${ctx.targetId} region=${ctx.region}`,
      ctx,
      vpc: base.vpc,
      dataKey: base.dataKey,
    });
    // 吃底座的 VPC 与 CMK ⇒ 显式依赖(跨栈引用会生成 Export/ImportValue,依赖必须显式,
    // 否则并行部署时组件栈可能先于 base)。
    group.redshift.addDependency(base);
    // @kf-batch 50-W5-seg1-WP3:COPY 角色策略写的是 core 那两个桶的 ARN ⇒ 与 flink 同理显式依赖 core
    //    (IAM 允许给不存在的资源授权,不声明依赖就可能出现「角色有权限、桶还没有」的窗口)。
    group.redshift.addDependency(core);
  }

  if (has("dms")) {
    const n = mk("dms");
    group.dms = new ExecEnvDmsStack(scope, n, {
      env,
      stackName: n,
      description: `BGP exec-env dms component target=${ctx.targetId} region=${ctx.region}`,
      ctx,
      vpc: base.vpc,
      // @kf-batch 50-W5-seg1-WP3:DMS 角色解密 / 写暂存要 CMK
      dataKey: base.dataKey,
    });
    group.dms.addDependency(base);
    group.dms.addDependency(core); // 同上:角色策略引用 core 的数据湖桶 ARN
  }

  if (has("flink")) {
    const n = mk("flink");
    group.flink = new ExecEnvFlinkStack(scope, n, {
      env,
      stackName: n,
      description: `BGP exec-env flink component target=${ctx.targetId} region=${ctx.region}`,
      ctx,
      dataKey: base.dataKey,
    });
    group.flink.addDependency(base);
    // 🔴 也依赖 core:角色策略里写的是 core 那三个桶(数据湖/脚本/表桶)的 ARN。
    //    IAM 允许给"还不存在的资源"授权 ⇒ 不显式声明依赖的话,flink 可能先于 core 部署完,
    //    于是短暂存在"角色有权限、桶还没有"的窗口,作业启动会以很难懂的方式失败。
    group.flink.addDependency(core);
  }

  if (has("residency-api")) {
    // 🔴 栈名后缀取组件名的 `residency-api` ⇒ `BgpExecEnv-<slug>-residency-api`(与其它组件同规则:后缀 = 组件键)
    const n = mk("residency-api");
    group.residency = new ExecEnvResidencyStack(scope, n, {
      env,
      stackName: n,
      description: `BGP exec-env residency-api component (regional audit + results storage) target=${ctx.targetId} region=${ctx.region}`,
      ctx,
      dataKey: base.dataKey,
    });
    group.residency.addDependency(base);
  }

  if (has("mwaa")) {
    // @kf-batch 50-WP13-mwaa-region
    // 🔴 栈名后缀 = 组件键 `mwaa` ⇒ `BgpExecEnv-<slug>-mwaa`。依赖 base(VPC 子网 / SG)与 core(PassRole 指本 target 的 EMR 角色:
    //    IAM 允许给不存在的资源授权,不声明依赖会出现「角色能 PassRole、被 pass 的角色还没建」的窗口)。
    const n = mk("mwaa");
    group.mwaa = new ExecEnvMwaaStack(scope, n, {
      env,
      stackName: n,
      description: `BGP exec-env mwaa component (per-target Airflow: DAG bucket + environment + execution role) target=${ctx.targetId} region=${ctx.region}`,
      ctx,
      vpc: base.vpc,
    });
    group.mwaa.addDependency(base);
    group.mwaa.addDependency(core);
  }

  if (has("airflow-serverless")) {
    // @kf-batch 50-WP15-airflow-serverless
    // 🔴 栈名后缀 = 组件键 ⇒ `BgpExecEnv-<slug>-airflow-serverless`。依赖 base(VPC / SG)与 core(PassRole 指本 target 的 EMR / Glue 角色)。
    const n = mk("airflow-serverless");
    group.airflowServerless = new ExecEnvAirflowServerlessStack(scope, n, {
      env,
      stackName: n,
      description: `BGP exec-env airflow-serverless component (MWAA Serverless entry: workflow bucket + worker SG + execution role) target=${ctx.targetId} region=${ctx.region}`,
      ctx,
      vpc: base.vpc,
    });
    group.airflowServerless.addDependency(base);
    group.airflowServerless.addDependency(core);
  }

  // ── 仍未实现的组件(kafka)────────────────
  // 勾了却还没实现的组件必须**显式报错**,不许静默少装(那正是 §4.1a 要防的"以为装了")。
  // @kf-batch 50-WP22-external-components
  // 🔴 但 **external 组件要跳过**(不是「未实现」):它由平台自己的栈部署,描述符如实声称它是对的,
  //    而这个集合会原样从 broker 落成 `EXEC_ENV_COMPONENTS` ⇒ 在这里报错等于让 CodeBuild 中途炸。
  const notYet = ctx.components.filter(
    (c) => !(IMPLEMENTED_COMPONENTS as readonly string[]).includes(c) && !(EXTERNAL_COMPONENTS as readonly string[]).includes(c)
  );
  if (notYet.length > 0) {
    throw new Error(
      `执行环境栈组收到未实现的组件:${notYet.join(", ")} —— ` +
        `已实现:${IMPLEMENTED_COMPONENTS.join(", ")};其余组件随后续批次落地` +
        `(kafka 要常驻计费资源,单独一批;residency-api 片 1 已于 WP-10a 落地,mwaa 已于 WP-13 落地,airflow-serverless 已于 WP-15 落地;agentcore 由平台自己的栈部署 ⇒ 归 EXTERNAL_COMPONENTS,本栈组跳过它)。` +
        `🔴 这里选择**报错**而不是静默忽略:静默忽略 = 描述符声称装了某组件、实际没有资源,` +
        `到下推任务时才在很远的地方炸。`
    );
  }

  for (const s of [base, core, group.redshift, group.dms, group.flink, group.residency, group.mwaa, group.airflowServerless]) {
    if (s) cdk.Tags.of(s).add("bgp:targetId", ctx.targetId);
  }

  return group;
}
