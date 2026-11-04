// @kf-batch 50-WP31-place-first-class
// WP-31 序 1/2 —— 全局落点观测器(L9 观测模式):量「真实越区调用清单」,不靠 grep。
//
// ── 它看什么 ─────────────────────────────────────────────────────────────────────
// 装在 Node 的出站 HTTP 诊断通道上(见 installPlaceObserver 的理由)⇒ 不论客户端是工厂建的、业务文件里散建的、
// 还是模块级单例(B-26 那种),每一次打到 AWS 端点的请求都经过这里。每次请求记下:
//   · 客户端在哪个区;· 本请求「应该在哪儿」(显式上下文 > 解析函数的决策记账 > URL 视角);
//   · 入参里点名的资源(工作组 / 桶 / 应用 / 流 …)按描述符反查归谁。
// 然后判:越区(cross-region)/ 资源与客户端不同区(resource-region-mismatch)/ 碰了别的 target 的资源
// (foreign-resource)/ 在非主控区视角下走了「没传 = 主控区」(implicit-home-under-target-view)/ 判不了(unattributed)。
//
// ── 三条不许破的规矩 ─────────────────────────────────────────────────────────────
// ① **永不影响调用本身**:判定在调用发出之后异步做,任何异常都吞掉(观测器坏了不许把业务带坏)。
// ② **记录只有这一个作者**:工厂的 middleware 在观测模式下什么都不做(见 aws/clients.ts)。
// ③ **它不是决策来源**:业务代码不许读它的任何状态来决定在哪儿执行。
//
// 🔴 D11/D12 演练(2026-10-01):SDK 客户端在打包后分属多个基类副本,装在 `send` 上必然漏(S3 Tables 实测漏);
//    `http.client.request.start` 在请求**真正发出**时触发(DNS 失败就不触发),ALS 上下文在那一刻仍可读。

import { CENTRAL_COMPONENT_RESOURCES, matchesCentralPrefix } from "./central";
// 序 31 二刀 ⑤:零 import 叶子(观测器在 instrumentation 可达面上,不能 import 带 AWS SDK 的 deploy-control)
import { EXEC_ENV_CODEBUILD_LOG_GROUP } from "@/lib/exec-env/exec-env-project-name";
import { SCOPE_PARAM, parseScope, type TargetScope } from "@/lib/scope/scope";
import { currentPlace, currentRequestStore, decisionsOfCurrentRequest, type PlaceDecision } from "./context";

import { OBSERVE_URL_HEADER } from "./observe-header";

/**
 * 主控区里「本来就只在主控区」的控制面服务(serviceId)。只有**客户端在主控区**时才豁免;
 * 同一个服务的客户端若建在别的区,说明它在做那个区的事 ⇒ 照常判。
 */
export const CONTROL_PLANE_SERVICES: ReadonlySet<string> = new Set([
  // AWS 端点主机名的服务标签(`<标签>.<区>.amazonaws.com`)
  "dynamodb", // 注册表 / 台账 / 项目等控制面表
  "sts",
  "cognito-idp",
  "ssm",
  "bedrock-runtime",
  "bedrock",
  "bedrock-agent-runtime",
  "bedrock-agentcore",
  "bedrock-agentcore-control",
  "codebuild",
  "ecs",
  "cloudformation",
  "lambda",
  "states",
])

/**
 * 主控区里按「服务.操作」才能判定为控制面的调用(同一服务的别的操作是数据面)。
 * `monitoring.PutMetricData` = 平台**自身**的业务遥测,只往主控区发(第九轮实测 ~45 次,原来全被当成越区,淹没真信号);
 * 而 `monitoring.GetMetricStatistics` 读的是某个区的作业指标 ⇒ 仍按区判。
 * `s3.ListBuckets` = 账号级清点(全球命名空间,结果不分区、不含数据;唯一消费点 = 系统设置「服务状态」数桶,`/api/s3/buckets`
 *   走控制面轴,序 31 三刀 IAM 侧 2026-10-21)—— 测试账号 observe 实测它是 unattributedTop 仅剩的 1 类;S3 的别的操作(GetObject /
 *   ListObjects / PutObject …)碰的都是某个区的桶 ⇒ 仍按区判,不许整块豁免 s3。
 */
export const CONTROL_PLANE_OPERATIONS: ReadonlySet<string> = new Set([
  "monitoring.PutMetricData",
  "s3.ListBuckets",
  // 序 31 二刀 ⑤:`ec2.DescribeRegions` = 账号级清点(这个账号启用了哪些 region;结果不分区、不含数据),唯一消费点 = 执行环境候选区
  //   `/api/admin/exec-envs/candidate-regions`(控制面轴 + 主控区客户端);EC2 的别的操作(DescribeSubnets / DescribeVpcs …)碰的都是
  //   某个区的网络事实 ⇒ 仍按区判,不许整块豁免 ec2。Query 协议的操作名由 `queryProtocolAction` 从表单体读出(此前全记成 `ec2.POST /`)。
  "ec2.DescribeRegions",
]);

/**
 * 序 31 二刀 ⑤:主控区里按「服务.操作 + **日志组名**」才算控制面的调用 —— 执行环境部署的 CodeBuild 日志
 * (`/aws/codebuild/bgp-exec-env-deploy`:CodeBuild 在主控区跑,日志组也在主控区)。读它的路由(build-status / probe / preview)
 * 决策记的是**目标区**(`readBuildStatus` 替那个 target 做事),客户端却在主控区 ⇒ 观测器把每次读日志都记成 cross-region
 * (测试账号三天 23 条违规全部是它,而它恰恰不是越区)。日志组是平台自己的控制面产物,与 ACTION_DISPATCH 密钥同一口径。
 * 🔴 不许整块豁免 logs:作业日志(Glue / EMR / Flink)在各自的区,越区读才是真违规;日志组名必须**全部**命中(同 isControlPlaneSecretCall)。
 */
export const CONTROL_PLANE_LOG_GROUPS: ReadonlySet<string> = new Set([EXEC_ENV_CODEBUILD_LOG_GROUP]);
const CONTROL_PLANE_LOG_OPERATIONS: ReadonlySet<string> = new Set(["GetLogEvents", "FilterLogEvents", "DescribeLogStreams"]);

function isControlPlaneLogCall(f: CallFacts): boolean {
  if (f.service !== "logs" || !CONTROL_PLANE_LOG_OPERATIONS.has(f.operation)) return false;
  return f.resourceIds.length > 0 && f.resourceIds.every((id) => CONTROL_PLANE_LOG_GROUPS.has(id));
}

/**
 * 序 31 第二刀 ②:主控区里按「服务.操作 + **资源名**」才算控制面的调用 —— 平台**自身**的内部端点共享密钥
 * (`ACTION_DISPATCH_SECRET_ARN`,推进泵 / 内部守卫每 5 分钟读一次;第四十三轮 observe 实测 16 次请求外 + 8 次 sweep 路由)。
 * 🔴 不许整块豁免 secretsmanager:数据源密钥(`bgp/datasource/*`)越区才是真违规(central.ts 文件头同一条理由)。
 * 密钥 ARN 由部署期注入 env,这里**不另抄名字**:索引装载时把 env 里那一个 ARN 的资源 token 收进 `controlSecretIds`,
 * 调用入参里的 SecretId 全部命中才算(同 isCentralComponentCall 的「资源名必须全部命中」口径)。
 */
export function controlPlaneSecretTokens(arn: string | undefined): ReadonlySet<string> {
  const v = typeof arn === "string" ? arn.trim() : "";
  return new Set(v ? resourceTokens(v) : []);
}

function isControlPlaneSecretCall(f: CallFacts, idx: TargetIndex): boolean {
  const ids = idx.controlSecretIds;
  if (!ids || ids.size === 0) return false;
  if (f.service !== "secretsmanager" || f.operation !== "GetSecretValue") return false;
  return f.resourceIds.length > 0 && f.resourceIds.every((id) => ids.has(id));
}

/** 判定类别。前四类是**违规**(计入 `CrossRegionDataPlaneCall` 指标)。 */
export type ObservationKind =
  | "cross-region"
  | "resource-region-mismatch"
  | "foreign-resource"
  | "implicit-home-under-target-view"
  | "unattributed"
  | "control"
  | "ok";

export const VIOLATION_KINDS: ReadonlySet<ObservationKind> = new Set<ObservationKind>([
  "cross-region",
  "resource-region-mismatch",
  "foreign-resource",
  "implicit-home-under-target-view",
]);

/** 描述符反查索引:targetId → region;资源值 → 归属 targetId(同一个值属于多个 target 的不收,免得误判)。 */
export interface TargetIndex {
  readonly homeTargetId: string;
  readonly regionOf: ReadonlyMap<string, string>;
  readonly ownerOf: ReadonlyMap<string, string>;
  /** 全局资源(ARN 的 region 段为空,如 IAM 角色):它没有「在哪个区」,不参与「资源与客户端不同区」判定 */
  readonly globalIds: ReadonlySet<string>;
  /** 序 31 第二刀 ②:平台自身控制面密钥的资源 token(见 controlPlaneSecretTokens);缺 ⇒ 不豁免任何密钥读取 */
  readonly controlSecretIds?: ReadonlySet<string>;
}

export interface CallFacts {
  service: string;
  operation: string;
  clientRegion: string;
  explicit?: { targetId: string; region: string };
  decisions: readonly PlaceDecision[];
  view: TargetScope | null;
  resourceIds: readonly string[];
}

export interface Verdict {
  kinds: ObservationKind[];
  expected: { source: "context" | "decision" | "view"; targets: string[]; regions: string[] } | null;
  owners: { id: string; targetId: string; region: string | undefined }[];
}

/** 纯函数:一次调用的判定(单测主战场)。 */
/** 中心件里按资源名声明过的调用(唯一声明处 central.ts);资源名必须**全部**命中,一个都没抽到不算。 */
function isCentralComponentCall(f: CallFacts): boolean {
  const decl = CENTRAL_COMPONENT_RESOURCES.filter((c) => c.service === f.service && c.operation === f.operation);
  return decl.length > 0 && f.resourceIds.length > 0 && f.resourceIds.every((id) => decl.some((c) => matchesCentralPrefix(id, c.idPrefix)));
}

export function judgeCall(f: CallFacts, idx: TargetIndex): Verdict {
  const homeRegion = idx.regionOf.get(idx.homeTargetId);
  const owners = f.resourceIds
    .map((id) => ({ id, targetId: idx.ownerOf.get(id) }))
    .filter((o): o is { id: string; targetId: string } => typeof o.targetId === "string")
    .map((o) => ({ ...o, region: idx.regionOf.get(o.targetId) }));

  let expected: Verdict["expected"] = null;
  if (f.explicit) {
    expected = { source: "context", targets: [f.explicit.targetId], regions: [f.explicit.region] };
  } else {
    const named = Array.from(new Set(f.decisions.map((d) => d.targetId).filter((t): t is string => !!t)));
    if (named.length) {
      expected = { source: "decision", targets: named, regions: named.map((t) => idx.regionOf.get(t) ?? "?") };
    } else if (f.view?.kind === "target") {
      expected = { source: "view", targets: [f.view.targetId], regions: [idx.regionOf.get(f.view.targetId) ?? "?"] };
    }
  }

  const kinds: ObservationKind[] = [];
  const viewTarget = f.view?.kind === "target" ? f.view.targetId : null;
  // 全局端点(IAM / 全局 STS)没有区可言 ⇒ 不参与区判定;主控区的控制面调用(读注册表等)本来就该在主控区。
  // 🔴 控制面调用连「隐式主控区」也不报:本机冒烟实测,解析层读注册表那次 DynamoDB 调用会被算成一条违规,
  //    而真正有问题的是紧随其后的那次数据面调用(它照样会被报)。
  const isControl =
    f.clientRegion === "global" ||
    (homeRegion !== undefined &&
      f.clientRegion === homeRegion &&
      (CONTROL_PLANE_SERVICES.has(f.service) ||
        CONTROL_PLANE_OPERATIONS.has(`${f.service}.${f.operation}`) ||
        isCentralComponentCall(f) ||
        isControlPlaneSecretCall(f, idx) ||
        isControlPlaneLogCall(f)));
  if (!isControl) {
    if (viewTarget && viewTarget !== idx.homeTargetId && f.decisions.some((d) => d.targetId === null)) {
      kinds.push("implicit-home-under-target-view");
    }
    if (expected && !expected.regions.includes(f.clientRegion)) kinds.push("cross-region");
    for (const o of owners) {
      if (o.region && !idx.globalIds.has(o.id) && o.region !== f.clientRegion && !kinds.includes("resource-region-mismatch")) {
        kinds.push("resource-region-mismatch");
      }
      if (expected && !expected.targets.includes(o.targetId) && !kinds.includes("foreign-resource")) {
        kinds.push("foreign-resource");
      }
    }
  }
  if (kinds.length === 0) kinds.push(isControl ? "control" : expected ? "ok" : "unattributed");
  return { kinds, expected, owners };
}

// ── 入参里点名的资源 ─────────────────────────────────────────────────────────────

/** 认这些键(封闭集合;加键 = 加一行)。值可以是名字、ARN、s3:// URI、`s3tablescatalog/<桶>`。 */
const RESOURCE_INPUT_KEYS = new Set([
  "WorkGroup", "WorkgroupName", "workgroupName", "Bucket", "tableBucketARN", "TableBucketARN",
  "ApplicationName", "StreamName", "StreamARN", "SecretId", "SecretArn", "OutputLocation", "Catalog",
  "CatalogName", "ScriptLocation", "executionRoleArn", "Role", "ServiceExecutionRole", "entryPoint",
  // 序 31 二刀 ⑤:CloudWatch Logs 的日志组(控制面日志组豁免要靶向到名字;流名不收 —— 它不决定归属)
  "logGroupName", "logGroupIdentifier",
]);

/** 一个值 → 候选资源 token(原值 + 能抽出来的桶名 / ARN 末段)。 */
export function resourceTokens(v: string): string[] {
  const out = new Set<string>([v]);
  const s3 = /^s3a?:\/\/([^/]+)/.exec(v);
  if (s3) out.add(s3[1]);
  const cat = /^s3tablescatalog\/(.+)$/.exec(v);
  if (cat) out.add(cat[1]);
  if (v.startsWith("arn:")) {
    const tail = v.split(":").slice(5).join(":");
    const seg = tail.split("/");
    if (seg.length > 1) out.add(seg[seg.length - 1]);
    if (seg[0] && seg.length > 1) out.add(seg[1]);
  }
  return Array.from(out);
}

export function extractResourceIds(input: unknown): string[] {
  const out = new Set<string>();
  const walk = (o: unknown, depth: number) => {
    if (!o || typeof o !== "object" || depth > 3) return;
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (typeof v === "string" && RESOURCE_INPUT_KEYS.has(k)) for (const t of resourceTokens(v)) out.add(t);
      else if (v && typeof v === "object" && !Array.isArray(v)) walk(v, depth + 1);
    }
  };
  walk(input, 0);
  return Array.from(out);
}

/** 由描述符建索引。太短的值(如数据库名 `dev`)与多个 target 共有的值不进 ownerOf(无法唯一归属)。 */
export function buildTargetIndex(
  targets: readonly { targetId: string; region?: unknown; resources?: Record<string, unknown> }[],
  homeTargetId: string,
  opts: { controlSecretIds?: ReadonlySet<string> } = {}
): TargetIndex {
  const regionOf = new Map<string, string>();
  const owner = new Map<string, string | null>();
  const globalIds = new Set<string>();
  for (const t of targets) {
    if (typeof t.region === "string" && t.region) regionOf.set(t.targetId, t.region);
    const vals: string[] = [];
    for (const v of Object.values(t.resources ?? {})) {
      if (typeof v === "string") vals.push(v);
      else if (Array.isArray(v)) for (const x of v) if (typeof x === "string") vals.push(x);
    }
    for (const v of vals) {
      const isGlobal = /^arn:aws[\w-]*:[a-z0-9-]+::/.test(v);
      for (const tok of resourceTokens(v)) {
        if (isGlobal) globalIds.add(tok);
        if (tok.length < 6) continue;
        const prev = owner.get(tok);
        owner.set(tok, prev === undefined || prev === t.targetId ? t.targetId : null);
      }
    }
  }
  const ownerOf = new Map<string, string>();
  owner.forEach((v, k) => {
    if (v) ownerOf.set(k, v);
  });
  return { homeTargetId, regionOf, ownerOf, globalIds, ...(opts.controlSecretIds ? { controlSecretIds: opts.controlSecretIds } : {}) };
}

// ── 索引装载(注册表,60s 缓存;装载本身走的 DynamoDB 调用也会被观测 —— 判为 control,不死锁)──────

type IndexLoader = () => Promise<TargetIndex>;
let loader: IndexLoader = async () => {
  const { listTargetsRaw, HOME_TARGET_ID } = await import("@/lib/exec-env/registry");
  // 序 31 第二刀 ②:平台自身的控制面密钥 ARN 与读它的两处(dataplane-jobs/pump · scheduler/internal-guard)同一个 env 键
  return buildTargetIndex(await listTargetsRaw(), HOME_TARGET_ID, {
    controlSecretIds: controlPlaneSecretTokens(process.env.ACTION_DISPATCH_SECRET_ARN),
  });
};
let cached: { at: number; idx: TargetIndex } | null = null;
let inflight: Promise<TargetIndex> | null = null;
const INDEX_TTL_MS = 60_000;

async function currentIndex(): Promise<TargetIndex | null> {
  if (cached && Date.now() - cached.at < INDEX_TTL_MS) return cached.idx;
  if (!inflight) {
    inflight = loader()
      .then((idx) => {
        cached = { at: Date.now(), idx };
        return idx;
      })
      .finally(() => {
        inflight = null;
      });
  }
  try {
    return await inflight;
  } catch {
    return cached?.idx ?? null; // 注册表读不到:用旧索引;连旧的都没有就跳过本次判定(计 index-unavailable)
  }
}

// ── 记录 ─────────────────────────────────────────────────────────────────────────

export interface ObservationRecord {
  verdict: Verdict;
  facts: CallFacts;
  url: string | null;
  stack: string[];
}

type Sink = (line: Record<string, unknown>) => void;
let sink: Sink = (line) => {
  try {
    process.stdout.write(JSON.stringify(line) + "\n");
  } catch {
    /* 观测器永不抛 */
  }
};

const counts = new Map<string, number>();
const unattributed = new Map<string, number>();
const recentViolations = new Map<string, number>();
const DEDUPE_MS = 60_000;
let indexUnavailable = 0;
const pending = new Set<Promise<void>>();

/** 单测用:等所有已发出调用的判定落账。 */
export async function __drainObserver(): Promise<void> {
  while (pending.size) await Promise.all(Array.from(pending));
}

function bump(m: Map<string, number>, k: string, n = 1) {
  m.set(k, (m.get(k) ?? 0) + n);
}

function record(r: ObservationRecord): void {
  for (const k of r.verdict.kinds) bump(counts, `${k}|${r.facts.service}`);
  const violations = r.verdict.kinds.filter((k) => VIOLATION_KINDS.has(k));
  if (violations.length === 0) {
    if (r.verdict.kinds.includes("unattributed")) {
      bump(unattributed, `${r.facts.service}.${r.facts.operation} ${pathOf(r.url) ?? "(请求外)"}`);
    }
    return;
  }
  const key = `${violations.join(",")}|${r.facts.service}.${r.facts.operation}|${pathOf(r.url)}|${r.stack[0] ?? ""}`;
  const last = recentViolations.get(key);
  const now = Date.now();
  if (last !== undefined && now - last < DEDUPE_MS) {
    bump(counts, "suppressed");
    return;
  }
  recentViolations.set(key, now);
  if (recentViolations.size > 2000) recentViolations.clear();
  sink({
    event: "place.observe.violation",
    // EMF:CloudWatch Logs 自动把它提成指标 BGP/Place CrossRegionDataPlaneCall{Kind}(PL-1 的真值来源)
    _aws: {
      Timestamp: now,
      CloudWatchMetrics: [
        { Namespace: "BGP/Place", Dimensions: [["Kind"]], Metrics: [{ Name: "CrossRegionDataPlaneCall", Unit: "Count" }] },
      ],
    },
    Kind: violations[0],
    CrossRegionDataPlaneCall: 1,
    kinds: violations,
    service: r.facts.service,
    operation: r.facts.operation,
    clientRegion: r.facts.clientRegion,
    expected: r.verdict.expected,
    decisions: r.facts.decisions.slice(0, 8),
    view: r.facts.view,
    owners: r.verdict.owners,
    // 资源**名**(工作组 / 桶 / 密钥 ARN 等,不含任何值;S3 的 body 本来就不解析)—— 归不了属的也要看得见,
    //   否则「中心件密钥(合法)」与「数据源密钥越区(违规)」在清单里长得一模一样(第九轮实测)
    resourceIds: r.facts.resourceIds.slice(0, 12),
    url: r.url,
    stack: r.stack,
  });
}

function pathOf(url: string | null): string | null {
  if (!url) return null;
  const q = url.indexOf("?");
  return q < 0 ? url : url.slice(0, q);
}

/** 汇总(每分钟打一行;单测直接调)。 */
export function placeObservationSummary(): Record<string, unknown> {
  const top = Array.from(unattributed.entries()).sort((a, b) => b[1] - a[1]).slice(0, 25);
  return {
    event: "place.observe.summary",
    counts: Object.fromEntries(counts),
    unattributedTop: Object.fromEntries(top),
    indexUnavailable,
  };
}

function appStack(): string[] {
  const raw = (new Error().stack ?? "").split("\n").slice(1);
  return raw
    .map((l) => l.trim())
    .filter((l) => !/node_modules|node:internal|place\/observer|\(native\)/.test(l))
    .slice(0, 6);
}

function headerOf(store: object | undefined, name: string): string | null {
  try {
    const h = (store as { headers?: { get?: (n: string) => string | null } } | undefined)?.headers;
    return typeof h?.get === "function" ? h.get(name) : null;
  } catch {
    return null;
  }
}

function viewOf(url: string | null): TargetScope | null {
  if (!url) return null;
  try {
    return parseScope(new URL(url, "http://x").searchParams.get(SCOPE_PARAM));
  } catch {
    return null;
  }
}

/** 一个出站请求里观测器要的那几样(Node `http.ClientRequest` 的子集,单测用假的)。 */
export interface OutboundRequestLike {
  method?: string;
  path?: string;
  host?: string;
  getHeader(name: string): unknown;
}

/**
 * AWS 端点主机名 → 服务标签 + 区 + (S3 虚拟主机式的)桶名。不是 AWS 端点 ⇒ null(E11 非 SDK 通道另算)。
 * 全局端点(`iam.amazonaws.com` / `sts.amazonaws.com`)⇒ region = "global"。
 */
export function parseAwsHost(rawHost: string): { service: string; region: string; bucket?: string } | null {
  const host = rawHost.toLowerCase().replace(/:\d+$/, "");
  if (!/\.amazonaws\.com(\.cn)?$/.test(host)) return null;
  const m = /^(?:(.+)\.)?([a-z0-9-]+)\.([a-z]{2}(?:-[a-z]+)+-\d)\.amazonaws\.com(?:\.cn)?$/.exec(host);
  if (m) {
    const [, prefix, label, region] = m;
    if (label === "s3" || label.startsWith("s3-")) return { service: "s3", region, ...(prefix ? { bucket: prefix } : {}) };
    // `<bucket>.s3.dualstack.<region>` / `bucket.s3-accesspoint.<region>` 之类:label 不是 s3 但前缀里有
    if (prefix && /(^|\.)s3(\.|-|$)/.test(label + "." + prefix)) return { service: "s3", region };
    return { service: label.replace(/-fips$/, ""), region };
  }
  const g = /^([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?$/.exec(host);
  return g ? { service: g[1], region: "global" } : null;
}

/** 请求体里的资源:JSON 协议才解析(S3 的 body 是用户数据,**永不读**);另扫一遍 ARN 字面量。 */
export function resourceIdsOfBody(service: string, body: string | undefined): string[] {
  if (!body || service === "s3") return [];
  const out = new Set<string>();
  const t = body.trim();
  if (t.startsWith("{")) {
    try {
      for (const id of extractResourceIds(JSON.parse(t))) out.add(id);
    } catch {
      /* 截断的 JSON:只靠下面的 ARN 扫描 */
    }
  }
  for (const m of Array.from(t.matchAll(/arn:aws[\w-]*:[a-z0-9-]+:[a-z0-9-]*:\d{12}:[^"\s,}\]]+/g))) {
    for (const tok of resourceTokens(m[0])) out.add(tok);
  }
  return Array.from(out);
}

/** Query 协议表单体里的操作名(`Action=DescribeRegions&Version=…` / `…&Action=…`);JSON / XML / 空体 ⇒ null。 */
export function queryProtocolAction(body: string | undefined): string | null {
  if (!body) return null;
  const t = body.trimStart();
  if (t.startsWith("{") || t.startsWith("<")) return null;
  const m = /(?:^|&)Action=([A-Za-z][A-Za-z0-9]*)(?=&|$)/.exec(t.slice(0, 4096));
  return m ? m[1] : null;
}

/** 由一个出站请求抽出判定所需的静态事实(纯函数)。 */
export function requestFacts(
  req: OutboundRequestLike,
  body: string | undefined
): { service: string; operation: string; clientRegion: string; resourceIds: string[] } | null {
  const hostHeader = req.getHeader("host");
  const aws = parseAwsHost(String(hostHeader ?? req.host ?? ""));
  if (!aws) return null;
  const path = String(req.path ?? "/");
  const target = req.getHeader("x-amz-target");
  const xid = /[?&]x-id=([A-Za-z]+)/.exec(path)?.[1];
  // 序 31 二刀 ⑤:Query 协议(EC2 / RDS / IAM …)既没有 x-amz-target 也没有 x-id,操作名在表单体 `Action=<Op>&…` 里;
  //   不读它就全记成 `ec2.POST /`,「DescribeRegions(账号级清点)」与「DescribeSubnets(某区网络事实)」在清单里长得一模一样。
  const queryAction = queryProtocolAction(body);
  const operation =
    typeof target === "string" && target.includes(".")
      ? target.slice(target.lastIndexOf(".") + 1)
      : xid ?? queryAction ?? `${String(req.method ?? "GET").toUpperCase()} ${path.split("?")[0].slice(0, 60)}`;
  const ids = new Set<string>(resourceIdsOfBody(aws.service, body));
  if (aws.bucket) ids.add(aws.bucket);
  // 路径里的 ARN(S3 Tables 把表桶 ARN 编码在路径上)与路径式 S3 的桶名
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    /* 保持原样 */
  }
  for (const m of Array.from(decoded.matchAll(/arn:aws[\w-]*:[a-z0-9-]+:[a-z0-9-]*:\d{12}:[^?\s]+/g))) {
    for (const tok of resourceTokens(m[0].split("/").slice(0, 2).join("/"))) ids.add(tok);
  }
  if (aws.service === "s3" && !aws.bucket) {
    const seg = decoded.split("?")[0].split("/")[1];
    if (seg) ids.add(seg);
  }
  return { service: aws.service, operation, clientRegion: aws.region, resourceIds: Array.from(ids) };
}

const BODY = Symbol.for("bgp.placeObserver.body");
// 🔴 原型上的「已装」标记必须是**另一个** symbol:用同一个的话,没写 body 的请求会从原型上继承到 `true`
//    (本机单测当场撞到:`body.trim is not a function` ⇒ 整条判定被吞掉,观测器静默失明)。
const END_PATCHED = Symbol.for("bgp.placeObserver.endPatched");
const MAX_BODY = 16 * 1024;

/**
 * 出站请求真正发出时调(`http.client.request.start`)。上下文与请求存储在这里仍可读(D12 实测),
 * 判定留给异步段。永不抛。
 */
export function onRequestStart(req: OutboundRequestLike): void {
  try {
    const own = (req as { [BODY]?: unknown })[BODY];
    const f = requestFacts(req, typeof own === "string" ? own : undefined);
    if (!f) return;
    const p = currentPlace();
    const store = currentRequestStore();
    const url = headerOf(store, OBSERVE_URL_HEADER);
    const { decisions } = decisionsOfCurrentRequest();
    const stack = appStack();
    const job = (async () => {
      try {
        const idx = await currentIndex();
        if (!idx) {
          indexUnavailable++;
          return;
        }
        const facts: CallFacts = {
          ...f,
          ...(p ? { explicit: { targetId: p.targetId, region: p.region } } : {}),
          decisions,
          view: viewOf(url),
        };
        record({ verdict: judgeCall(facts, idx), facts, url, stack });
      } catch {
        /* 观测器永不抛 */
      }
    })();
    pending.add(job);
    void job.finally(() => pending.delete(job));
  } catch {
    /* 观测器永不抛 */
  }
}

let installed = false;
let summaryTimer: ReturnType<typeof setInterval> | null = null;

type BuiltinGetter = (id: string) => unknown;

/**
 * 进程启动时装(instrumentation,nodejs 运行时)。`BGP_PLACE_OBSERVE=off` 可关。
 *
 * 🔴 为什么装在 Node 的 HTTP 层而不是 SDK 的 `send` 上(2026-10-01 本机 standalone 冒烟实测):
 *    Next 打包后 SDK 客户端分属**至少三个**不同的基类副本(打包进来的两份 + 外置 S3 的原生一份),
 *    按种子客户端去装只装上了 3 个 —— 而 S3 Tables 的调用**一次都没被看见**。基类副本数取决于打包细节,
 *    枚举不全(同 [[gate-enumerates-violations-not-legal-form]])。而 Node 的 `http` 模块全进程只有一份,
 *    官方诊断通道 `http.client.request.start` 对**每一个**出站请求都发事件 ⇒ 不依赖任何打包细节。
 * 🔴 `process.getBuiltinModule`(Node ≥ 20.16)而不是 import:import node 内置会让 instrumentation 的
 *    edge 编译直接失败(instrumentation-bundle-guard);拿不到就记一行 unavailable,不挡启动。
 * 请求体:事件发出时 body 已写进 socket ⇒ 在 `ClientRequest.prototype.end` 上顺手留一份(只留 AWS 主机、≤16KB,
 *    S3 的 body 是用户数据,解析时一律跳过)。
 */
export async function installPlaceObserver(getBuiltin?: BuiltinGetter): Promise<boolean> {
  if (process.env.BGP_PLACE_OBSERVE === "off" || installed) return installed;
  const get = getBuiltin ?? (process as unknown as { getBuiltinModule?: BuiltinGetter }).getBuiltinModule?.bind(process);
  if (typeof get !== "function") {
    sink({ event: "place.observe.unavailable", reason: "process.getBuiltinModule 不存在(Node < 20.16)" });
    return false;
  }
  const dc = get("node:diagnostics_channel") as { subscribe?: (name: string, fn: (m: unknown) => void) => void };
  const http = get("node:http") as { ClientRequest?: { prototype: { end: (...a: unknown[]) => unknown } } };
  if (typeof dc?.subscribe !== "function" || !http?.ClientRequest) {
    sink({ event: "place.observe.unavailable", reason: "diagnostics_channel / http 不可用" });
    return false;
  }
  const proto = http.ClientRequest.prototype as { end: (...a: unknown[]) => unknown; [END_PATCHED]?: true };
  if (!Object.prototype.hasOwnProperty.call(proto, END_PATCHED)) {
    const end0 = proto.end;
    proto.end = function patchedEnd(this: OutboundRequestLike & { [BODY]?: string }, ...args: unknown[]) {
      try {
        const c = args[0];
        if (c && typeof c !== "function" && /\.amazonaws\.com/.test(String(this.getHeader("host") ?? ""))) {
          const text = c instanceof Uint8Array ? new TextDecoder().decode(c.subarray(0, MAX_BODY)) : String(c);
          this[BODY] = text.slice(0, MAX_BODY);
        }
      } catch {
        /* 观测器永不抛 */
      }
      return end0.apply(this, args);
    };
    Object.defineProperty(proto, END_PATCHED, { value: true });
  }
  dc.subscribe("http.client.request.start", (m) => onRequestStart((m as { request: OutboundRequestLike }).request));
  installed = true;
  sink({ event: "place.observe.installed", channel: "http.client.request.start" });
  if (!summaryTimer) {
    summaryTimer = setInterval(() => sink(placeObservationSummary()), 60_000);
    (summaryTimer as { unref?: () => void }).unref?.();
  }
  return true;
}

/** 单测用。 */
export function __setObserverTestHooks(h: { loader?: IndexLoader; sink?: Sink } | null): void {
  if (h?.loader) loader = h.loader;
  if (h?.sink) sink = h.sink;
  cached = null;
  inflight = null;
  counts.clear();
  unattributed.clear();
  recentViolations.clear();
  indexUnavailable = 0;
}
