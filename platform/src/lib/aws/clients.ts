// @kf-batch 50-WP31-place-first-class
// WP-31 序 1 —— **数据面 AWS 客户端的唯一工厂**(L3)。
//
// ── 为什么是这里、而不是再造一个 ────────────────────────────────────────────────
// 按区缓存的客户端早就有了(`exec-env/target-clients.ts` 的 `xxxClientFor(region)` 14 个服务),
// 但「怎么 new」散在那 14 个函数里各写一遍,另外还有 108 处在业务文件里自己 `new XxxClient(`
// (其中 46 个是模块级单例 —— B-26 就是一个)。本文件把「构造 + 按区缓存 + 挂越区断言」收成**一处**:
// `target-clients.ts` 的那些函数改成薄委托(调用方一个字不用改),业务文件里的散建由序 3 按引擎迁过来,
// 棘轮 `place-ratchets.test.ts` 只减不增。
//
// ── 越区断言(SDK v3 官方 middleware,initialize 步)────────────────────────────
// 每个工厂客户端挂一个 `bgpPlaceGuard`:有显式落点上下文(`runInPlace` / `withPlace`)且
// **客户端区 ≠ 落点区** ⇒ 拦截模式下抛 `CrossRegionDataPlaneCall`,**一个网络请求都不发**(D5 实测)。
// 模式由 `BGP_PLACE_GUARD` 决定:缺省 `observe`(只记录,不拦)—— 序 6 才切 `enforce`。
// 观测模式下这里什么都不做:全局观测器(`place/observer.ts`)在 SDK 底层 `send` 上看**所有**客户端
// (包括还没迁过来的散建客户端),记录只有那一个作者,不在这里重复记。

import { RedshiftDataClient } from "@aws-sdk/client-redshift-data";
import { currentPlace } from "@/lib/place/context";
import { CrossRegionDataPlaneCall, type Place } from "@/lib/place/types";
import type { CentralComponent } from "@/lib/place/central";
// @kf-batch 50-WP31-seq5-dataplane-role —— 序 5:数据面凭证只在这里注入(代入该区执行环境的平台数据面角色)
import { dataPlaneCredsMode, roleCredentialProvider, withObserveFallback, type TempCreds } from "@/lib/aws/dataplane-creds";

/** AWS region 字面形态(`us-east-1` / `ap-southeast-1` / `cn-north-1`);`lib/aws/arn.ts` 读 ARN 的区时复用同一份,不再各写一遍。 */
export const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d$/;

// ── 序 57 / B-129 ③:SDK 客户端的网络预算(**唯一作者**;两个工厂入口 regionalClient / sdkClient 与 Redshift Data / DynamoDB / STS 都从这里拿)──
//
// 第四十七轮实测:平台进程里一次 IAM GetRole 在 CreateSecret 之后**空档 64 秒**才到达 IAM(CloudTrail),同窗口 CPU 14%、无限流、无 5xx。
// 64 秒 ≈ TCP 建连 SYN 重传序列 1+2+4+8+16+32(⚪ 推理:AWS SDK v3 缺省 connectionTimeout = 0 = 没有预算,内核重传到第 7 个 SYN 才通);
// 没有预算就只能干等,而外层 CloudFront 60 秒就 504。这里给**所有**工厂客户端显式预算,让一跳停顿秒级失败,交给 SDK 标准重试
// (full jitter,有界 maxAttempts)—— 建连阶段失败重试**不会**重复副作用(请求根本没发出去)。
//   · connectionTimeout 5 s:TCP / TLS 建连,任何服务都不该超过;
//   · socketTimeout 60 s:已建连但对端持续无字节(连接半死);只给控制面 / 数据面 / 中心件;
//     🔴 model / central:agentcore **不设**空闲超时 —— 模型推理(Kimi 首字 3–39 s、Converse 整体可到分钟级)与智能体流式响应会在
//     合法地沉默,空闲超时在那里就是把慢回答误判成故障;它们的墙由模块 55 长操作框架 / 智能体自己的预算管。
//   · 调用方显式给了 requestHandler / maxAttempts(单测、特殊客户端)⇒ 尊重,不覆盖。
export const SDK_NETWORK_BUDGET = Object.freeze({
  connectionTimeoutMs: 5_000,
  socketTimeoutMs: 60_000,
  maxAttempts: 3,
});

/** 哪些用途不设空闲超时(推理 / 智能体流式响应会合法沉默)。 */
function allowsLongSilence(use: ClientUse): boolean {
  return use === "model" || use === "central:agentcore";
}

/**
 * 把网络预算并进客户端构造参数(调用方给了 requestHandler / maxAttempts 就原样保留)。
 * requestHandler 用 SDK 认的**配置对象**形态(`NodeHttpHandler.create(options)`),不在这里 import 传递依赖 @smithy/node-http-handler。
 */
export function withNetworkBudget<T extends Record<string, unknown>>(use: ClientUse, cfg: T): T & { requestHandler: Record<string, unknown>; maxAttempts: number } {
  const requestHandler = (cfg.requestHandler ?? {
    connectionTimeout: SDK_NETWORK_BUDGET.connectionTimeoutMs,
    ...(allowsLongSilence(use) ? {} : { socketTimeout: SDK_NETWORK_BUDGET.socketTimeoutMs }),
  }) as Record<string, unknown>;
  const maxAttempts = typeof cfg.maxAttempts === "number" ? cfg.maxAttempts : SDK_NETWORK_BUDGET.maxAttempts;
  return { ...cfg, requestHandler, maxAttempts };
}

/** 工厂认识的数据面服务(封闭集合;加服务 = 在 LOADERS 加一行)。 */
export type DataPlaneService =
  | "athena"
  | "glue"
  | "s3"
  | "s3tables"
  | "emrServerless"
  | "redshiftServerless"
  | "logs"
  | "kda"
  | "kinesis"
  | "dms"
  | "rds"
  // @kf-batch 41-B115-netadvisor-place —— Redshift provisioned 集群(网络顾问解析目标 VPC / SG):区域服务,按落点 region 建
  | "redshift"
  | "cloudwatch"
  | "ec2"
  | "secrets"
  // @kf-batch 50-WP30-decommission —— 删除执行环境收口要在**目标区**真查栈 / 经典 MWAA(WP-31 L3:不许在工厂外散建客户端)
  | "cloudformation"
  | "mwaa";
// 🔴 B-47(序 36 真环境实测):CodeBuild / IAM 曾在这里(候选区组织策略探测)。它们是**主控区控制面**调用,
//   进了数据面集合 ⇒ observe 下每次模拟先用数据面角色发一次被拒、再用任务角色重发 ⇒ IAM 请求量翻倍、限流把候选区
//   打成「未能核实」(B-46 复发);enforce 下直接不通。控制面一律 `sdkClient("control-plane", …)`,不许回到这里。

type ClientOf = {
  athena: import("@aws-sdk/client-athena").AthenaClient;
  glue: import("@aws-sdk/client-glue").GlueClient;
  s3: import("@aws-sdk/client-s3").S3Client;
  s3tables: import("@aws-sdk/client-s3tables").S3TablesClient;
  emrServerless: import("@aws-sdk/client-emr-serverless").EMRServerlessClient;
  redshiftServerless: import("@aws-sdk/client-redshift-serverless").RedshiftServerlessClient;
  logs: import("@aws-sdk/client-cloudwatch-logs").CloudWatchLogsClient;
  kda: import("@aws-sdk/client-kinesis-analytics-v2").KinesisAnalyticsV2Client;
  kinesis: import("@aws-sdk/client-kinesis").KinesisClient;
  dms: import("@aws-sdk/client-database-migration-service").DatabaseMigrationServiceClient;
  rds: import("@aws-sdk/client-rds").RDSClient;
  redshift: import("@aws-sdk/client-redshift").RedshiftClient;
  cloudwatch: import("@aws-sdk/client-cloudwatch").CloudWatchClient;
  ec2: import("@aws-sdk/client-ec2").EC2Client;
  secrets: import("@aws-sdk/client-secrets-manager").SecretsManagerClient;
  cloudformation: import("@aws-sdk/client-cloudformation").CloudFormationClient;
  mwaa: import("@aws-sdk/client-mwaa").MWAAClient;
};

type Ctor<T> = new (cfg: { region: string }) => T;

// 🔴 动态 import:与原 target-clients 同样的取舍 —— 只用到 Athena 的路由不该把 14 个 SDK 都加载进来。
const LOADERS: { [K in DataPlaneService]: () => Promise<Ctor<ClientOf[K]>> } = {
  athena: async () => (await import("@aws-sdk/client-athena")).AthenaClient,
  glue: async () => (await import("@aws-sdk/client-glue")).GlueClient,
  s3: async () => (await import("@aws-sdk/client-s3")).S3Client,
  s3tables: async () => (await import("@aws-sdk/client-s3tables")).S3TablesClient,
  emrServerless: async () => (await import("@aws-sdk/client-emr-serverless")).EMRServerlessClient,
  redshiftServerless: async () => (await import("@aws-sdk/client-redshift-serverless")).RedshiftServerlessClient,
  logs: async () => (await import("@aws-sdk/client-cloudwatch-logs")).CloudWatchLogsClient,
  kda: async () => (await import("@aws-sdk/client-kinesis-analytics-v2")).KinesisAnalyticsV2Client,
  kinesis: async () => (await import("@aws-sdk/client-kinesis")).KinesisClient,
  dms: async () => (await import("@aws-sdk/client-database-migration-service")).DatabaseMigrationServiceClient,
  rds: async () => (await import("@aws-sdk/client-rds")).RDSClient,
  redshift: async () => (await import("@aws-sdk/client-redshift")).RedshiftClient,
  cloudwatch: async () => (await import("@aws-sdk/client-cloudwatch")).CloudWatchClient,
  ec2: async () => (await import("@aws-sdk/client-ec2")).EC2Client,
  secrets: async () => (await import("@aws-sdk/client-secrets-manager")).SecretsManagerClient,
  cloudformation: async () => (await import("@aws-sdk/client-cloudformation")).CloudFormationClient,
  mwaa: async () => (await import("@aws-sdk/client-mwaa")).MWAAClient,
};

export type PlaceGuardMode = "observe" | "enforce";

/** 只认两个值;其它一律 observe(拼错不许变成「拦截全开」也不许变成「完全关掉」以外的第三态)。 */
export function placeGuardMode(): PlaceGuardMode {
  return process.env.BGP_PLACE_GUARD === "enforce" ? "enforce" : "observe";
}

function assertRegion(region: string, what: string): void {
  if (!region || !REGION_RE.test(region)) {
    throw new Error(`非法 region:${JSON.stringify(region)}(${what} 客户端必须按落点的 region 建)`);
  }
}

interface StackLike {
  middlewareStack: { add: (mw: unknown, opts: Record<string, unknown>) => void };
}

/**
 * 给一个客户端挂越区断言。导出只为单测与 DynamoDB 文档客户端(它包着一个底层客户端)。
 * 🔴 判的是**调用时**的上下文(D3:模块级单例构造时没有请求上下文,构造时判等于没判)。
 */
export function attachPlaceGuard(client: StackLike, clientRegion: string): void {
  // 只有单测里的假客户端会没有 middlewareStack(真 SDK 客户端恒有);它们本来就不发网络请求。
  if (typeof client?.middlewareStack?.add !== "function") return;
  client.middlewareStack.add(
    (next: (a: unknown) => Promise<unknown>, context: { clientName?: string; commandName?: string }) =>
      async (args: unknown) => {
        if (placeGuardMode() === "enforce") {
          const p: Place | undefined = currentPlace();
          if (p && p.region !== clientRegion) {
            throw new CrossRegionDataPlaneCall({
              service: String(context.clientName ?? "?"),
              operation: String(context.commandName ?? "?"),
              clientRegion,
              placeRegion: p.region,
              targetId: p.targetId,
            });
          }
        }
        return next(args);
      },
    { step: "initialize", name: "bgpPlaceGuard", override: true }
  );
}

// ── 序 5:数据面凭证(三态见 dataplane-creds.ts)──────────────────────────────────────────────
type StsLike = { send: (c: unknown) => Promise<{ Credentials?: { AccessKeyId?: string; SecretAccessKey?: string; SessionToken?: string; Expiration?: Date } }> };
let stsClient: StsLike | null = null;

/** 代入数据面角色(STS 在主控区;它本身是控制面调用,用任务角色)。 */
async function assumeViaSts(roleArn: string, sessionName: string): Promise<TempCreds> {
  const { STSClient, AssumeRoleCommand } = await import("@aws-sdk/client-sts");
  if (!stsClient) {
    const { getControlPlaneContext } = await import("@/lib/exec-env/aws-context");
    stsClient = new STSClient(withNetworkBudget("control-plane", { region: (await getControlPlaneContext()).region })) as unknown as StsLike;
  }
  const out = await stsClient.send(new AssumeRoleCommand({ RoleArn: roleArn, RoleSessionName: sessionName, DurationSeconds: 3600 }));
  const c = out.Credentials;
  if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken || !c.Expiration) {
    throw new Error(`AssumeRole(${roleArn}) 没回完整凭证`);
  }
  return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken, expiration: new Date(c.Expiration) };
}

/**
 * 数据面客户端的构造(唯一作者):按 `BGP_DATAPLANE_CREDS` 注入凭证。
 *   taskrole ⇒ `make(cfg)` 原样(现状)· enforce ⇒ 只用角色凭证 · observe ⇒ 角色先发、被拒用任务角色重发(记账)。
 * 🔴 调用方自己给了 `credentials` ⇒ 尊重它(那是显式身份,例如数据源自带凭证),不覆盖。
 */
function buildDataPlane<C>(make: (cfg: Record<string, unknown>) => C, cfg: Record<string, unknown>, region: string): C {
  const mode = dataPlaneCredsMode();
  if (mode === "taskrole" || cfg.credentials !== undefined) return make(cfg);
  const primary = make({ ...cfg, credentials: roleCredentialProvider(region, assumeViaSts) });
  return mode === "enforce" ? primary : withObserveFallback(primary, make(cfg), region);
}

const caches = new Map<string, unknown>();
const redshiftDataCache = new Map<string, RedshiftDataClient>();

/** 某区某服务的客户端(按 `服务|区` 缓存;一区一套 ⇒ 区即 target。凭证按角色 ARN 缓存在 dataplane-creds,删了重注册换新角色)。 */
export async function regionalClient<K extends DataPlaneService>(service: K, region: string): Promise<ClientOf[K]> {
  assertRegion(region, service);
  const key = `${service}|${region}`;
  let c = caches.get(key) as ClientOf[K] | undefined;
  if (!c) {
    const C = await LOADERS[service]();
    c = buildDataPlane((cfg) => {
      const x = new C(cfg as { region: string });
      attachPlaceGuard(x as unknown as StackLike, region);
      return x;
    }, withNetworkBudget("data-plane", { region }), region);
    caches.set(key, c);
  }
  return c;
}

/** Redshift Data 客户端(同步取:既有调用方 `redshiftDataClientFor` 是同步签名)。 */
export function redshiftDataClient(region: string): RedshiftDataClient {
  assertRegion(region, "Redshift Data");
  let c = redshiftDataCache.get(region);
  if (!c) {
    c = buildDataPlane((cfg) => {
      const x = new RedshiftDataClient(cfg as { region: string });
      attachPlaceGuard(x as unknown as StackLike, region);
      return x;
    }, withNetworkBudget("data-plane", { region }), region);
    redshiftDataCache.set(region, c);
  }
  return c;
}

type DocClientT = import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient;
const docCache = new Map<string, DocClientT>();

/** 某区的 DynamoDB 文档客户端(区域审计表 / 区域结果表在该 target 所在区)。marshall 选项与主控区 docClient 同一份。 */
export async function dynamoDocClient(region: string): Promise<DocClientT> {
  assertRegion(region, "DynamoDB");
  let c = docCache.get(region);
  if (!c) {
    const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
    const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
    c = buildDataPlane((cfg) => {
      const base = new DynamoDBClient(cfg as { region: string });
      attachPlaceGuard(base as unknown as StackLike, region);
      return DynamoDBDocumentClient.from(base, { marshallOptions: { removeUndefinedValues: true } });
    }, withNetworkBudget("data-plane", { region }), region);
    docCache.set(region, c);
  }
  return c;
}

/**
 * 按落点取数据面客户端(L3 的目标形态):`(await dataPlane(place).athena()).send(…)`。
 * 🔴 只收 `Place`(解析过的落点),不收 region 字符串 —— 拿不到 Place 就说明落点没决策,该在上游报错。
 */
export function dataPlane(place: Place): { [K in DataPlaneService]: () => Promise<ClientOf[K]> } & {
  redshiftData: () => RedshiftDataClient;
} {
  const out = { redshiftData: () => redshiftDataClient(place.region) } as Record<string, unknown>;
  for (const s of Object.keys(LOADERS) as DataPlaneService[]) out[s] = () => regionalClient(s, place.region);
  return out as ReturnType<typeof dataPlane>;
}

// ── 散建客户端的唯一构造入口(WP-31 序 3 收尾:散建迁入工厂)─────────────────────────────
//
// 业务文件里原来有一百多处自己 `new XxxClient(cfg)`:各自决定区、各自决定挂不挂断言(实际一个都没挂)。
// 它们不都是「按区缓存的数据面客户端」—— 有平台自己的表 / 身份 / 通知(控制面)、有模型推理、有中心件,
// 也有每次新建、带特殊选项的数据面客户端。一律塞进 `regionalClient` 会改掉它们的缓存语义与选项(行为变化),
// 所以给一个**只收口构造、不改行为**的入口:
//
//     const s3 = sdkClient("data-plane", S3Client, { region });
//
//   · 🔴 行为保持:构造参数**原样**交给 SDK(不补 region、不改选项、不缓存 —— 调用方原来是模块单例还是每次新建,照旧);
//     唯一例外 = 序 57 / B-129 ③ 的网络预算(withNetworkBudget:connectionTimeout / socketTimeout / maxAttempts),调用方没给才补;
//   · `use` 是**封闭集合**,写明「这个客户端为什么在这个区」(读代码的人一眼分得清「按落点」与「主控区控制面 / 中心件」);
//   · 只有 `data-plane` 挂越区断言(拦截模式下按调用时的落点核验;观测模式什么都不做)。区不是合法区名(例如用户填错的
//     数据源区)⇒ 不挂断言、照常构造 —— 与原来 `new` 的行为逐字相同,错误照旧在 send 时由 SDK 报;
//   · 序 5 按 target 代入角色:凭证注入点就是这一个函数(`buildDataPlane`),而不是一百多处。

/** 客户端用途(封闭集合;加一类 = 又多一种「不按落点」的理由,要说清为什么)。 */
export type ClientUse =
  /** 数据面:区 = 这次调用的落点(或数据源 / 资源自己的区)。挂越区断言。 */
  | "data-plane"
  /** 平台控制面:主控区的平台自有表 / 身份(Cognito)/ 通知(SES)/ 账号上下文(STS)/ IAM(全局)/ 平台自身指标。 */
  | "control-plane"
  /** 大模型推理 / 模型目录:区由模型配置(或目录的落点)决定,不由请求的执行落点决定。 */
  | "model"
  /** 中心件(用户拍板全平台只有一个,只在主控区;清单见 place/central.ts)。 */
  | `central:${CentralComponent}`;

export function sdkClient<C, A extends unknown[]>(use: ClientUse, Ctor: new (...args: A) => C, ...args: A): C {
  const region = (args[0] as { region?: unknown } | undefined)?.region;
  // 序 57 / B-129 ③:第一个构造参数并入网络预算(调用方给了就不覆盖);其余参数原样
  const budgeted = [withNetworkBudget(use, (args[0] ?? {}) as Record<string, unknown>), ...args.slice(1)] as unknown as A;
  if (use !== "data-plane" || typeof region !== "string" || !REGION_RE.test(region)) return new Ctor(...budgeted);
  // 序 5:数据面且区合法 ⇒ 经唯一作者注入凭证(taskrole 模式下与原来 `new` 逐字相同)
  return buildDataPlane((cfg) => {
    const c = new Ctor(...([cfg, ...args.slice(1)] as unknown as A));
    attachPlaceGuard(c as unknown as StackLike, region);
    return c;
  }, budgeted[0] as Record<string, unknown>, region);
}

/** 单测 / 排障用。 */
export function __resetClients(): void {
  caches.clear();
  redshiftDataCache.clear();
  docCache.clear();
}
