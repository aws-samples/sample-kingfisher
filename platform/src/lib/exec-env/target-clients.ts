// per-target 的 Redshift 客户端与数仓落点 —— **唯一出口**(50 SPEC §3.9a 第 8 步 / §3.4 / S10)。
//
// ── 为什么必须新建这个文件 ────────────────────────────────────────────────────
// 50 SPEC S10 说的 `getClient(region)` 工厂**在本仓并不存在**(实测:12 处各自
// `new RedshiftDataClient({ region: process.env.AWS_REGION })`)。而 §3.9a 第 8 步要求
// 「在**该 target 的** workgroup/database 执行」—— 客户端的 region 必须来自 target 描述符,
// 不能来自进程 env。没有这个出口,执行器就只能把 `process.env.AWS_REGION` 再抄一遍,
// 于是"给 us-west-2 的 target 建 schema"会**静默打到 home**(不报错、看起来正常)。
//
// 🔴 **本批只给执行器与供给层用,不去动那 12 处**(那是数据面的活)。
//    刻意如此:那 12 处是 execute/GenBI/建模/质量/指标的热路径,顺手改它们
//    等于把 验收面扩到整条数据面 —— 但**落点已经在这里备好**,
//    接线时不需要再造第二个工厂。
//
// 🔴 **home 逐字节等价**:home 的 workgroup/database 仍走 `warehouse-location`
//    (env → 命名 SSOT 的三级兜底,已钉住);region 仍是 `process.env.AWS_REGION`。
//    非 home 才从描述符 `resources` 袋取 —— 这是 `warehouse-location.ts` 文件头立的规矩:
//    「非 home 的落点**不能从 env 猜**,必须来自该 target 描述符的实名资源袋」。

import { homeRegion as readHomeRegion } from "@/lib/place/home-region";
// 观测模式的落点决策记账(只记录;必须在第一个 await 之前调,见 place/context.ts)
import { notePlaceDecision } from "@/lib/place/context";
import {
  RedshiftDataClient,
  ExecuteStatementCommand,
  DescribeStatementCommand,
} from "@aws-sdk/client-redshift-data";
import type { ExecutionTarget } from "@/lib/exec-env/registry";
import { HOME_TARGET_ID, isHome } from "@/lib/exec-env/target-id";
import { homeDatabase, homeWorkgroup } from "@/lib/redshift/warehouse-location";
// 执行角色键的单一作者(SPEC v3.21 §3.1a 规则 ①)
import { assertPerTargetExecRole, roleNameOfArn } from "@/lib/exec-env/exec-roles";
// 角色名的唯一真值源(不在这里拼字符串)
import { resourceName } from "@/lib/aws/naming";
// 构造 + 按区缓存 + 越区断言收到唯一工厂;本文件的 xxxClientFor 只是薄委托(调用方不改)
import { dynamoDocClient, redshiftDataClient, regionalClient, __resetClients } from "@/lib/aws/clients";

/** 某个执行目标的 Redshift 落点(region 也是落点的一部分 —— 少了它就是跨区静默执行)。 */
export interface TargetWarehouse {
  targetId: string;
  region: string;
  workgroup: string;
  database: string;
}

function requireStringResource(t: Pick<ExecutionTarget, "targetId" | "resources">, key: string): string {
  const v = (t.resources ?? {})[key];
  if (typeof v !== "string" || !v.trim()) {
    throw new Error(
      `target ${t.targetId} 的描述符 resources 袋里没有 ${key} —— 拒绝。` +
        `非 home 的数仓落点必须来自实名资源袋(50 SPEC §1.1),猜错的后果不是报错,` +
        `而是"看起来正常地连到了别的区域"`
    );
  }
  return v;
}

/**
 * 解析某个执行目标的数仓落点。
 *
 * home ⇒ 与改动前逐字节等价(env → 命名 SSOT);非 home ⇒ 三项都取自描述符,缺一即拒。
 * 🔴 刻意**没有** `?? home` 兜底:那是外部审核 P0-4 抓过的 fail-open 形状(要 A 给了 B 的连接信息)。
 */
export function resolveTargetWarehouse(t: ExecutionTarget): TargetWarehouse {
  if (isHome(t.targetId)) {
    return {
      targetId: t.targetId,
      region: readHomeRegion(),
      workgroup: homeWorkgroup(),
      database: homeDatabase(),
    };
  }
  const region = typeof t.region === "string" && t.region.trim() ? t.region : "";
  if (!region) {
    throw new Error(`target ${t.targetId} 的描述符没有 region —— 拒绝(位置属性缺失不得回落 home)`);
  }
  return {
    targetId: t.targetId,
    region,
    workgroup: requireStringResource(t, "redshiftWorkgroup"),
    database: requireStringResource(t, "redshiftDatabase"),
  };
}

/**
 * 某个执行目标的 **Spark 侧落点**(Glue / EMR Serverless 共用)。
 *
 * 🔴 为什么与数仓落点分开:Glue/EMR 不碰 workgroup/secret,它们要的是
 * **脚本桶 / 执行角色 / 产物桶 / S3Tables 桶**。把两者混成一个结构会逼着调用方
 * 传一堆用不上的东西,而"用不上的字段"最后总会被人拿去做默认值(那就是回落 home 的口子)。
 */
export interface TargetSparkLanding {
  targetId: string;
  region: string;
  /** 脚本/jar 落哪个桶(Glue ScriptLocation、EMR entryPoint 都在这里) */
  scriptsBucket: string;
  /** 作业执行角色(Glue Role / EMR executionRole) */
  roleArn: string;
  /** 数据/日志落点 */
  datalakeBucket: string;
  /** S3 Tables 桶(注入 iceberg catalog 用) */
  tableBucket: string;
  home: boolean;
}

/**
 * 解析某个执行目标的 Spark 落点。
 *
 * home ⇒ **与改动前逐字节等价**(全部走既有 env,连缺省值都照抄 `job-service.ts` 原样);
 * 非 home ⇒ 四样全取描述符实名资源袋,缺一即拒(不猜、不回落 —— 猜错的后果是
 * "脚本上传到 home 的桶、作业在 us-west-2 找不到它",或者更糟:**产物写回了 home**)。
 */
export function resolveTargetGlue(t: ExecutionTarget): TargetSparkLanding {
  if (isHome(t.targetId)) {
    const acct = process.env.AWS_ACCOUNT_ID || "";
    return {
      targetId: t.targetId,
      region: readHomeRegion(),
      scriptsBucket: process.env.GLUE_SCRIPTS_BUCKET || `bgp-glue-scripts-${acct}`,
      roleArn: process.env.GLUE_ROLE_ARN || "",
      datalakeBucket: process.env.EMR_LOG_BUCKET || `bgp-datalake-${acct}`,
      tableBucket: process.env.S3TABLES_BUCKET || "bgp-table-bucket",
      home: true,
    };
  }
  const region = typeof t.region === "string" && t.region.trim() ? t.region : "";
  if (!region) {
    throw new Error(`target ${t.targetId} 的描述符没有 region —— 拒绝(位置属性缺失不得回落 home)`);
  }
  return {
    targetId: t.targetId,
    region,
    scriptsBucket: requireStringResource(t, "scriptsBucket"),
    // 🔴 (SPEC v3.21 §6.1 段二):非 home 的 Glue 角色必须是**本 target 自己的**(角色名 = 命名 SSOT 的
    //    `BgpExecEnv-<slug>-glue-role`)。那阵子描述符里存的是 home 的 `bgp-glue-role` —— 现在那种值在这里
    //    **fail-closed 并指路**(重新部署以切换角色),而不是继续拿共享角色去别的区跑(IR-P1-03 横移)。
    roleArn: assertPerTargetExecRole(t, "glueRoleArn"),
    datalakeBucket: requireStringResource(t, "datalakeBucket"),
    tableBucket: requireStringResource(t, "tableBucket"),
    home: false,
  };
}

/** 某个执行目标的 **EMR Serverless 执行角色**(与 Spark 落点分开:只有提交 / 发布 DAG 需要它)。 */
export interface TargetEmrExecution {
  targetId: string;
  /** 作业执行角色 ARN;home 可能为空串(env 未配)—— 调用方按原样报「未配置」 */
  executionRoleArn: string;
  home: boolean;
}

/**
 * 解析某个执行目标的 EMR 执行角色。
 *
 * home ⇒ **与改动前逐字节等价**:`process.env.EMR_EXECUTION_ROLE_ARN || ""`(原 `provider.ts` / 调度路由的模块级常量搬到这里,
 *   该 env 字面从此**只许**出现在本文件 —— wiring-guard 钉);
 * 非 home ⇒ 描述符 `resources.emrExecutionRoleArn`,且角色名必须是本 target 的 SSOT 名(缺 / 不对即抛、**不回落** home 角色:
 *   回落 = 拿 home 的执行身份去别的区跑,正是 SPEC §6.1 要消灭的共享形态)。
 */
/**
 * **MSAF(Flink)提交落点**的执行角色。
 *
 * 🔴 为什么单独一个出口而不是塞进 `resolveTargetGlue`:Flink 用的是 `kinesisanalytics.amazonaws.com`
 * 信任的**另一个角色**(per-target 栈 `ExecEnvFlinkStack` 建的 `BgpExecEnv-<slug>-flink-role`)。
 * 把它并进 Spark 落点会多出一个「用不上的字段」,而用不上的字段最后总会被人拿去当默认值 ——
 * 拿 Glue 角色去建 MSAF 应用会在 CreateApplication 那一步 AccessDenied,而界面上只看到「启动失败」。
 */
export interface TargetFlinkExecution {
  targetId: string;
  serviceRoleArn: string;
}

// 收尾:🔴 **主控区也读描述符**(原来主控区分支直接回
//   `process.env.FLINK_RUNTIME_ROLE_ARN`,一次都不核「主控区的描述符里有没有 flink 角色、是不是那个名字」)。
//   主控区描述符的 `flinkRoleArn` 由 seed-home 按 SSOT 名 `bgp-flink-role` 真查 IAM 写入(与原 env 同一个角色 ⇒ 值不变),
//   名字校验对主控区同样成立(SSOT home 模板就是 `bgp-flink-role`)。入参只要 `targetId + resources`
//   ⇒ 已解析的 `Place` 与原始描述符都能直接传。
export function resolveTargetFlink(t: Pick<ExecutionTarget, "targetId" | "resources">): TargetFlinkExecution {
  // 🔴 刻意**不**把 `flinkRoleArn` 加进 `EXEC_ROLE_RESOURCE_KEYS`:那一组的语义是
  // 「共享角色 → per-target 单向切换」(补充部署窄通道的唯一例外),而 Flink 角色**从来就是**
  // per-target(见 exec-roles.ts 文件头),混进去会顺带改掉准入前置 `missingPerTargetExecRoles`
  // 的判定面 —— 那会让存量 target 的可用性跟着变,与本刀无关。
  // 这里只做两件事:资源袋里必须有,且**必须是本 target 自己那个角色**(名字对不上就是指回了别处)。
  const arn = requireStringResource(t, "flinkRoleArn");
  const want = resourceName("flinkRole", { targetId: t.targetId, account: process.env.AWS_ACCOUNT_ID || "" });
  const got = roleNameOfArn(arn);
  if (got && want && got !== want) {
    throw new Error(
      `target ${t.targetId} 的 flinkRoleArn 指向 ${got},而本 target 的角色应当是 ${want} —— 拒绝。` +
        `拿别处的角色去建 MSAF 应用,失败点会落在 CreateApplication 的 AccessDenied 上,` +
        `而界面上只看到「启动失败」`
    );
  }
  return { targetId: t.targetId, serviceRoleArn: arn };
}

export function resolveTargetEmr(t: ExecutionTarget): TargetEmrExecution {
  if (isHome(t.targetId)) {
    return { targetId: t.targetId, executionRoleArn: process.env.EMR_EXECUTION_ROLE_ARN || "", home: true };
  }
  return { targetId: t.targetId, executionRoleArn: assertPerTargetExecRole(t, "emrExecutionRoleArn"), home: false };
}

// ── 客户端缓存 ────────────────────────────────────────────────────────────────
// 按 region 缓存(客户端本身不含凭证,是 SDK 的连接池/配置对象)。
// 🔴 缓存**键只有 region**:客户端不承载任何项目/权限语义,拿它当权限缓存是 v2 P0-3 那类错。

/**
 * **合同规定只能在主控区跑**的那几条路径的 Redshift 客户端出口。
 *
 * 🔴 为什么要一个「带理由」的专用出口,而不是让它们自己 `redshiftDataClientFor(homeRegion())`:
 * 那样写出来的代码与「忘了按 target 取 region」**长得一模一样** —— 而这两件事的后果天差地别
 * (前者是合同,后者是把用户选的区悄悄换成主控区)。让理由成为**必填的 union 字面量**之后:
 *   ① 读代码的人一眼看到这是合同,不是漏改;
 *   ② 想新增一条 home-only 路径,必须先往这张表里加一个理由 ⇒ 那一步就是合同评审;
 *   ③ 门禁按这张表逐条核对(`no-bare-redshift-client` 的 home-only 清单),名单腐烂不可能发生。
 *
 * 每个理由后面写的是**什么时候可以删掉它**(不是"永远只能 home")。
 */
export type HomeOnlyReason =
  // 原第一项 `sync-no-target-dim` 已**退役**:
  // 同步向导 DDL(execute-ddl / generate-ddl)按 body 的 targetId 走 resolveRedshiftBinding。
  // 🔴 这张表只减不增是设计(每删一个理由 = 一条路径完成下推);别把删掉的理由加回来。
  // 2026-11-04(2026-11-04)—— 原第二项 `workflow-no-target-dim`(「编排没有区域维 ⇒ workflow SQL 节点补数只能在主控区跑」)已**退役**:
  // 编排行早有绑定区(`targets[]`)、补数实例自带 `targetId`、运行时 SQL 节点在实例的区执行,
  // 补数 SQL 节点(lib/backfill/execute.ts runWorkflowSqlNode)改按实例的区走 resolveRedshiftBinding;「只支持主控区」的 400 守卫同笔删除。
  /** 删项目时的资源盘点:盘的是主控区那套控制面资源;跨区盘点归 52 的删项目跨区残留项。 */
  | "project-inventory"
  /** zero-ETL 集成是**主控区里的独立 namespace**,有自己的密钥缓存(`getZeroEtlSecretArn` 对非 home 直接抛)。 */
  | "zeroetl-home-namespace"
  /** DMS 目标侧 bootstrap(建 dms_ingest 用户 / schema / 关联 COPY 角色):正确归宿是 §3.9a 闭合执行器的 `dms-ingest-bootstrap`,的 DMS 组件批次。 */
  | "dms-bootstrap-home";
// 原末项「建模落地 DDL 缺写入通道」已**退役**:非 home 建模落地改走
// §3.9a 闭合执行器(建表/授权)+ 窄权 shared_writer(灌数),home 走逐 target 绑定;那个模块级 home 客户端零生产调用方,已删。

/**
 * 拿主控区的 Redshift Data 客户端,并**显式声明这是合同要求**(理由见 `HomeOnlyReason`)。
 * 🔴 `reason` 只用于让意图可读 / 可门禁 —— 它不改变行为,也**不许**被用来"临时绕过"按 target 取 region。
 */
export function redshiftClientForHomeOnly(reason: HomeOnlyReason): RedshiftDataClient {
  notePlaceDecision({ targetId: HOME_TARGET_ID, via: "redshiftClientForHomeOnly", homeReason: reason });
  return redshiftDataClientFor(homeRegion());
}

/**
 * 主控区的 region。**给「合同规定只能 home」的那几处用**(取语句结果的回落、zero-ETL、
 * 同步 DDL、删项目盘点),让 `process.env.AWS_REGION` 这个字面量收在客户端工厂这一处。
 *
 * 🔴 它**不是**"默认 region":任何按 target 执行的路径都必须走 `resolveRedshiftBinding` 拿
 * 该 target 的 region —— 把这个函数当默认值用,就是把「非 home 静默打回主控区」重新引进来。
 */
export function homeRegion(): string {
  // L4:薄委托给唯一作者 lib/place/home-region(调用方 import 路径不变)
  return readHomeRegion();
}

export function redshiftDataClientFor(region: string): RedshiftDataClient {
  return redshiftDataClient(region);
}

// 🔴 Glue / S3 / EMR Serverless 客户端同样**按 region 缓存**:三者都是 region 端点服务,
//    拿 `process.env.AWS_REGION` 建出来的客户端会把非 home 的调用**静默打回 home**
//    (Glue 会在 home 建作业、S3 会 307 到别的桶所在区、EMR 会在 home 建 application)。
type GlueClientT = import("@aws-sdk/client-glue").GlueClient;
type S3ClientT = import("@aws-sdk/client-s3").S3Client;
type EmrClientT = import("@aws-sdk/client-emr-serverless").EMRServerlessClient;
type LogsClientT = import("@aws-sdk/client-cloudwatch-logs").CloudWatchLogsClient;
// 「这个区有几个 Redshift 工作组」这类**控制面只读探测**用它
// (与执行用的 `redshiftDataClientFor` 是两个服务:一个管资源,一个跑语句)。
type RsServerlessClientT = import("@aws-sdk/client-redshift-serverless").RedshiftServerlessClient;
// 🔴 CloudWatch 日志组是**region 内**的:非 home 的 Glue/EMR 作业日志在那个区的日志组里,
//    用 home 客户端去取只会取到空 —— 而"空日志"在界面上和"作业没输出"长得一模一样。
// EC2 按区:网络拓扑(VPC / 子网 / 安全组)是**区域资源**,
// 拿主控区的客户端去列,在别的区看到的是主控区的子网与安全组 —— 与 `/settings` 那次硬撒谎同一类:
// 界面上是一份看着很正常、其实属于另一个区的清单,选中它建作业必然失败。
type Ec2ClientT = import("@aws-sdk/client-ec2").EC2Client;
// MSAF 与 CloudWatch 指标都是**区域服务**:
// 用主控区客户端去 Describe 另一个区的 MSAF 应用,回的是 ResourceNotFound ⇒ 平台把作业标成「已删除」。
type KdaClientT = import("@aws-sdk/client-kinesis-analytics-v2").KinesisAnalyticsV2Client;
type CwClientT = import("@aws-sdk/client-cloudwatch").CloudWatchClient;
// RDS 也是区域服务:用主控区客户端 DescribeDBInstances
// 查不到别区的实例 ⇒ 安全组解析为空 ⇒ 静默不接 VPC ⇒ 作业连不上私有 sink,而报错是「连接超时」。
type RdsClientT = import("@aws-sdk/client-rds").RDSClient;
// DMS 也是区域服务:成本优化建议只探主控区,
// 别的区的空转实例永远不会被建议出来(而它一直在按小时计费)。
type DmsClientT = import("@aws-sdk/client-database-migration-service").DatabaseMigrationServiceClient;


export async function glueClientFor(region: string): Promise<GlueClientT> {
  return regionalClient("glue", region);
}

export async function s3ClientFor(region: string): Promise<S3ClientT> {
  return regionalClient("s3", region);
}

// S3 Tables 也是**区域服务**(table bucket 是 region 内资源):
// 拿主控区客户端去「确保桶/namespace 存在」,会把该区任务的表桶**建到主控区**且不报错 ——
// 数据落错了法域,而界面上一切正常。这正是同步启动路由那三个模块级单例要退役的原因之一。
type S3TablesClientT = import("@aws-sdk/client-s3tables").S3TablesClient;

export async function s3tablesClientFor(region: string): Promise<S3TablesClientT> {
  return regionalClient("s3tables", region);
}

export async function emrServerlessClientFor(region: string): Promise<EmrClientT> {
  return regionalClient("emrServerless", region);
}

/**
 * 某个 region 的 Redshift Serverless **控制面**客户端(列工作组 / 看命名空间)。
 * 🔴 与 `redshiftDataClientFor` 分开:那是 Data API(跑语句),这是资源管理面;
 * 混用会让「这个区装没装数仓」这类探测跑到执行通道上去。
 */
export async function redshiftServerlessClientFor(region: string): Promise<RsServerlessClientT> {
  return regionalClient("redshiftServerless", region);
}

export async function logsClientFor(region: string): Promise<LogsClientT> {
  return regionalClient("logs", region);
}

// 🔴 DynamoDB **文档客户端按 region**:区域审计表 / 区域结果表建在跨法域 target 所在 region(residency-stack),
//    拿 `lib/aws/dynamodb.ts` 那个 home 的 docClient 去写只会 ResourceNotFound —— 而「审计写不成」在这条路上
//    等于「操作被拒」(SPEC §3.2 写不成即拒),所以客户端选错区不是慢,是全部跨法域操作被拒。
//    marshall 选项与 home 的 docClient **同一份**(removeUndefinedValues),免得两边对 undefined 的处理分叉。
type DocClientT = import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient;

export async function kdaClientFor(region: string): Promise<KdaClientT> {
  return regionalClient("kda", region);
}

// 🔴🔴 **Kinesis 数据流也要按 region**:流式作业的**源流**是那个执行 region 的资源。
//    漏掉它的后果正是本文件头上写的那种最坏形态 —— 「应用跑在那个区、数据写回主控区」:
//    `/api/flink/jobs/[id]/produce` 原来在模块顶部建了一个**主控区** KinesisClient,于是给非 home 的
//    流作业点「造数」时,记录被 PutRecords 到**主控区**的同名流(或直接 ResourceNotFound)——
//    页面显示「已注入 150 条」,而那个区的作业永远等不到数据。2026-09-把实时计算纳入
//    能力矩阵时才现形(此前这一类根本不在矩阵里 = 默认豁免)。
type KinesisClientT = import("@aws-sdk/client-kinesis").KinesisClient;

export async function kinesisClientFor(region: string): Promise<KinesisClientT> {
  return regionalClient("kinesis", region);
}

export async function dmsClientFor(region: string): Promise<DmsClientT> {
  return regionalClient("dms", region);
}

export async function rdsClientFor(region: string): Promise<RdsClientT> {
  return regionalClient("rds", region);
}

export async function cloudWatchClientFor(region: string): Promise<CwClientT> {
  return regionalClient("cloudwatch", region);
}

export async function ec2ClientFor(region: string): Promise<Ec2ClientT> {
  return regionalClient("ec2", region);
}

export async function dynamoDocClientFor(region: string): Promise<DocClientT> {
  return dynamoDocClient(region);
}

/** 单测 / 排障用。 */
export function __resetTargetClients(): void {
  __resetClients();
}

export interface ExecOnTargetResult {
  /** Redshift 报告的受影响行数(DDL 通常为 0 / undefined ⇒ 归一成 0) */
  affected: number;
  /** Data API 的 statement Id(进审计,便于在 AWS 侧对账) */
  statementId: string;
}

/**
 * 在指定 target 上执行**一条**语句,轮询到终态。
 *
 * 🔴 **`secretArn` 是必填参数,不是可选**(50 SPEC §3.9a 第 8 步:「**禁 IAM fallback**
 * (解析失败即拒,不省略 SecretArn)」)。现网既有写法是
 * `...(SecretArn ? { SecretArn } : {})` —— 那个三元在解析不到时会**静默退回联邦身份**,
 * 造成表属主分叉(正是此前修过的病)。这里把它做成类型层不可省
 * 想不传 SecretArn,连编译都过不去。
 */
export async function execOnTarget(args: {
  warehouse: TargetWarehouse;
  sql: string;
  secretArn: string;
  /** 轮询次数上限;缺省 200(配合下面的退避,总预算约 3 分钟)*/
  maxPolls?: number;
  /** **首轮**等待毫秒;缺省 150,之后 ×1.6 退避、上限 1s */
  pollIntervalMs?: number;
}): Promise<ExecOnTargetResult> {
  const { warehouse, sql, secretArn } = args;
  if (typeof secretArn !== "string" || !secretArn.startsWith("arn:")) {
    throw new Error(
      `execOnTarget 需要真实的 SecretArn(收到 ${JSON.stringify(secretArn)})—— 拒绝执行。` +
        `§3.9a:禁 IAM fallback,解析不到凭证就拒,不许省略 SecretArn 退回联邦身份`
    );
  }
  const client = redshiftDataClientFor(warehouse.region);
  const { Id } = await client.send(
    new ExecuteStatementCommand({
      Sql: sql,
      WorkgroupName: warehouse.workgroup,
      Database: warehouse.database,
      SecretArn: secretArn,
    })
  );
  if (!Id) throw new Error("Redshift Data API 没有返回 statement Id ⇒ 无法确认执行结果,拒绝当成功");

  // 🔴 **首轮等待要短、之后退避**(真环境实测改的):原来是固定 1s 起步,而 admin-DDL 的每条
  //    `CREATE SCHEMA` / `GRANT` 通常几十毫秒就 FINISHED ⇒ 每条白等将近 1s。
  //    一次供给有 ~10 条语句、跨 region 时更慢,于是 `provision-credentials` 直接**撞 ALB 504**
  //    (真环境第一次跑非 home 供给就是这么超时的)。改成 150ms 起、×1.6 退避、上限 1s:
  //    快语句几百毫秒返回,慢语句仍不会把 Data API 打成轮询风暴。
  const maxPolls = args.maxPolls ?? 200;
  const base = args.pollIntervalMs ?? 150;
  let delay = base;
  let waitedMs = 0;
  for (let i = 0; i < maxPolls; i++) {
    await new Promise((r) => setTimeout(r, delay));
    waitedMs += delay;
    delay = Math.min(1000, Math.round(delay * 1.6));
    const d = await client.send(new DescribeStatementCommand({ Id }));
    if (d.Status === "FINISHED") {
      return { affected: typeof d.ResultRows === "number" && d.ResultRows > 0 ? d.ResultRows : 0, statementId: Id };
    }
    if (d.Status === "FAILED" || d.Status === "ABORTED") {
      // 🔴 错误文本可能含语句片段 ⇒ 由调用方决定进不进审计(执行器只写骨架)。
      throw new Error(`Redshift 语句${d.Status === "ABORTED" ? "被中止" : "失败"}:${d.Error || d.Status}`);
    }
  }
  throw new Error(`Redshift 语句在 ${(waitedMs / 1000).toFixed(1)}s / ${maxPolls} 次轮询内未达终态(statementId=${Id})⇒ 当失败处理`);
}

// ── Secrets Manager(按 target region)────────────────────────────────────────
// 🔴 **为什么 secret 的读写原语放在这里、而不是放供给层**:执行器(片③,建登录用户时要写 secret)
// 与供给层(片④,`lookupProjectSecretArn`)都要用它。放任一侧都会形成
// `executor ↔ supply` 的循环依赖;放在"per-target AWS 客户端"这个模块里,两边都只是**下游**。
// 这也保住"同一件事只有一个作者":secret 名的**语义**在 `project-schema.projectSecretName()`,
// secret 的**AWS 调用**在这里,谁都不许再写第二份。

type SecretsClient = import("@aws-sdk/client-secrets-manager").SecretsManagerClient;

export async function secretsClientFor(region: string): Promise<SecretsClient> {
  return regionalClient("secrets", region);
}

/**
 * 按**名字**取 secret 的真 ARN。
 *
 * 🔴 **只有 `ResourceNotFoundException` 才等于"没有"**;其他任何错误一律**抛**。
 * 这是 §3.9b 的方向:「查不到 ≠ 没问题」。把读失败(限流、AccessDenied、网络)
 * 等价成"没有凭证",会让 project-context 静默回落共享 admin ——
 * 一次 throttling 就能把隔离撤掉,而日志里什么异常都看不到。
 */
export async function describeSecretArnByName(region: string, name: string): Promise<string | undefined> {
  const sm = await secretsClientFor(region);
  const { DescribeSecretCommand } = await import("@aws-sdk/client-secrets-manager");
  try {
    const r = await sm.send(new DescribeSecretCommand({ SecretId: name }));
    if (!r.ARN) {
      // 能 describe 到却没有 ARN:形态异常,不能当"没有"(那会回落),也不能当"有"(ARN 是空的)。
      throw new Error(`DescribeSecret(${name}) 返回了没有 ARN 的结果 ⇒ 形态异常,拒绝当成任何一种结论`);
    }
    return r.ARN;
  } catch (e) {
    if ((e as { name?: string })?.name === "ResourceNotFoundException") return undefined;
    throw e;
  }
}

/**
 * 幂等写入一个 JSON 值的 secret,返回真 ARN。
 *
 * 🔴 **调用方绝不要把返回值以外的东西记下来**:`value` 里含口令。本函数不打日志、不进审计。
 */
export async function putSecretJson(
  region: string,
  name: string,
  value: Record<string, unknown>
): Promise<{ arn: string; created: boolean }> {
  const sm = await secretsClientFor(region);
  const { CreateSecretCommand, PutSecretValueCommand, DescribeSecretCommand } = await import(
    "@aws-sdk/client-secrets-manager"
  );
  const SecretString = JSON.stringify(value);
  try {
    const r = await sm.send(new CreateSecretCommand({ Name: name, SecretString }));
    if (!r.ARN) throw new Error(`CreateSecret(${name}) 没有返回 ARN ⇒ 拒绝当成功`);
    return { arn: r.ARN, created: true };
  } catch (e) {
    if ((e as { name?: string })?.name !== "ResourceExistsException") throw e;
    // 已存在 ⇒ 覆盖值(轮换语义),再取真 ARN。
    await sm.send(new PutSecretValueCommand({ SecretId: name, SecretString }));
    const d = await sm.send(new DescribeSecretCommand({ SecretId: name }));
    if (!d.ARN) throw new Error(`PutSecretValue 后 DescribeSecret(${name}) 仍拿不到 ARN ⇒ 拒绝当成功`);
    return { arn: d.ARN, created: false };
  }
}

/**
 * 按**名字**删一个 secret(立即删除、不留恢复期)。回 `deleted` = 本次删掉了;`absent` = **确认**本来就没有。
 *
 * 🔴 与 `describeSecretArnByName` 同一条方向:**只有** `ResourceNotFoundException` 等于「没有」,其余一律**抛**
 *    (AccessDenied / 限流 / 网络当成「已删」= 凭证还在而平台以为回收完了)。
 * 🔴 唯一额外容忍的一种:secret **已在删除中**(前一次强删的异步窗口里重放)—— Secrets Manager 回
 *    `InvalidRequestException` 且文本说「scheduled for deletion」。那正是「已经删了」,当 `deleted`。
 *    判据收得很窄(必须同时是这个错误名 + 这个语义词),不是全局吞 InvalidRequest。
 * 🔴 为什么 `ForceDeleteWithoutRecovery`:这里只删**系统代管、可再生**的凭证(per-project 登录口令的副本;
 *    要的话重新供给即可),留 7–30 天恢复期 = 同名 secret 在那段时间里**仍可被恢复成可用凭证**,与「回收」相反。
 */
export async function deleteSecretByName(region: string, name: string): Promise<"deleted" | "absent"> {
  const sm = await secretsClientFor(region);
  const { DeleteSecretCommand } = await import("@aws-sdk/client-secrets-manager");
  try {
    await sm.send(new DeleteSecretCommand({ SecretId: name, ForceDeleteWithoutRecovery: true }));
    return "deleted";
  } catch (e) {
    const err = e as { name?: string; message?: string };
    if (err?.name === "ResourceNotFoundException") return "absent";
    if (err?.name === "InvalidRequestException" && /scheduled for deletion/i.test(String(err.message ?? ""))) return "deleted";
    throw e;
  }
}

/**
 * 解析某 target 的 Redshift Serverless 连接端点(host/port)。
 *
 * 用途:per-project secret 里要存 `host/port/dbname`,否则将来任何 JDBC 侧消费者
 * (BI 直连、外部工具)拿到的是**半份**凭证。
 * 🔴 解析失败**抛**,不写半份 secret —— 半份 secret 会通过"存在性"检查却不可用,
 * 那正是 §3.9b「查不到 ≠ 没问题」的反面:**写得进去 ≠ 是对的**。
 */
export async function resolveTargetEndpoint(w: TargetWarehouse): Promise<{ host: string; port: number }> {
  const { GetWorkgroupCommand } = await import("@aws-sdk/client-redshift-serverless");
  const rs = await regionalClient("redshiftServerless", w.region);
  const { workgroup } = await rs.send(new GetWorkgroupCommand({ workgroupName: w.workgroup }));
  const host = workgroup?.endpoint?.address;
  const port = workgroup?.endpoint?.port;
  if (!host || typeof port !== "number") {
    throw new Error(
      `解析不到 workgroup ${w.workgroup}(region=${w.region})的连接端点 ⇒ 拒绝写入不完整的 per-project secret`
    );
  }
  return { host, port };
}
