// 实时数据集成 CDC 编排服务层。
//
// 把 R3/R4 用 CLI 手工打通的 DMS(MySQL→Redshift,full-load+CDC)编排固化为幂等代码,
// 内含 7 个实测踩坑的解法(见 docs/design/31-realtime-cdc/DESIGN.md §9b)。
//
// 设计:
//  - 纯编排,不创建常驻基建(DMS 复制实例/Kinesis 由门控的 BgpRealtimeStack 提供;本服务假定其已就绪)。
//  - 幂等:每步先查后建(endpoint/任务/用户/schema 重复调用安全)。
//  - 凭证零硬编码:源走数据源 secret;目标建专用 Redshift 用户 dms_ingest,密码随机生成、
//    存入 Secrets Manager(bgp/dms/redshift-target),绝不落代码/日志(红线②)。
//  - 控制面只编排;实时基建的常驻计费由调用方按需 enable/destroy(成本红线)。

import { homeRegion } from "@/lib/place/home-region";
// 散建客户端收口到唯一工厂(L3;行为保持:构造参数原样,见 lib/aws/clients.ts#sdkClient)
import { sdkClient } from "@/lib/aws/clients";
import {
  DatabaseMigrationServiceClient,
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
} from "@aws-sdk/client-database-migration-service";
import { EC2Client, DescribeSecurityGroupsCommand } from "@aws-sdk/client-ec2";
import { logger } from "@/lib/observability/logger";
// 复制任务状态按**任务 ARN 里的区**取客户端(见 dmsClientOfTaskArn)
import { dmsClientFor } from "@/lib/exec-env/target-clients";
import { regionOfArn } from "@/lib/aws/arn";

const region = homeRegion();
const dms = sdkClient("data-plane", DatabaseMigrationServiceClient, { region });
const ec2 = sdkClient("data-plane", EC2Client, { region });

// 复制实例 identifier(由 BgpRealtimeStack 固定为 bgp-dms;稳定不变)。
// ⚠️ 不再用静态 ARN env:实时栈每次 destroy/recreate,实例 ARN 都会变,
//    静态注入必然过期(历史坑)。改为运行时按 id 发现真实 ARN,根治漂移。
export const REPLICATION_INSTANCE_ID = process.env.DMS_REPLICATION_INSTANCE_ID || "bgp-dms";
// DMS 访问 secret / 写 Kinesis / Redshift COPY 用的角色(同一角色,信任 dms + 区域化 dms + redshift)。
const DMS_ROLE_ARN = process.env.DMS_ROLE_ARN || "";
// 懒创建实例的耐久依赖(BgpRealtimeStack 提供,固定名):子网组 + 安全组。
const DMS_SUBNET_GROUP_ID = process.env.DMS_SUBNET_GROUP_ID || "bgp-dms-subnet-group";
const DMS_SG_NAME = process.env.DMS_SG_NAME || "bgp-dms-sg";
// 懒创建规格(与原 BgpRealtimeStack 一致:该 region dms.t3.micro 不可订购,用 small;引擎 3.5.4)。
const DMS_INSTANCE_CLASS = process.env.DMS_INSTANCE_CLASS || "dms.t3.small";
const DMS_ENGINE_VERSION = process.env.DMS_ENGINE_VERSION || "3.5.4";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 复制实例 ARN 进程内缓存(ARN 在实例生命周期内不变)。
let _instanceArnCache = "";

// 按名查 bgp-dms-sg 的 SG id(懒创建 CreateReplicationInstance 需要 SG id,非名)。
async function findDmsSgId(): Promise<string | null> {
  try {
    const r = await ec2.send(
      new DescribeSecurityGroupsCommand({ Filters: [{ Name: "group-name", Values: [DMS_SG_NAME] }] })
    );
    return r.SecurityGroups?.[0]?.GroupId || null;
  } catch {
    return null;
  }
}

// 查复制实例(返回 {arn,status} 或 null)。
// ⚠️ DMS DescribeReplicationInstances 在按 filter 查不到时会**抛 ResourceNotFoundFault**(不是返回空数组),
//    必须捕获成 null,否则懒创建分支永远进不去(实测踩坑 2026-07-07)。
async function describeInstance(): Promise<{ arn: string; status: string } | null> {
  let r;
  try {
    r = await dms.send(
      new DescribeReplicationInstancesCommand({
        Filters: [{ Name: "replication-instance-id", Values: [REPLICATION_INSTANCE_ID] }],
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

/** 复制实例这些状态下不会再自己好起来(等也白等):探测与轮询两处用同一份(单一作者)。 */
export const REPLICATION_INSTANCE_BROKEN_STATUSES: readonly string[] = ["deleting", "failed", "incompatible-network"];

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
export async function probeReplicationInstance(): Promise<ReplicationInstanceProbe> {
  if (_instanceArnCache) return { status: "available", arn: _instanceArnCache, requestedCreate: false };

  let cur = await describeInstance();
  let requestedCreate = false;

  // 不存在 → 懒创建(只发起,不等)。
  if (!cur) {
    const sgId = await findDmsSgId();
    if (!sgId) {
      throw new Error(
        `DMS 安全组 ${DMS_SG_NAME} 未就绪(需先部署 BgpRealtimeStack 提供子网组/SG/角色等耐久基建)`
      );
    }
    logger.info?.("dms.instance.lazy_create", { id: REPLICATION_INSTANCE_ID, class: DMS_INSTANCE_CLASS });
    await dms.send(
      new CreateReplicationInstanceCommand({
        ReplicationInstanceIdentifier: REPLICATION_INSTANCE_ID,
        ReplicationInstanceClass: DMS_INSTANCE_CLASS,
        AllocatedStorage: 20,
        EngineVersion: DMS_ENGINE_VERSION,
        MultiAZ: false,
        PubliclyAccessible: false,
        ReplicationSubnetGroupIdentifier: DMS_SUBNET_GROUP_ID,
        VpcSecurityGroupIds: [sgId],
      })
    );
    requestedCreate = true;
    cur = await describeInstance();
  }
  if (cur?.status === "available") _instanceArnCache = cur.arn;
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

// 运行时发现复制实例 ARN(按稳定 id 查),解决 ARN 漂移。进程内缓存(ARN 在实例生命周期内不变)。
// **懒创建(2026-07-07 成本改造)**:实例不再随 BgpRealtimeStack 常驻。若 bgp-dms 不存在,则用栈提供的
// 固定名子网组 + SG 现场 CreateReplicationInstance(首次 10–15 分钟,实测 13.3 分钟),之后复用;用完可 delete 止血,
// 基建(子网组/SG/角色)留着零成本复用。若正在创建中(creating/modifying),轮询到 available。
export async function getReplicationInstanceArn(): Promise<string> {
  if (_instanceArnCache) return _instanceArnCache;

  const probe = await probeReplicationInstance();
  let cur: { arn: string; status: string } | null = probe.arn ? { arn: probe.arn, status: probe.status } : null;

  // 轮询到 available(首次冷建 10–15 分钟;调用方是长驻编排,可等)。
  // 上限 30 分钟(REPLICATION_INSTANCE_WAIT);超时抛错,由调用方决定重试(下次进来实例可能已 available,直接复用)。
  // 🔴 只许**后台编排**调本函数;HTTP 请求路径用 probeReplicationInstance()。
  for (let i = 0; i < REPLICATION_INSTANCE_WAIT.maxAttempts && cur && cur.status !== "available"; i++) {
    if (REPLICATION_INSTANCE_BROKEN_STATUSES.includes(cur.status)) {
      throw new Error(`DMS 复制实例 ${REPLICATION_INSTANCE_ID} 状态异常:${cur.status}`);
    }
    if (i > 0 && i % 15 === 0) {
      logger.info?.("dms.instance.waiting", { id: REPLICATION_INSTANCE_ID, status: cur.status, waitedSec: (i * REPLICATION_INSTANCE_WAIT.intervalMs) / 1000 });
    }
    await sleep(REPLICATION_INSTANCE_WAIT.intervalMs);
    cur = await describeInstance();
  }
  if (!cur || cur.status !== "available") {
    throw new Error(`DMS 复制实例 ${REPLICATION_INSTANCE_ID} 未就绪(当前状态 ${cur?.status || "缺失"},可稍后重试)`);
  }
  _instanceArnCache = cur.arn;
  return cur.arn;
}

export interface RealtimeTaskInput {
  taskId: string; // 平台同步任务 id(用于命名 DMS 资源,保证可追溯)
  sourceSecretArn: string; // 源 MySQL 凭证(数据源 secret;通常只含 username/password)
  sourceHost: string; // 源 MySQL 主机(数据源 secret 一般不含 host/port,故显式传入)
  sourcePort?: number; // 源 MySQL 端口(默认 3306)
  targetSecretArn: string; // 目标 Redshift 的 DMS 专用 secret(含 dms_ingest 完整字段)
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
async function findEndpointArn(endpointId: string): Promise<string | null> {
  try {
    const r = await dms.send(
      new DescribeEndpointsCommand({ Filters: [{ Name: "endpoint-id", Values: [endpointId] }] })
    );
    return r.Endpoints?.[0]?.EndpointArn || null;
  } catch {
    return null;
  }
}

// 建源 endpoint(MySQL,显式连接参数)。
// 踩坑(新账号实测):数据源 secret 通常只含 {username,password},缺 host/port —— DMS Secrets 模式
//   要求 secret 含完整字段,否则连通性测试报 "The 'port' parameter in the secret string is missing"。
//   故源端改用【显式参数】:从数据源 secret 取账密 + 用传入的 host/port 直连,绕开 secret 字段不全问题。
export async function ensureSourceEndpoint(input: RealtimeTaskInput): Promise<string> {
  const { srcId } = names(input.taskId);
  const existing = await findEndpointArn(srcId);
  if (existing) return existing;
  // 从数据源 secret 取账密(只读用一次,不落日志)。
  const { SecretsManagerClient, GetSecretValueCommand } = await import("@aws-sdk/client-secrets-manager");
  const sm = sdkClient("data-plane", SecretsManagerClient, { region });
  const sec = await sm.send(new GetSecretValueCommand({ SecretId: input.sourceSecretArn }));
  const creds = JSON.parse(sec.SecretString || "{}");
  if (!creds.username || !creds.password) {
    throw new Error("源数据源凭证缺少 username/password,无法建 DMS 源 endpoint");
  }
  const r = await dms.send(
    new CreateEndpointCommand({
      EndpointIdentifier: srcId,
      EndpointType: "source",
      EngineName: "mysql",
      ServerName: input.sourceHost,
      Port: input.sourcePort || 3306,
      Username: creds.username,
      Password: creds.password,
    })
  );
  logger.info("realtime.endpoint.source.created", { taskId: input.taskId, endpointId: srcId }); // 不记凭证
  return r.Endpoint!.EndpointArn!;
}

// 建目标 endpoint(Redshift,经 Secrets)。
// 踩坑④:目标 secret 必须含完整字段(host/port/database/username/password)且密码无 DMS 禁用字符 {},;
//        —— 由 ensureRedshiftDmsUser() 保证(建专用 dms_ingest 用户 + 写完整 secret)。
// 踩坑⑥:Redshift COPY 的 ServiceAccessRoleArn 必须已关联到 Redshift namespace(见 ensureRoleAssociatedToNamespace)。
export async function ensureTargetEndpoint(input: RealtimeTaskInput, stagingBucket: string): Promise<string> {
  const { tgtId } = names(input.taskId);
  const existing = await findEndpointArn(tgtId);
  if (existing) return existing;
  const r = await dms.send(
    new CreateEndpointCommand({
      EndpointIdentifier: tgtId,
      EndpointType: "target",
      EngineName: "redshift",
      RedshiftSettings: {
        SecretsManagerSecretId: input.targetSecretArn,
        SecretsManagerAccessRoleArn: DMS_ROLE_ARN,
        ServiceAccessRoleArn: DMS_ROLE_ARN,
        DatabaseName: "dev",
        BucketName: stagingBucket,
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
  input: RealtimeTaskInput,
  sourceArn: string,
  targetArn: string,
  migrationType: DmsMigrationType = "full-load-and-cdc",
  taskSettings?: DmsTaskSettings
): Promise<string> {
  const { taskIdent } = names(input.taskId);
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
  const replicationInstanceArn = await getReplicationInstanceArn();
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

/** 停 + 等终态 + (可选)删掉这个同步任务的 DMS 复制任务。
 *
 * 🔴🔴 **为什么必须有它**(2026-09-16 全仓核实):`StopReplicationTaskCommand` 在改动前
 *   **全仓零命中** —— 也就是说 DMS 通道(全量 / 增量 / 实时 CDC)**从来没被平台真正停过**:
 *   页面点「停止」只把 DDB 的 `status` 改成 `stopped`,而复制任务**继续把源库数据搬到目标区**、
 *   复制实例继续计费;删任务更狠 —— DDB 行一删,连它的 identifier 都没人记得了。
 *   在多法域下这就是**停不下来的跨境数据流动**(核心承诺被这一处击穿)。
 * 🔴 客户端与命名都用**创建时那一套**(本文件顶部的 home 客户端 + `names()`):
 *   下线必须打在创建它的地方 —— 「换一个更正确的解析器」会去停一个根本不存在的任务。
 */
export async function teardownReplicationTask(
  taskId: string,
  opts: { purge: boolean; waitMs?: number } = { purge: false }
): Promise<DmsTeardownResult> {
  const { taskIdent } = names(taskId);
  const NON_TERMINAL = ["running", "starting", "stopping", "modifying", "testing", "creating", "deleting"];
  let cur: { ReplicationTaskArn?: string; Status?: string } | undefined;
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
  let stopped = false;
  let status = String(cur.Status || "");
  if (status === "running" || status === "starting") {
    try {
      await dms.send(new StopReplicationTaskCommand({ ReplicationTaskArn: arn }));
    } catch (e) {
      return { found: true, stopped: false, deleted: false, finalStatus: status,
               error: `StopReplicationTask 失败:${String((e as Error)?.message ?? e).slice(0, 240)}` };
    }
  }
  // 等终态(DMS 停止是异步的;不等就去删会被服务拒 —— 与 serverless workflow 那条同款教训)
  // 🔴 默认只等 **20s**:这段代码跑在一次 HTTP 请求里,而入口(CloudFront/ALB)是 **60s 边缘超时**。
  //   原来默认 240s ⇒ 任务正在 creating/stopping 时请求必然 **504**(真环境实测:段 wp24 的
  //   WP24-3 拿到 504、平台行停在 provisioning)—— 而 504 是「不知道成没成」,最坏的一种答复。
  //   现在:等不到终态就**如实回一个可重试的拒因**,让调用方稍后再点(见 teardown.ts 的 retryable)。
  const deadline = Date.now() + (opts.waitMs ?? 20_000);
  // 🔴 每次休眠都要**被剩余预算夹住**:原来固定睡 5s ⇒ 即使预算只剩 30ms 也会先睡满 5s
  //   (判据里一条测试因此恒超时;生产里则是白占 5s 的请求时间)。
  for (;;) {
    const r2 = await dms.send(new DescribeReplicationTasksCommand({
      Filters: [{ Name: "replication-task-id", Values: [taskIdent] }],
    })).catch(() => undefined);
    status = String(r2?.ReplicationTasks?.[0]?.Status || status);
    if (!NON_TERMINAL.includes(status)) break;
    const left = deadline - Date.now();
    if (left <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(5000, left)));
  }
  stopped = !NON_TERMINAL.includes(status);
  if (!stopped) {
    return { found: true, stopped: false, deleted: false, finalStatus: status,
             error: `复制任务没到终态(status=${status})⇒ 拒绝当成已下线` };
  }
  if (!opts.purge) return { found: true, stopped: true, deleted: false, finalStatus: status };
  try {
    await dms.send(new DeleteReplicationTaskCommand({ ReplicationTaskArn: arn }));
  } catch (e) {
    return { found: true, stopped: true, deleted: false, finalStatus: status,
             error: `DeleteReplicationTask 失败:${String((e as Error)?.message ?? e).slice(0, 240)}` };
  }
  return { found: true, stopped: true, deleted: true, finalStatus: status };
}

export async function getTaskStatus(taskArn: string): Promise<string> {
  const r = await dms.send(
    new DescribeReplicationTasksCommand({ Filters: [{ Name: "replication-task-arn", Values: [taskArn] }] })
  );
  return r.ReplicationTasks?.[0]?.Status || "unknown";
}

// 等复制任务进入可启动状态(ready/stopped/failed)。
// 踩坑:CreateReplicationTask 返回后任务仍处于 creating,立刻 StartReplicationTask 会报
//      "Replication Task cannot be started, invalid state"。须先轮询等任务就绪。
export async function waitTaskStartable(taskArn: string, maxTries = 30, intervalMs = 5000): Promise<string> {
  let status = "unknown";
  for (let i = 0; i < maxTries; i++) {
    status = await getTaskStatus(taskArn);
    if (["ready", "stopped", "failed"].includes(status)) return status;
    if (status === "running") return status; // 已在跑,无需再启动
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return status;
}

// 启动复制任务(DMS 要求任务处于 ready/stopped 且两端 test-connection 成功才能启动)。
// 幂等:已 running/starting 时跳过,避免 invalid state。首跑用 start-replication,
// 之前跑过(stopped)用 resume-processing 续传。
export async function startReplication(taskArn: string): Promise<void> {
  const status = await getTaskStatus(taskArn);
  if (status === "running" || status === "starting") return; // 已在跑,幂等跳过
  // DMS 状态机(实测):start-replication 仅对【从未跑过】的任务(ready)合法;
  // stopped → resume-processing 续跑;failed 等其余历史态 → reload-target 重做全量
  // (对 failed 发 start-replication 会被拒:"valid only for tasks running for the first time")。
  const startType = status === "ready" ? "start-replication"
    : status === "stopped" ? "resume-processing" : "reload-target";
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
export async function testEndpoints(sourceArn: string, targetArn: string): Promise<{ source: string; target: string }> {
  const instanceArn = await getReplicationInstanceArn();
  // 1) 先读当前连接状态快照。
  const snapshot = async () => {
    const r = await dms.send(
      new DescribeConnectionsCommand({ Filters: [{ Name: "replication-instance-arn", Values: [instanceArn] }] })
    );
    const byArn = new Map((r.Connections || []).map((c) => [c.EndpointArn, c.Status || "unknown"]));
    return { source: byArn.get(sourceArn) || "unknown", target: byArn.get(targetArn) || "unknown" };
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
  // 3) 返回触发后的最新快照。
  return await snapshot();
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
}

/** 复制任务的**轻量**状态(只 Describe 任务本体,不拉逐表统计)—— 列表读时对账用:每行每次刷新一次,不该拖逐表统计。 */
export type ReplicationTaskState = Pick<RealtimeStatus, "status" | "fullLoadProgress" | "lastFailure" | "stopReason">;

// 🔴 客户端按**复制任务 ARN 里的区**取,不再用模块级的主控区客户端:DMS 通道今天按合同只在主控区
//   (start-realtime 对非 home 章 409 CHANNEL_NOT_PUSHED_DOWN)⇒ ARN 的区 == 主控区,行为不变;但「去哪个区问」的真值
//   本来就写在 ARN 里 —— 等 DMS 逐区下推那天这里不需要再改。ARN 读不出区 ⇒ 如实回 null(详情页 unknown),不猜主控区。
async function dmsClientOfTaskArn(taskArn: string) {
  const region = regionOfArn(taskArn, "dms");
  return region ? dmsClientFor(region) : null;
}

/** 复制任务本体的状态(status / 全量进度 / 最近失败 / 停止原因);任务不存在或查不动 ⇒ null(调用方不猜)。 */
export async function describeReplicationTaskState(taskArn: string): Promise<ReplicationTaskState | null> {
  try {
    const client = await dmsClientOfTaskArn(taskArn);
    if (!client) return null;
    const r = await client.send(new DescribeReplicationTasksCommand({ Filters: [{ Name: "replication-task-arn", Values: [taskArn] }] }));
    const t = r.ReplicationTasks?.[0];
    if (!t) return null;
    return {
      status: t.Status || "unknown",
      fullLoadProgress: t.ReplicationTaskStats?.FullLoadProgressPercent ?? 0,
      lastFailure: t.LastFailureMessage || undefined,
      stopReason: t.StopReason || undefined,
    };
  } catch {
    return null;
  }
}

// 回填实时任务运行态(CDC 延迟/行数/状态),供监控展示。task 不存在/未启动时返回 null。
export async function getReplicationStatus(taskArn: string): Promise<RealtimeStatus | null> {
  const state = await describeReplicationTaskState(taskArn);
  if (!state) return null;
  let tables: RealtimeStatus["tables"] = [];
  try {
    const client = await dmsClientOfTaskArn(taskArn);
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

export { names as dmsResourceNames, tableMappings };
