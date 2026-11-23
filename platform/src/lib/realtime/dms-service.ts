// 实时数据集成 CDC 编排服务层。
//
// 把 R3/R4 用 CLI 手工打通的 DMS(MySQL→Redshift,full-load+CDC)编排固化为幂等代码,
// 内含 7 个实测踩坑的解法(见 docs/design/31-realtime-cdc/DESIGN.md §9b)。
//
// 设计:
//  - 纯编排,不创建常驻基建(子网组 / 安全组 / 访问角色由主控区实时栈或该执行区的 DMS 栈提供;复制实例懒创建、空闲回收)。
//  - 幂等:每步先查后建(endpoint/任务/用户/schema 重复调用安全)。
//  - 凭证零硬编码:源走数据源 secret;目标用专用数仓用户,口令只在该区 Secrets Manager 里,绝不落代码/日志(红线②)。
//  - 🔴 **在哪个区做** 由调用方给的落点决定(`lib/realtime/dms-place.ts`,来自任务自己的绑定):本文件没有任何
//    模块级客户端、也不读「在哪」的环境变量 —— 每个发云调用的函数第一个参数就是落点,漏传是编译错。
//    (2026-11 之前这里握着模块级的主控区客户端:非主控区数据源的任务能选、能存,启动才被拒。)

import {
  CreateEndpointCommand,
  DescribeEndpointsCommand,
  CreateReplicationTaskCommand,
  ModifyReplicationTaskCommand,
  DescribeReplicationTasksCommand,
  StartReplicationTaskCommand,
  StopReplicationTaskCommand,
  DeleteReplicationTaskCommand,
  TestConnectionCommand,
  DescribeConnectionsCommand,
  DescribeTableStatisticsCommand,
  DescribeReplicationInstancesCommand,
  CreateReplicationInstanceCommand,
  DeleteEndpointCommand,
  ModifyEndpointCommand,
} from "@aws-sdk/client-database-migration-service";
import { DescribeSecurityGroupsCommand } from "@aws-sdk/client-ec2";
import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { logger } from "@/lib/observability/logger";
import { dmsClientFor, ec2ClientFor, secretsClientFor } from "@/lib/exec-env/target-clients";
import { regionOfArn } from "@/lib/aws/arn";
import { isHome } from "@/lib/exec-env/target-id";
import type { DmsPlace, DmsSite } from "@/lib/realtime/dms-place";

// 懒创建规格(该 region dms.t3.micro 不可订购,用 small;引擎 3.5.4)。这两项是「建成什么样」,不是「建在哪」。
const DMS_INSTANCE_CLASS = process.env.DMS_INSTANCE_CLASS || "dms.t3.small";
const DMS_ENGINE_VERSION = process.env.DMS_ENGINE_VERSION || "3.5.4";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 🔴 复制实例的 ARN **不在进程里记**:实例会被空闲回收(或人工删除)再由下一次「启动」重建,ARN 随之更换。
//   2026-11-16 真环境:回收之后同一进程里再点「启动」,拿着已删实例的 ARN 去建复制任务 ⇒
//   「Replication Instance ARN … does not exist」,平台不重启就一直失败。每次用之前都问 DMS(一次 Describe)。

// 按名查该区复制实例安全组的 id(懒创建 CreateReplicationInstance 需要 SG id,非名)。
async function findDmsSgId(place: DmsPlace): Promise<string | null> {
  try {
    const ec2 = await ec2ClientFor(place.region);
    const r = await ec2.send(
      new DescribeSecurityGroupsCommand({ Filters: [{ Name: "group-name", Values: [place.securityGroupName] }] })
    );
    return r.SecurityGroups?.[0]?.GroupId || null;
  } catch {
    return null;
  }
}

// 查复制实例(返回 {arn,status} 或 null)。
// ⚠️ DMS DescribeReplicationInstances 在按 filter 查不到时会**抛 ResourceNotFoundFault**(不是返回空数组),
//    必须捕获成 null,否则懒创建分支永远进不去(实测踩坑 2026-07-07)。
async function describeInstance(site: DmsSite): Promise<{ arn: string; status: string } | null> {
  const dms = await dmsClientFor(site.region);
  let r;
  try {
    r = await dms.send(
      new DescribeReplicationInstancesCommand({
        Filters: [{ Name: "replication-instance-id", Values: [site.instanceId] }],
      })
    );
  } catch (e: any) {
    if (e?.name === "ResourceNotFoundFault" || /not found|No instances found/i.test(String(e?.message || ""))) {
      return null; // 实例不存在 → 交由懒创建
    }
    throw e; // 其它错误(权限/网络)照抛
  }
  const inst = r.ReplicationInstances?.[0];
  if (!inst?.ReplicationInstanceArn) return null;
  return { arn: inst.ReplicationInstanceArn, status: inst.ReplicationInstanceStatus || "unknown" };
}

/**
 * 复制实例这些状态下不会再自己好起来(等也白等,要人处理):探测与轮询两处用同一份(单一作者)。
 * 「deleting」不在其列:空闲回收(或人工止血)之后它是正常的过渡态 —— 删完就能重建,由后台编排等(见 getReplicationInstanceArn);
 *   当成「坏了」的话,用户在回收的那几分钟里点「启动」只会拿到一句「状态异常」,得自己猜什么时候再点。
 */
export const REPLICATION_INSTANCE_BROKEN_STATUSES: readonly string[] = ["failed", "incompatible-network"];

export interface ReplicationInstanceProbe {
  /** DMS 回的实例状态;实例不存在且没能发起创建时为 `missing`。 */
  status: string;
  arn?: string;
  /** 本次探测发起了懒创建(调用方据此告诉用户「首次使用需约 10–15 分钟」)。 */
  requestedCreate: boolean;
}

/**
 * **只看一眼、不等**:实例不存在就发起懒创建并立刻把当前状态带回;实例在建 / 在改就如实回 creating / modifying。
 *
 * 【为什么要把「看」和「等」拆开(2026-10-24 全新账号页面驱动段 wp24 抓到)】
 *   启动路由原来在返 202 之前就 `await getReplicationInstanceArn()` —— 全新账号第一次点「启动」,实例要
 *   现场创建 3–8 分钟,这一等就把一次 HTTP 请求等过了 60s 边缘超时 ⇒ 页面拿到 504(「不知道成没成」),
 *   而服务端那条请求**还在跑**;用户再点一次就再多一条;实例就位后它们一起起跑、互撞
 *   `ResourceAlreadyExistsFault`,撞的那条把任务写成 error。
 *   ⇒ 请求路径只许做**不等待**的前置检查(基建缺就 503、状态坏就 503),等待一律进后台编排。
 */
export async function probeReplicationInstance(place: DmsPlace): Promise<ReplicationInstanceProbe> {
  let cur = await describeInstance(place);
  let requestedCreate = false;

  // 不存在 → 懒创建(只发起,不等)。
  // 正在删除(deleting)的旧实例还占着这个 id,此刻建不了 ⇒ 如实回 deleting,由后台编排等它删完再来看这一眼。
  if (!cur) {
    const sgId = await findDmsSgId(place);
    if (!sgId) {
      throw new Error(
        `DMS 安全组 ${place.securityGroupName} 未就绪(${place.region}):` +
          (isHome(place.targetId)
            ? "需先部署 BgpRealtimeStack 提供子网组/SG/角色等耐久基建"
            : `请在「执行环境」页对 ${place.targetId} 点「重新部署」后再启动`)
      );
    }
    logger.info?.("dms.instance.lazy_create", { id: place.instanceId, region: place.region, class: DMS_INSTANCE_CLASS });
    const dms = await dmsClientFor(place.region);
    try {
      await dms.send(
        new CreateReplicationInstanceCommand({
          ReplicationInstanceIdentifier: place.instanceId,
          ReplicationInstanceClass: DMS_INSTANCE_CLASS,
          AllocatedStorage: 20,
          EngineVersion: DMS_ENGINE_VERSION,
          MultiAZ: false,
          PubliclyAccessible: false,
          ReplicationSubnetGroupIdentifier: place.subnetGroupId,
          VpcSecurityGroupIds: [sgId],
        })
      );
      requestedCreate = true;
    } catch (e) {
      // 另一条启动(或另一个副本)刚好先一步发起了创建 ⇒ 不是失败:实例正在建,读它的现状即可
      if (String((e as { name?: string })?.name ?? "") !== "ResourceAlreadyExistsFault") throw e;
    }
    cur = await describeInstance(place);
  }
  return { status: cur?.status || "missing", arn: cur?.arn, requestedCreate };
}

/**
 * 复制实例冷建的等待预算(🔴 只给后台编排用;HTTP 请求路径不等)。
 * 【2026-11-01 …4916 第五十轮硬门 wp24 真撞】原口径 48 × 10s = 8 分钟,而 AWS 真建这台实例用了 **13.3 分钟**
 *   (CloudTrail CreateReplicationInstance 15:20:57 → available 15:34:16);编排 15:29:01 放弃(`realtime.start.failed`
 *   「未就绪(当前状态 creating,可稍后重试)」),CreateReplicationTask 从未发出,用户必须再点一次「启动」——
 *   违反「用户按一次最终达成」。AWS 文档对 DMS 实例创建只说「几分钟到十几分钟」⇒ 预算放到 30 分钟(90 × 20s),
 *   每 5 分钟记一行进度;用户可见文案同步改成「约 10–15 分钟」。预算与文案由 dms-instance-wait-budget.test.ts 钉住。
 */
export const REPLICATION_INSTANCE_WAIT = { intervalMs: 20_000, maxAttempts: 90 } as const;

/**
 * 旧实例「删除中」的等待预算(同样只给后台编排用):同名实例要等旧的删完才能重建。
 * 2026-11-16 真环境实测删除 5–8 分钟 ⇒ 预算 20 分钟(60 × 20s);与冷建预算分开计 —— 删完之后的冷建仍有完整的 30 分钟。
 */
export const REPLICATION_INSTANCE_DELETE_WAIT = { intervalMs: 20_000, maxAttempts: 60 } as const;

// 运行时发现复制实例 ARN(按稳定 id 查);不缓存 —— 实例会被回收再重建,ARN 随之更换(见上文「不在进程里记」的说明)。
// **懒创建(2026-07-07 成本改造)**:实例不常驻。该区的实例不存在,就用该区栈提供的子网组 + 安全组现场
// CreateReplicationInstance(首次 10–15 分钟,实测 13.3 分钟),之后复用;空闲时由后台回收,
// 基建(子网组/SG/角色)留着零成本复用。实例的五种常态这里都接得住:
//   不存在 ⇒ 建;创建中 / 修改中 ⇒ 等到 available;删除中(刚被回收)⇒ 等它删完再建;available ⇒ 直接用。
// 🔴 只许**后台编排**调本函数(要等分钟级);HTTP 请求路径用 probeReplicationInstance()。
export async function getReplicationInstanceArn(place: DmsPlace): Promise<string> {
  let waitedDelete = 0;
  let waitedCreate = 0;
  for (;;) {
    // 每一轮都从「看一眼」开始:实例不在(从未建过 / 旧的刚删完)⇒ 这一眼就发起懒创建
    const cur = await probeReplicationInstance(place);
    if (cur.status === "available" && cur.arn) return cur.arn;
    if (REPLICATION_INSTANCE_BROKEN_STATUSES.includes(cur.status)) {
      throw new Error(`DMS 复制实例 ${place.instanceId} 状态异常:${cur.status}`);
    }
    // 两段预算分开计:等旧实例删完(REPLICATION_INSTANCE_DELETE_WAIT)· 等新实例就位(REPLICATION_INSTANCE_WAIT);
    // 超时抛错,由调用方决定重试(下次进来实例可能已 available,直接用)。
    const deleting = cur.status === "deleting";
    const budget = deleting ? REPLICATION_INSTANCE_DELETE_WAIT : REPLICATION_INSTANCE_WAIT;
    const waited = deleting ? waitedDelete++ : waitedCreate++;
    if (waited >= budget.maxAttempts) {
      throw new Error(`DMS 复制实例 ${place.instanceId} 未就绪(当前状态 ${cur.status || "缺失"},可稍后重试)`);
    }
    if (waited > 0 && waited % 15 === 0) {
      logger.info?.("dms.instance.waiting", { id: place.instanceId, region: place.region, status: cur.status, waitedSec: (waited * budget.intervalMs) / 1000 });
    }
    await sleep(budget.intervalMs);
  }
}

export interface RealtimeTaskInput {
  taskId: string; // 平台同步任务 id(用于命名 DMS 资源,保证可追溯)
  sourceSecretArn: string; // 源 MySQL 凭证(数据源 secret;通常只含 username/password)
  sourceHost: string; // 源 MySQL 主机(数据源 secret 一般不含 host/port,故显式传入)
  sourcePort?: number; // 源 MySQL 端口(默认 3306)
  targetSecretArn: string; // 目标数仓专用用户的 secret(名字或 ARN;该区 Secrets Manager 里,含完整连接字段)
  schemaName: string; // 源 schema(也是 Redshift 目标 schema,须预建)
  tableName: string; // 同步的表(或 "%" 整库)
}

// DMS 资源命名(由 taskId 派生,稳定可追溯)。
function names(taskId: string) {
  const short = taskId.slice(-12).toLowerCase().replace(/[^a-z0-9]/g, "");
  return {
    srcId: `bgp-src-${short}`,
    tgtId: `bgp-tgt-${short}`,
    taskIdent: `bgp-rt-${short}`,
  };
}

// 幂等:按 identifier 查 endpoint ARN,无则返回空。
async function findEndpointArn(site: DmsSite, endpointId: string): Promise<string | null> {
  try {
    const dms = await dmsClientFor(site.region);
    const r = await dms.send(
      new DescribeEndpointsCommand({ Filters: [{ Name: "endpoint-id", Values: [endpointId] }] })
    );
    return r.Endpoints?.[0]?.EndpointArn || null;
  } catch {
    return null;
  }
}

/** 源端点的连接配置(主机 / 端口 / 账号 / 口令):建端点与对齐端点两处用同一份(单一作者),值全部来自数据源的现状。 */
async function sourceConnectionOf(place: DmsPlace, input: RealtimeTaskInput): Promise<{ ServerName: string; Port: number; Username: string; Password: string }> {
  // 从数据源 secret 取账密(只读用一次,不落日志)。数据源的密钥在它所属的区 —— 任务跟着源走,所以就是落点这个区。
  const sm = await secretsClientFor(place.region);
  const sec = await sm.send(new GetSecretValueCommand({ SecretId: input.sourceSecretArn }));
  const creds = JSON.parse(sec.SecretString || "{}");
  if (!creds.username || !creds.password) {
    throw new Error("源数据源凭证缺少 username/password,无法建 DMS 源 endpoint");
  }
  return { ServerName: input.sourceHost, Port: input.sourcePort || 3306, Username: creds.username, Password: creds.password };
}

/** 源端点:`reused` = 这次沿用的是已有端点(它的连接配置可能早于数据源最近一次改动,启动前要对齐,见 `alignSourceEndpoint`)。 */
export interface SourceEndpointRef {
  arn: string;
  reused: boolean;
}

// 建源 endpoint(MySQL,显式连接参数)。
// 踩坑(新账号实测):数据源 secret 通常只含 {username,password},缺 host/port —— DMS Secrets 模式
//   要求 secret 含完整字段,否则连通性测试报 "The 'port' parameter in the secret string is missing"。
//   故源端改用【显式参数】:从数据源 secret 取账密 + 用传入的 host/port 直连,绕开 secret 字段不全问题。
export async function ensureSourceEndpoint(place: DmsPlace, input: RealtimeTaskInput): Promise<SourceEndpointRef> {
  const { srcId } = names(input.taskId);
  const existing = await findEndpointArn(place, srcId);
  if (existing) return { arn: existing, reused: true };
  const conn = await sourceConnectionOf(place, input);
  const dms = await dmsClientFor(place.region);
  const r = await dms.send(
    new CreateEndpointCommand({
      EndpointIdentifier: srcId,
      EndpointType: "source",
      EngineName: "mysql",
      ...conn,
    })
  );
  logger.info("realtime.endpoint.source.created", { taskId: input.taskId, endpointId: srcId }); // 不记凭证
  return { arn: r.Endpoint!.EndpointArn!, reused: false };
}

/**
 * 把**沿用的**源端点对齐到数据源的现值(主机 / 端口 / 账号 / 口令),并让连通性测试重新做一遍。
 *
 * 【为什么】端点按名复用。任务停止之后(或上一次启动因为连不上而失败之后)用户改了数据源 —— 换主机、改口令、
 *   纠正填错的地址 —— 再点「启动」,端点里还是旧配置:连通性测试照旧失败,怎么点都一样,只能删任务重建;
 *   更糟的是旧主机还连得上时,任务会悄悄接着读旧库。口令读不回来、无从比对 ⇒ 每次沿用都按现值写一次(幂等)。
 * 【为什么要重测】端点上一次的「成功」是旧配置测出来的,不能拿它放行新配置;重测失败时 DMS 给的原文照常带进任务错误。
 * 【调用时机】复制任务到可启动的稳态之后:端点被运行中 / 正在停止的复制任务占着时 DMS 不让改。
 */
export async function alignSourceEndpoint(place: DmsPlace, input: RealtimeTaskInput, sourceArn: string): Promise<void> {
  const conn = await sourceConnectionOf(place, input);
  const dms = await dmsClientFor(place.region);
  await dms.send(new ModifyEndpointCommand({ EndpointArn: sourceArn, ...conn }));
  logger.info("realtime.endpoint.source.aligned", { taskId: input.taskId, endpointArn: sourceArn }); // 不记凭证
  const instanceArn = await getReplicationInstanceArn(place);
  try {
    await dms.send(new TestConnectionCommand({ ReplicationInstanceArn: instanceArn, EndpointArn: sourceArn }));
  } catch (e) {
    // 已经有一次测试在进行(或被限流):随后的连通性轮询会读到真实状态,这里不让它挡住启动
    logger.warn("realtime.endpoint.source.retest_skipped", { taskId: input.taskId, error: String((e as Error)?.message ?? e).slice(0, 200) });
  }
}

// 建目标 endpoint(Redshift,经 Secrets)。
// 踩坑④:目标 secret 必须含完整字段(host/port/database/username/password)且密码无 DMS 禁用字符 {},;
//        —— 由目标侧准备保证(lib/realtime/redshift-target.ts:专用用户 + 完整 secret)。
// 踩坑⑥:Redshift COPY 的 ServiceAccessRoleArn 必须已关联到 Redshift namespace(见 ensureRoleAssociatedToNamespace)。
// 访问角色、暂存桶、库名全部取落点:写的是**该区**的数仓,暂存也落**该区**的桶。
export async function ensureTargetEndpoint(place: DmsPlace, input: RealtimeTaskInput): Promise<string> {
  const { tgtId } = names(input.taskId);
  const existing = await findEndpointArn(place, tgtId);
  if (existing) return existing;
  const dms = await dmsClientFor(place.region);
  const r = await dms.send(
    new CreateEndpointCommand({
      EndpointIdentifier: tgtId,
      EndpointType: "target",
      EngineName: "redshift",
      RedshiftSettings: {
        SecretsManagerSecretId: input.targetSecretArn,
        SecretsManagerAccessRoleArn: place.roleArn,
        ServiceAccessRoleArn: place.roleArn,
        DatabaseName: place.warehouse.database,
        BucketName: place.stagingBucket,
        BucketFolder: "dms-redshift-staging",
      },
    })
  );
  logger.info("realtime.endpoint.target.created", { taskId: input.taskId, endpointId: tgtId });
  return r.Endpoint!.EndpointArn!;
}

// 表映射:只同步指定 schema.table(或整库)。
function tableMappings(schema: string, table: string): string {
  return JSON.stringify({
    rules: [
      {
        "rule-type": "selection",
        "rule-id": "1",
        "rule-name": "1",
        "object-locator": { "schema-name": schema, "table-name": table },
        "rule-action": "include",
      },
    ],
  });
}

// DMS 迁移类型:full-load(一次性普通全量)/ cdc(仅增量)/ full-load-and-cdc(全量+持续CDC)。
export type DmsMigrationType = "full-load" | "cdc" | "full-load-and-cdc";

// DMS 任务设置(对齐 DMS console 创建任务页的 Task settings,参数齐全暴露;全部可选,不填用 AWS 默认)。
export interface DmsTaskSettings {
  targetTablePrepMode?: "DO_NOTHING" | "DROP_AND_CREATE" | "TRUNCATE_BEFORE_LOAD"; // Target table preparation mode
  lobMode?: "limited" | "full" | "none"; // Include LOB columns(limited=推荐,full=完整但慢,none=不含)
  lobMaxSizeKB?: number; // limited 模式的 LOB 截断上限(默认 32KB)
  batchApplyEnabled?: boolean; // CDC 批量应用(高吞吐场景合并小事务)
  validationEnabled?: boolean; // 数据校验(逐行比对,增加源/目标负载)
  fullLoadMaxSubTasks?: number; // 全量并行子任务数(默认 8)
  commitRate?: number; // 全量每批提交行数(默认 10000)
}

// 把平台 DmsTaskSettings 组装为 DMS ReplicationTaskSettings JSON(未指定项不写,沿用 AWS 默认)。
export function buildReplicationTaskSettings(s?: DmsTaskSettings): string {
  const settings: Record<string, unknown> = { Logging: { EnableLogging: true } };
  const target: Record<string, unknown> = {};
  // Redshift 目标引擎约束(AWS 校验,实测):必须 LimitedSizeLobMode 且 LobMaxSize ∈ [1,63]KB;
  // FullLobMode / 超 63KB 会被 CreateReplicationTask 直接拒绝。平台 DMS 通道目标恒为 Redshift,
  // 故 full 降级为 limited(63KB 上限),limited 的上限钳制到 63。
  if (s?.lobMode === "none") target.SupportLobs = false;
  else if (s?.lobMode === "full" || s?.lobMode === "limited") {
    target.SupportLobs = true; target.FullLobMode = false; target.LimitedSizeLobMode = true;
    target.LobMaxSize = s.lobMode === "full" ? 63 : Math.min(63, Math.max(1, Math.floor(s?.lobMaxSizeKB ?? 32)));
  }
  if (Object.keys(target).length) settings.TargetMetadata = target;
  if (s?.batchApplyEnabled != null) settings.TargetMetadata = { ...(settings.TargetMetadata as object || {}), BatchApplyEnabled: s.batchApplyEnabled === true };
  const fullLoad: Record<string, unknown> = {};
  // TargetTablePrepMode 属于 FullLoadSettings(曾误放 TargetMetadata 被 DMS 忽略,
  // 实测落成默认 DROP_AND_CREATE 而非用户选的 DO_NOTHING)。
  // 🔴 生产上线批次 A:不填时**显式**写 DO_NOTHING(页面缺省同值)。原来不填就落 AWS 默认 DROP_AND_CREATE
  //   ⇒ 经 API / Copilot 建的 CDC 任务会把目标库里的同名表直接 DROP。删表重建必须由用户显式选。
  fullLoad.TargetTablePrepMode = s?.targetTablePrepMode || "DO_NOTHING";
  if (s?.fullLoadMaxSubTasks != null) fullLoad.MaxFullLoadSubTasks = Math.min(49, Math.max(1, Math.floor(s.fullLoadMaxSubTasks)));
  if (s?.commitRate != null) fullLoad.CommitRate = Math.min(50000, Math.max(1, Math.floor(s.commitRate)));
  if (Object.keys(fullLoad).length) settings.FullLoadSettings = fullLoad;
  if (s?.validationEnabled != null) settings.ValidationSettings = { EnableValidation: s.validationEnabled === true, ThreadCount: 5 };
  return JSON.stringify(settings);
}

// 建复制任务(迁移类型可选:普通全量 / CDC / 全量+CDC),幂等。
export async function ensureReplicationTask(
  place: DmsPlace,
  input: RealtimeTaskInput,
  sourceArn: string,
  targetArn: string,
  migrationType: DmsMigrationType = "full-load-and-cdc",
  taskSettings?: DmsTaskSettings
): Promise<string> {
  const { taskIdent } = names(input.taskId);
  const dms = await dmsClientFor(place.region);
  try {
    const r = await dms.send(
      new DescribeReplicationTasksCommand({
        Filters: [{ Name: "replication-task-id", Values: [taskIdent] }],
      })
    );
    const existing = r.ReplicationTasks?.[0];
    if (existing?.ReplicationTaskArn) {
      // 复用已存在任务前,把最新任务设置改上去(与 Glue UpdateJob 同语义:改参数要真生效,
      // 不静默沿用旧定义)。仅 stopped/ready/failed 态可 Modify;运行中跳过(下次重启生效)。
      const st = existing.Status || "";
      if (["stopped", "ready", "failed"].includes(st)) {
        try {
          await dms.send(new ModifyReplicationTaskCommand({
            ReplicationTaskArn: existing.ReplicationTaskArn,
            ReplicationTaskSettings: buildReplicationTaskSettings(taskSettings),
          }));
        } catch (e) { logger.warn("realtime.task.modify.skipped", { taskIdent, err: String(e).slice(0, 120) }); }
      }
      return existing.ReplicationTaskArn;
    }
  } catch {
    /* not found → create */
  }
  const replicationInstanceArn = await getReplicationInstanceArn(place);
  const r = await dms.send(
    new CreateReplicationTaskCommand({
      ReplicationTaskIdentifier: taskIdent,
      SourceEndpointArn: sourceArn,
      TargetEndpointArn: targetArn,
      ReplicationInstanceArn: replicationInstanceArn,
      MigrationType: migrationType,
      TableMappings: tableMappings(input.schemaName, input.tableName),
      ReplicationTaskSettings: buildReplicationTaskSettings(taskSettings),
    })
  );
  logger.info("realtime.task.created", { taskId: input.taskId, taskIdent, migrationType });
  return r.ReplicationTask!.ReplicationTaskArn!;
}

// 查复制任务当前状态(轻量)。
/** DMS 通道的**下线**结果(如实报:有没有找到、有没有真停下来、有没有真删掉)。 */
export interface DmsTeardownResult {
  found: boolean;
  stopped: boolean;
  deleted: boolean;
  finalStatus?: string;
  error?: string;
}

/** Stop 被拒的原因是「任务此刻不在运行」(状态刚变)—— 不是下线失败,重读状态即可。 */
function isNotRunningRejection(e: unknown): boolean {
  return /not running/i.test(String((e as Error)?.message ?? e));
}

/** 按标识查复制任务时服务回「没有这个任务」。 */
function isTaskNotFound(e: unknown): boolean {
  const name = String((e as { name?: string })?.name ?? "");
  return name === "ResourceNotFoundFault" || /ResourceNotFound|No Tasks found/i.test(String((e as Error)?.message ?? e));
}

/**
 * 我们发 Stop 之后,「已停止」要带着停止原因才算停稳;服务始终不给停止原因时,连续这么久都是「已停止」也算。
 * 2026-11-16 真环境实测(三个样本):跑稳的任务停下后 2 秒就带上停止原因;刚启动就被停的要 30–38 秒(中途可能弹回运行中)⇒ 取 60 秒。
 */
export const STOP_SETTLE_FALLBACK_MS = 60_000;

/** DMS 给的时刻(SDK 回 Date)⇒ 毫秒;没有 / 读不出 ⇒ null。 */
function dmsDateMs(d: unknown): number | null {
  return d instanceof Date && !Number.isNaN(d.getTime()) ? d.getTime() : null;
}

/**
 * DMS 说的「已停止」作不作数(停稳)。唯一作者:列表读时对账、详情状态路由与「停止」共用。
 * 2026-11-23 真环境每秒只读轮询量到的状态机:
 *   · 刚跑起来就被停:stopping → stopped(**没有停止原因**,持续 33 秒)→ running(弹回)→ stopping → stopped → 带上停止原因;
 *   · 跑稳后被停:stopped 先不带停止原因约 23 秒,随后同一刻带上停止原因、停止时刻也更新;
 *   · 再启动:进 starting 那一刻停止原因清空、最近一次启动时刻更新;
 *   · 弹回那种翻转在 DMS 自己的事件流里没有记录。同一天另一个账号:再启动 40 秒后读到一次「已停止」,而任务实际在跑。
 * ⇒ 停稳 = 状态 stopped + 带停止原因 +(两个时刻都读得到时)停止时刻不早于最近一次启动时刻。
 * 出错停下(停止原因含 ERROR)只看前两条:失败要尽快如实报出来,不拿时刻去拦它。
 */
export function isSettledStop(st: { status: string; stopReason?: string; startedAt: number | null; stoppedAt: number | null }): boolean {
  if (String(st.status || "").toLowerCase() !== "stopped") return false;
  const reason = String(st.stopReason || "");
  if (!reason) return false;
  if (/ERROR/i.test(reason)) return true;
  if (st.startedAt != null && st.stoppedAt != null && st.stoppedAt < st.startedAt) return false;
  return true;
}

/** 停 + 等终态 + (可选)删掉这个同步任务的 DMS 复制任务。
 *
 * 🔴🔴 **为什么必须有它**(2026-09-16 全仓核实):`StopReplicationTaskCommand` 在改动前
 *   **全仓零命中** —— 也就是说 DMS 通道(全量 / 增量 / 实时 CDC)**从来没被平台真正停过**:
 *   页面点「停止」只把 DDB 的 `status` 改成 `stopped`,而复制任务**继续把源库数据搬到目标区**、
 *   复制实例继续计费;删任务更狠 —— DDB 行一删,连它的 identifier 都没人记得了。
 *   在多法域下这就是**停不下来的跨境数据流动**(核心承诺被这一处击穿)。
 * 🔴 落点与命名都用**创建时那一套**:区由调用方按任务绑定解析(与启动同一个解析器,绑定在任务创建后不变),
 *   标识由 `names()` 派生。下线必须打在创建它的地方 —— 打到别的区只会查到「没有这个任务」,而真的那条还在搬数据。
 */
export async function teardownReplicationTask(
  site: DmsSite,
  taskId: string,
  opts: { purge: boolean; waitMs?: number } = { purge: false }
): Promise<DmsTeardownResult> {
  const { taskIdent } = names(taskId);
  const dms = await dmsClientFor(site.region);
  const NON_TERMINAL = ["running", "starting", "stopping", "modifying", "testing", "creating", "deleting"];
  let cur: { ReplicationTaskArn?: string; Status?: string; StopReason?: string;
             ReplicationTaskStartDate?: Date; ReplicationTaskStats?: { StopDate?: Date } } | undefined;
  try {
    const r = await dms.send(new DescribeReplicationTasksCommand({
      Filters: [{ Name: "replication-task-id", Values: [taskIdent] }],
    }));
    cur = r.ReplicationTasks?.[0];
  } catch {
    // ResourceNotFoundException ⇒ 本来就没有这个任务(不算失败:没有东西可下线)
    return { found: false, stopped: false, deleted: false };
  }
  if (!cur?.ReplicationTaskArn) return { found: false, stopped: false, deleted: false };
  const arn = cur.ReplicationTaskArn;
  let status = String(cur.Status || "");
  let stopReason = String(cur.StopReason || "");
  let startedAt = dmsDateMs(cur.ReplicationTaskStartDate);
  let stoppedAt = dmsDateMs(cur.ReplicationTaskStats?.StopDate);
  /** 有一次 Stop 发出去了、还没见分晓(这期间不重复发) */
  let stopSent = false;
  /** 本次下线发过 Stop(只有我们亲手停的任务才需要确认「停稳」) */
  let stopEver = false;
  /** 最近一次 Stop 之后读到过「已停止」(再回到运行中 = 那一次没停稳) */
  let sawStopped = false;
  /** 连续读到「已停止」的起点(毫秒;中途回到非终态就清零) */
  let stoppedSince = 0;
  let polls = 0;
  /** 重读一次:任务没了 ⇒ gone;读失败(限流之类)⇒ 状态未知,调用处沿用上一次的。 */
  const reread = async (): Promise<{ gone: boolean; status?: string; stopReason?: string; startedAt?: number | null; stoppedAt?: number | null }> => {
    let gone = false;
    const r = await dms.send(new DescribeReplicationTasksCommand({
      Filters: [{ Name: "replication-task-id", Values: [taskIdent] }],
    })).catch((e) => { gone = isTaskNotFound(e); return undefined; });
    if (gone || (r && !r.ReplicationTasks?.length)) return { gone: true };
    const t = r?.ReplicationTasks?.[0];
    return { gone: false, status: t?.Status ? String(t.Status) : undefined, stopReason: t ? String(t.StopReason || "") : undefined,
             startedAt: t ? dmsDateMs(t.ReplicationTaskStartDate) : undefined, stoppedAt: t ? dmsDateMs(t.ReplicationTaskStats?.StopDate) : undefined };
  };
  // 等终态(DMS 的启动 / 停止都是异步的;不等就去删会被服务拒 —— 与 serverless workflow 那条同款教训)
  // 🔴 默认只等 **20s**:不带 waitMs 的调用方跑在一次 HTTP 请求里,而入口(CloudFront/ALB)是 **60s 边缘超时**。
  //   原来默认 240s ⇒ 任务正在 creating/stopping 时请求必然 **504**(真环境实测:段 wp24 的
  //   WP24-3 拿到 504、平台行停在 provisioning)—— 而 504 是「不知道成没成」,最坏的一种答复。
  //   等不到终态就**如实回一个可重试的拒因**(见 teardown.ts 的 retryable);停止 / 删除路由走长操作,给的是分钟级预算。
  const deadline = Date.now() + (opts.waitMs ?? 20_000);
  // 🔴 每次休眠都要**被剩余预算夹住**:原来固定睡 5s ⇒ 即使预算只剩 30ms 也会先睡满 5s
  //   (判据里一条测试因此恒超时;生产里则是白占 5s 的请求时间)。
  for (;;) {
    // 🔴 只有「运行中」才发 Stop。DMS 不许停一个还在启动的任务(回「is currently not running」):
    //   2026-11-12 真环境,页面「启动」后立刻「删除」⇒ 对 starting 发 Stop 被拒 ⇒ 被当成「撤不下来」502,而任务根本没跑起来。
    //   启动中 / 创建中 / 修改中 ⇒ 留在循环里等它变成运行中(那时再停)或自己落到终态。
    if (NON_TERMINAL.includes(status)) {
      stoppedSince = 0;
      // 🔴 停过、也读到过「已停止」,却又回到运行中 ⇒ 那一次没停稳,再停一次。
      //   2026-11-16 真环境(任务刚进运行中几秒就被停):DMS 先报一次不带停止原因的「已停止」,约 8 秒后状态回到运行中 ——
      //   引擎这时才真正起来、把全量搬完 —— 再过约 30 秒才落到带停止原因的「已停止」。读到头一次就算数的话,
      //   页面说「已停止」而通道还在搬数据,用户紧接着点「启动」/「删除」正好撞上去。
      if (status === "running" && stopSent && sawStopped) { stopSent = false; sawStopped = false; }
    }
    if (status === "running" && !stopSent) {
      try {
        await dms.send(new StopReplicationTaskCommand({ ReplicationTaskArn: arn }));
        stopSent = true;
        stopEver = true;
      } catch (e) {
        // 读到 running 与发出 Stop 之间状态变了(刚跑完 / 刚失败 / 别人已停)⇒ 这不是下线失败,下一轮重读状态再判
        if (!isNotRunningRejection(e)) {
          return { found: true, stopped: false, deleted: false, finalStatus: status,
                   error: `StopReplicationTask 失败:${String((e as Error)?.message ?? e).slice(0, 240)}` };
        }
      }
    }
    if (!NON_TERMINAL.includes(status)) {
      // 到终态了:「停止」到此为止(我们亲手停的要先确认停稳);「删除」接着撤掉复制任务(撤不撤得掉由 DMS 说了算,被拒就回循环)
      if (!opts.purge) {
        // 停稳的记号见 isSettledStop;万一服务始终不给,连续 STOP_SETTLE_FALLBACK_MS 都是「已停止」也算。
        // 🔴 不论这次发没发过 Stop 都要停稳才算:2026-11-23 真环境,任务再启动 40 秒后读到一次不作数的「已停止」(引擎在跑)——
        //   只对「我们亲手停的」要求停稳的话,这时点「停止」会一个 Stop 都不发就回「已停止」,通道照跑。
        const unsettled = status === "stopped" && !isSettledStop({ status, stopReason, startedAt, stoppedAt });
        if (unsettled) {
          sawStopped = true;
          if (!stoppedSince) stoppedSince = Date.now();
        }
        if (!unsettled || Date.now() - stoppedSince >= STOP_SETTLE_FALLBACK_MS) {
          return { found: true, stopped: true, deleted: false, finalStatus: status };
        }
      } else {
        try {
          await dms.send(new DeleteReplicationTaskCommand({ ReplicationTaskArn: arn }));
          return { found: true, stopped: true, deleted: true, finalStatus: status };
        } catch (e) {
          // 🔴 读到终态与发出 Delete 之间状态可能变了:后台的启动编排恰好在这一瞬把任务启动(ready → starting),DMS 就会拒掉 Delete。
          //   那不是「撤不下来」⇒ 重读:任务已没了 = 目的达成;又回到非终态 = 回循环接着等(跑起来了就停、停稳了再删);
          //   状态没变还被拒(权限 / 服务故障)才如实报删除失败。
          const now = await reread();
          if (now.gone) return { found: true, stopped: true, deleted: true, finalStatus: "deleted" };
          if (!now.status || !NON_TERMINAL.includes(now.status)) {
            return { found: true, stopped: true, deleted: false, finalStatus: now.status ?? status,
                     error: `DeleteReplicationTask 失败:${String((e as Error)?.message ?? e).slice(0, 240)}` };
          }
          status = now.status;
          stopReason = now.stopReason ?? "";
          if (now.startedAt !== undefined) startedAt = now.startedAt;
          if (now.stoppedAt !== undefined) stoppedAt = now.stoppedAt;
          stopSent = false;
          continue;
        }
      }
    }
    const left = deadline - Date.now();
    if (left <= 0) break;
    // 轮询间隔 1s → 2s → 4s → 5s 封顶:已经在终态边上的任务不必白等 5 秒,真要等几分钟的也不会打爆 Describe
    await new Promise((r) => setTimeout(r, Math.min(5000, 1000 * 2 ** Math.min(polls++, 3), left)));
    const now = await reread();
    // 等的过程中任务没了(被别的操作删掉)⇒ 已经没有东西可下线,不必抱着旧状态等到预算耗尽
    if (now.gone) return { found: true, stopped: true, deleted: true, finalStatus: "deleted" };
    status = now.status ?? status;
    stopReason = now.stopReason ?? stopReason;
    if (now.startedAt !== undefined) startedAt = now.startedAt;
    if (now.stoppedAt !== undefined) stoppedAt = now.stoppedAt;
  }
  // 预算用完仍在非终态(启动中 / 停止中 / 删除中 …)或「已停止」还没停稳 ⇒ 如实回「没到终态」(调用方按可重试处理),绝不当成已下线
  return { found: true, stopped: false, deleted: false, finalStatus: status,
           error: `复制任务没到终态(status=${status}${NON_TERMINAL.includes(status) ? "" : ",还没停稳"})⇒ 拒绝当成已下线` };
}

export async function getTaskStatus(site: DmsSite, taskArn: string): Promise<string> {
  const dms = await dmsClientFor(site.region);
  const r = await dms.send(
    new DescribeReplicationTasksCommand({ Filters: [{ Name: "replication-task-arn", Values: [taskArn] }] })
  );
  return r.ReplicationTasks?.[0]?.Status || "unknown";
}

// 等复制任务进入可启动状态(ready/stopped/failed)。
// 踩坑:CreateReplicationTask 返回后任务仍处于 creating,立刻 StartReplicationTask 会报
//      "Replication Task cannot be started, invalid state"。须先轮询等任务就绪。
export async function waitTaskStartable(site: DmsSite, taskArn: string, maxTries = 30, intervalMs = 5000): Promise<string> {
  let status = "unknown";
  for (let i = 0; i < maxTries; i++) {
    status = await getTaskStatus(site, taskArn);
    if (["ready", "stopped", "failed"].includes(status)) return status;
    if (status === "running") return status; // 已在跑,无需再启动
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return status;
}

// 启动复制任务(DMS 要求任务处于 ready/stopped 且两端 test-connection 成功才能启动)。
// 幂等:已 running/starting 时跳过,避免 invalid state。首跑用 start-replication,
// 之前跑过(stopped)用 resume-processing 续传。
export async function startReplication(site: DmsSite, taskArn: string): Promise<void> {
  const status = await getTaskStatus(site, taskArn);
  if (status === "running" || status === "starting") return; // 已在跑,幂等跳过
  // DMS 状态机(实测):start-replication 仅对【从未跑过】的任务(ready)合法;
  // stopped → resume-processing 续跑;failed 等其余历史态 → reload-target 重做全量
  // (对 failed 发 start-replication 会被拒:"valid only for tasks running for the first time")。
  const startType = status === "ready" ? "start-replication"
    : status === "stopped" ? "resume-processing" : "reload-target";
  const dms = await dmsClientFor(site.region);
  await dms.send(
    new StartReplicationTaskCommand({
      ReplicationTaskArn: taskArn,
      StartReplicationTaskType: startType,
    })
  );
}

// 触发并等待两端连通性测试(start 前置)。返回各端当前状态快照,供调用方轮询。
//
// ⚠️ 关键:DMS test-connection 是异步的,对【已 successful】的端点再次 TestConnection 会把它
//    打回 testing。早期实现每轮无脑重测两端,导致一端刚成功就被下一轮打回,两端永远凑不齐
//    successful → 任务停在 ready(历史坑)。
//    正确做法:先读现状,**只对"既非 successful 也非 testing"的端点触发测试**(failed/未测/unknown),
//    已成功的不动,正在测的等它出结果。这样状态单调收敛到双 successful。
/** 两端连通性测试的现状;失败时带上 DMS 给的失败原文(「连不上」的原因只有它知道:网络不通 / 口令不对 / 库不存在 …)。 */
export interface EndpointConnectionSnapshot {
  source: string;
  target: string;
  sourceFailure?: string;
  targetFailure?: string;
}

/** 把连通性快照写成一句给人看的话(任务错误与运行日志共用;失败原文截到 200 字)。 */
export function describeEndpointConnections(c: EndpointConnectionSnapshot): string {
  const one = (label: string, status: string, failure?: string) =>
    `${label}=${status}${failure ? `(${failure.slice(0, 200)})` : ""}`;
  return `${one("源", c.source, c.sourceFailure)} ${one("目标", c.target, c.targetFailure)}`;
}

export async function testEndpoints(place: DmsPlace, sourceArn: string, targetArn: string): Promise<EndpointConnectionSnapshot> {
  const instanceArn = await getReplicationInstanceArn(place);
  const dms = await dmsClientFor(place.region);
  // 1) 先读当前连接状态快照。
  const snapshot = async (): Promise<EndpointConnectionSnapshot> => {
    const r = await dms.send(
      new DescribeConnectionsCommand({ Filters: [{ Name: "replication-instance-arn", Values: [instanceArn] }] })
    );
    const byArn = new Map((r.Connections || []).map((c) => [c.EndpointArn, c]));
    const of = (arn: string) => {
      const c = byArn.get(arn);
      const status = c?.Status || "unknown";
      const failure = status === "failed" ? String(c?.LastFailureMessage || "").trim() : "";
      return { status, failure };
    };
    const src = of(sourceArn);
    const tgt = of(targetArn);
    return {
      source: src.status,
      target: tgt.status,
      ...(src.failure ? { sourceFailure: src.failure } : {}),
      ...(tgt.failure ? { targetFailure: tgt.failure } : {}),
    };
  };
  const before = await snapshot();
  // 2) 只对需要测试的端点触发(已 successful 或正在 testing 的不动)。
  const needsTest = (status: string) => status !== "successful" && status !== "testing";
  for (const [arn, status] of [
    [sourceArn, before.source],
    [targetArn, before.target],
  ] as const) {
    if (!needsTest(status)) continue;
    try {
      await dms.send(new TestConnectionCommand({ ReplicationInstanceArn: instanceArn, EndpointArn: arn }));
    } catch {
      /* 并发已在测/速率限制等,忽略,下一轮快照会反映真实状态 */
    }
  }
  // 3) 返回触发后的最新快照 —— 但这一轮读到的「失败」不能丢:那是一次**已经出了结果**的测试,上面的重测只是把状态刷回 testing。
  //    只回触发后的快照的话,调用方永远看不到 failed(刚触发重测就是 testing):失败原文到不了任务错误,
  //    目标端认证失败后的「重设口令再测」也永远等不到它的触发条件。
  const after = await snapshot();
  const side = (was: string, wasFailure: string | undefined, now: string, nowFailure: string | undefined) =>
    was === "failed" ? { status: "failed", failure: wasFailure } : { status: now, failure: nowFailure };
  const src = side(before.source, before.sourceFailure, after.source, after.sourceFailure);
  const tgt = side(before.target, before.targetFailure, after.target, after.targetFailure);
  return {
    source: src.status,
    target: tgt.status,
    ...(src.failure ? { sourceFailure: src.failure } : {}),
    ...(tgt.failure ? { targetFailure: tgt.failure } : {}),
  };
}

/**
 * 把这一轮的快照并进「每一端最近一次**出了结果**的结论」:正在测 / 还没测不覆盖已有的结论,成功会清掉之前的失败原文。
 * 启动编排等到超时的时候用它写任务错误 —— 最后一轮多半正好停在「测试中」,只看最后一轮就把「为什么连不上」丢了。
 */
export function latestConnectionVerdict(prev: EndpointConnectionSnapshot, cur: EndpointConnectionSnapshot): EndpointConnectionSnapshot {
  const settled = (status: string) => status === "successful" || status === "failed";
  const side = (prevStatus: string, prevFailure: string | undefined, curStatus: string, curFailure: string | undefined) =>
    settled(curStatus) || !settled(prevStatus)
      ? { status: curStatus, failure: curStatus === "failed" ? curFailure : undefined }
      : { status: prevStatus, failure: prevFailure };
  const src = side(prev.source, prev.sourceFailure, cur.source, cur.sourceFailure);
  const tgt = side(prev.target, prev.targetFailure, cur.target, cur.targetFailure);
  return {
    source: src.status,
    target: tgt.status,
    ...(src.failure ? { sourceFailure: src.failure } : {}),
    ...(tgt.failure ? { targetFailure: tgt.failure } : {}),
  };
}

export interface RealtimeStatus {
  status: string; // running / stopped / failed ...
  fullLoadProgress: number; // 0-100
  cdcLatencySec: number | null; // CDC 端到端延迟(秒),全量阶段为 null
  tables: { schema: string; table: string; state: string; fullRows: number; inserts: number; updates: number; deletes: number }[];
  lastFailure?: string;
  /**
   * DMS 的 `StopReason` 原文(只有 stopped 态才有;实测形如 `Stop Reason FULL_LOAD_ONLY_FINISHED` / `Stop Reason FATAL_ERROR`)。
   * 🔴 终态判定要靠它分「全量跑完自然停」与「出错停了」—— 两者都是 stopped,只看进度 / lastFailure 会把
   *   「上次失败过、这次已重跑成功」的任务判死(lastFailure 会跨启动残留)。
   */
  stopReason?: string;
  /** 最近一次启动的时刻(DMS `ReplicationTaskStartDate`,毫秒;没启动过 / 读不出 ⇒ null)。「已停止」作不作数要拿它与停止时刻比(见 isSettledStop)。 */
  startedAt: number | null;
  /** 最近一次真停下的时刻(DMS `ReplicationTaskStats.StopDate`,毫秒;没停过 / 读不出 ⇒ null)。 */
  stoppedAt: number | null;
}

/** 复制任务的**轻量**状态(只 Describe 任务本体,不拉逐表统计)—— 列表读时对账用:每行每次刷新一次,不该拖逐表统计。 */
export type ReplicationTaskState = Pick<RealtimeStatus, "status" | "fullLoadProgress" | "lastFailure" | "stopReason" | "startedAt" | "stoppedAt">;

// 🔴 去任务绑定的那个区问(落点由调用方按任务绑定解析)。复制任务 ARN 里也写着它所在的区:两者必须一致 ——
//   ARN 读不出区、或与落点不是同一个区 ⇒ 如实回 null(详情页 unknown),既不猜主控区,也不拿着这个 ARN 去别的区问。
async function dmsClientOfTaskArn(site: DmsSite, taskArn: string) {
  const region = regionOfArn(taskArn, "dms");
  return region && region === site.region ? dmsClientFor(region) : null;
}

/** 复制任务本体的状态(status / 全量进度 / 最近失败 / 停止原因);任务不存在或查不动 ⇒ null(调用方不猜)。 */
export async function describeReplicationTaskState(site: DmsSite, taskArn: string): Promise<ReplicationTaskState | null> {
  try {
    const client = await dmsClientOfTaskArn(site, taskArn);
    if (!client) return null;
    const r = await client.send(new DescribeReplicationTasksCommand({ Filters: [{ Name: "replication-task-arn", Values: [taskArn] }] }));
    const t = r.ReplicationTasks?.[0];
    if (!t) return null;
    return {
      status: t.Status || "unknown",
      fullLoadProgress: t.ReplicationTaskStats?.FullLoadProgressPercent ?? 0,
      lastFailure: t.LastFailureMessage || undefined,
      stopReason: t.StopReason || undefined,
      startedAt: dmsDateMs(t.ReplicationTaskStartDate),
      stoppedAt: dmsDateMs(t.ReplicationTaskStats?.StopDate),
    };
  } catch {
    return null;
  }
}

// 回填实时任务运行态(CDC 延迟/行数/状态),供监控展示。task 不存在/未启动时返回 null。
export async function getReplicationStatus(site: DmsSite, taskArn: string): Promise<RealtimeStatus | null> {
  const state = await describeReplicationTaskState(site, taskArn);
  if (!state) return null;
  let tables: RealtimeStatus["tables"] = [];
  try {
    const client = await dmsClientOfTaskArn(site, taskArn);
    if (client) {
      const ts = await client.send(new DescribeTableStatisticsCommand({ ReplicationTaskArn: taskArn }));
      tables = (ts.TableStatistics || []).map((s) => ({
        schema: s.SchemaName || "",
        table: s.TableName || "",
        state: s.TableState || "",
        fullRows: s.FullLoadRows ?? 0,
        inserts: s.Inserts ?? 0,
        updates: s.Updates ?? 0,
        deletes: s.Deletes ?? 0,
      }));
    }
  } catch {
    /* table stats best-effort */
  }
  return {
    ...state,
    // CDC 延迟来自 CloudWatch 指标 CDCLatencyTarget(describe-task 不含),由调用方按需查 CW 补;
    // 此处不臆造数值,留 null,避免给监控展示假数据。
    cdcLatencySec: null,
    tables,
  };
}

/** 平台建的端点的标识形态:`bgp-src-` / `bgp-tgt-` + 任务 id 末 12 位(小写、只留字母数字);与 `names()` 同一份规则。 */
const PLATFORM_ENDPOINT_ID = /^bgp-(src|tgt)-([a-z0-9]{1,12})$/;

/** 平台端点标识里的任务短名(不是平台端点 ⇒ null)。 */
export function platformEndpointTaskShort(endpointId: string): string | null {
  return PLATFORM_ENDPOINT_ID.exec(String(endpointId || ""))?.[2] ?? null;
}

/** 任务 id ⇒ 它的 DMS 对象标识里用的短名(与 `names()` 同一份规则)。 */
export function dmsTaskShortOf(taskId: string): string {
  return names(taskId).srcId.slice("bgp-src-".length);
}

export interface PlatformEndpoint {
  arn: string;
  id: string;
  /** 标识里的任务短名 */
  taskShort: string;
}

/**
 * 列出该区里**平台建的**端点(按标识形态认;客户自己建的端点不在其列)。
 * 🔴 读不全就抛(翻页没翻完 / 读失败):清扫按「列全了」下结论,列不全时宁可这一轮不清。
 */
export async function listPlatformEndpoints(site: DmsSite): Promise<PlatformEndpoint[]> {
  const dms = await dmsClientFor(site.region);
  const out: PlatformEndpoint[] = [];
  let marker: string | undefined;
  for (let page = 0; ; page++) {
    if (page >= 50) throw new Error(`DMS 端点清单超过 50 页仍未列完(${site.region})⇒ 拒绝按不完整的清单下结论`);
    const r = await dms.send(new DescribeEndpointsCommand({ Marker: marker, MaxRecords: 100 }));
    for (const e of r.Endpoints ?? []) {
      const id = String(e.EndpointIdentifier ?? "");
      const taskShort = platformEndpointTaskShort(id);
      if (taskShort && e.EndpointArn) out.push({ arn: e.EndpointArn, id, taskShort });
    }
    marker = r.Marker;
    if (!marker) break;
  }
  return out;
}

/**
 * 删一个端点。回 `deleted`(本次删掉 / 已在删)· `absent`(确认本来就没有)· `in-use`(还被复制任务引用,DMS 拒删)。
 * 其它错误(权限 / 限流)照抛 —— 「删不动」不许被当成「删掉了」。
 */
export async function deletePlatformEndpoint(site: DmsSite, endpointArn: string): Promise<"deleted" | "absent" | "in-use"> {
  const dms = await dmsClientFor(site.region);
  try {
    await dms.send(new DeleteEndpointCommand({ EndpointArn: endpointArn }));
    return "deleted";
  } catch (e) {
    const name = String((e as { name?: string })?.name ?? "");
    if (name === "ResourceNotFoundFault") return "absent";
    if (name === "InvalidResourceStateFault") return "in-use";
    throw e;
  }
}

export { names as dmsResourceNames, tableMappings };
