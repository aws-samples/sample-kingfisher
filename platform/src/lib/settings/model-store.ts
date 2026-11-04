// `bgp-settings` 表的模型配置存取层(51 SPEC §1 表 / §2 接口 / §6.1 五模式)。
//
// 本文件是 `ai-model#*` 前缀的**唯一拼接处**(P0-2:store 独占 sk 拼接,调用方只传逻辑 scope)。
//
// 键形态(51 DESIGN D8 / SPEC §6.2①,一期值 vs 形态分开看):
//   ai-model#global                          一期全局默认(值恒此;形态可扩为 ai-model#<targetId>#global)
//   ai-model#__version                       缓存失活计数器(冷表 0;ADD 自建)
//   ai-model#__transport                     GPT 传输门控项
//   ai-model#probe#<targetId>#<modelId>      per-target × per-model 探测缓存(24h 应用层过期)
//   ratelimit#probe#<adminSub>#m#<bucket>    probe 限频计数(见 probe-ratelimit.ts,带 ttl)
//
// 🔴 三条硬纪律(单测钉住,见 __tests__/model-store.test.ts 与 lib/ai/__tests__/model-config-guard.test.ts):
//   ① `ModelSettingItem.probeOk` 是字面量 `true`,`putGlobalModel()` 只收 `ProbeOk` —— 没探过 / 探失败的
//      值**类型上写不进去**;运行期读出来 probeOk !== true 也视为无效(fail-closed)。
//   ② 表开了 `ttl` 属性的 TTL —— 写任何 `ai-model#*` 项**断言不带 `ttl`**,否则全局配置会被 DynamoDB 静默删掉。
//   ③ PUT 的三项(配置条件写 / `__version` ADD / 审计 Put)在**同一个** `TransactWriteCommand`,
//      审计 item 由 `lib/audit.ts` 的 `buildAuditItem` 构造(不写第二套形状)。
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { buildAuditItem, type AuditActorRef } from "@/lib/audit";
import type { ProbeError, ProbeOk, ProbeResult } from "@/lib/ai/capabilities";

export const SETTINGS_PK = "system";
export const MODEL_SK_PREFIX = "ai-model#";
const SK_VERSION = `${MODEL_SK_PREFIX}__version`;
const SK_TRANSPORT = `${MODEL_SK_PREFIX}__transport`;
const SK_PROBE_PREFIX = `${MODEL_SK_PREFIX}probe#`;

/** 探测缓存的应用层有效期(51 SPEC §1:过期即「未知」)。 */
export const PROBE_TTL_MS = 24 * 60 * 60 * 1000;

/** 配置项(51 SPEC §2 `SettingItem` 的落表形态;`probeOk` 字面量 true = 类型级 probe-before-save)。 */
export interface ModelSettingItem {
  pk: typeof SETTINGS_PK;
  sk: string;
  /** 逻辑 scope(一期恒 "global";二期 "<targetId>#global" / "<capability>") */
  scope: string;
  modelId: string;
  probedAt: number;
  probeOk: true;
  toolUseOk?: boolean;
  updatedBy: string;
  updatedAt: number;
  /** per-item 乐观锁(照 `finops/store.ts` 的 bgp-budgets 惯例) */
  version: number;
}

/** 探测缓存项。 */
export interface ProbeCacheItem {
  pk: typeof SETTINGS_PK;
  sk: string;
  targetId: string;
  modelId: string;
  probeOk: boolean;
  probedAt: number;
  probeError?: ProbeError;
  errorDetail?: string;
  toolUseOk?: boolean;
  quotaHint?: "ok" | "low" | "unknown";
}

/** GPT 传输门控项(51 SPEC §2 `PUT /transport`;§3.4 补强④:>24h 视为失效)。 */
export interface TransportItem {
  pk: typeof SETTINGS_PK;
  sk: string;
  gptReady: boolean;
  branch: "A" | "B" | null;
  decidedAt: number;
  decidedBy: string;
  /** 置位时依据的探测(gptReady=true 时必有) */
  probeModelId?: string;
  probedAt?: number;
}

export class ModelVersionConflictError extends Error {
  readonly name = "ModelVersionConflictError";
  constructor(public readonly scope: string, public readonly expectVersion: number) {
    super(`模型配置 ${scope} 的 version 已变化(期望 ${expectVersion}),请刷新后重试`);
  }
}

// ── sk 拼接(唯一处)────────────────────────────────────────────────────────────

export function skForScope(scope: string): string {
  if (!scope || scope.includes("#probe#") || scope.startsWith("__")) {
    throw new Error(`非法 scope: ${JSON.stringify(scope)}`);
  }
  return `${MODEL_SK_PREFIX}${scope}`;
}

export function skForProbe(targetId: string, modelId: string): string {
  if (!targetId || !modelId) throw new Error("probe 键必须带 targetId 与 modelId");
  return `${SK_PROBE_PREFIX}${targetId}#${modelId}`;
}

/** `overrides[]` 白名单:只留 scope 项(排除 __version / __transport / probe# / 其它前缀)。 */
export function isScopeSk(sk: string): boolean {
  if (!sk.startsWith(MODEL_SK_PREFIX)) return false;
  if (sk === SK_VERSION || sk === SK_TRANSPORT) return false;
  if (sk.startsWith(SK_PROBE_PREFIX)) return false;
  if (sk.startsWith(`${MODEL_SK_PREFIX}__`)) return false;
  return true;
}

/** 🔴 纪律②:任何 `ai-model#*` 写入都过这里;带 `ttl` 直接抛(单测钉住)。 */
export function assertNoTtl(item: Record<string, unknown>): void {
  if (Object.prototype.hasOwnProperty.call(item, "ttl")) {
    throw new Error(`ai-model#* 配置项禁止带 ttl 属性(表级 TTL 会把配置静默删掉): ${String(item.sk)}`);
  }
}

function isTransactionCanceled(e: unknown): e is { name: string; CancellationReasons?: { Code?: string }[] } {
  return !!e && typeof e === "object" && (e as { name?: string }).name === "TransactionCanceledException";
}

function isConditionalFail(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { name?: string }).name === "ConditionalCheckFailedException";
}

// ── 读 ─────────────────────────────────────────────────────────────────────────

/** 读一个 scope 的配置项;不存在或**形状不合法(probeOk !== true / modelId 非串)**一律返回 null(fail-closed)。 */
export async function getModelSetting(scope: string): Promise<ModelSettingItem | null> {
  const { Item } = await docClient.send(
    new GetCommand({ TableName: TABLES.SETTINGS, Key: { pk: SETTINGS_PK, sk: skForScope(scope) } })
  );
  if (!Item) return null;
  const it = Item as Partial<ModelSettingItem>;
  if (typeof it.modelId !== "string" || !it.modelId || it.probeOk !== true) {
    console.warn(`[model-store] 配置项 ${skForScope(scope)} 形状不合法(probeOk=${String(it.probeOk)}),按不存在处理`);
    return null;
  }
  return it as ModelSettingItem;
}

/** 列举全部 scope 覆盖项(51 SPEC §2 GET `overrides[]` 白名单过滤)。 */
export async function listScopeOverrides(): Promise<ModelSettingItem[]> {
  const out: ModelSettingItem[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await docClient.send(
      new QueryCommand({
        TableName: TABLES.SETTINGS,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": SETTINGS_PK, ":prefix": MODEL_SK_PREFIX },
        ExclusiveStartKey: startKey,
      })
    );
    for (const raw of res.Items || []) {
      const it = raw as Partial<ModelSettingItem>;
      if (typeof it.sk !== "string" || !isScopeSk(it.sk)) continue;
      if (typeof it.modelId !== "string" || it.probeOk !== true) continue;
      out.push(it as ModelSettingItem);
    }
    startKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
  return out;
}

/** `__version` 冷表默认 0(P0-2)。 */
export async function getVersion(): Promise<number> {
  const { Item } = await docClient.send(
    new GetCommand({ TableName: TABLES.SETTINGS, Key: { pk: SETTINGS_PK, sk: SK_VERSION } })
  );
  const v = (Item as { version?: unknown } | undefined)?.version;
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** `ADD version :one`(不存在即创建为 1),返回新值。 */
export async function bumpVersion(): Promise<number> {
  const res = await docClient.send(
    new UpdateCommand({
      TableName: TABLES.SETTINGS,
      Key: { pk: SETTINGS_PK, sk: SK_VERSION },
      UpdateExpression: "ADD version :one",
      ExpressionAttributeValues: { ":one": 1 },
      ReturnValues: "UPDATED_NEW",
    })
  );
  return Number((res.Attributes as { version?: number } | undefined)?.version ?? 1);
}

// ── 写(事务)────────────────────────────────────────────────────────────────────

/** `__version` ADD 的事务片段(PUT / DELETE / transport 三条写路径共用)。 */
function versionBumpTransactItem() {
  return {
    Update: {
      TableName: TABLES.SETTINGS,
      Key: { pk: SETTINGS_PK, sk: SK_VERSION },
      UpdateExpression: "ADD version :one",
      ExpressionAttributeValues: { ":one": 1 },
    },
  };
}

export interface PutGlobalModelInput {
  /** 逻辑 scope,一期只有 "global" */
  scope: string;
  modelId: string;
  /** 🔴 只收 ok:true 的探测结果(编译期挡掉未探测 / 探测失败的保存) */
  probe: ProbeOk;
  /** 乐观锁:给了就条件写 version=:expect;不给 = 无条件覆盖(脚本 / 首次写) */
  expectVersion?: number;
  actor: AuditActorRef;
  ctx?: { method?: string; path?: string };
  /** 审计 detail 里的旧值(调用方 GET 后传入;可无) */
  previous?: { modelId: string; version: number } | null;
  now?: number;
}

/**
 * 保存全局模型(51 SPEC §2 PUT 服务端流程的**写库段**;校验 / 探测由路由层在此之前完成)。
 *
 * 一个 `TransactWriteCommand` 三项:
 *   ① 配置项 Update(SET modelId/probedAt/probeOk/…, version = if_not_exists(version,0)+1;有 expectVersion 则条件 version=:expect)
 *   ② `__version` ADD 1
 *   ③ `bgp-audit` Put(`buildAuditItem` 同形状)
 * 任一失败 ⇒ 全部不落(审计写不进去配置就不生效)。条件失败 ⇒ `ModelVersionConflictError`(路由转 409)。
 *
 * @returns 新 version(有 expectVersion 时可直接算;否则回读一次)
 */
export async function putGlobalModel(input: PutGlobalModelInput): Promise<{ version: number; auditId: string }> {
  const { scope, modelId, probe, expectVersion, actor, ctx, previous } = input;
  if (probe.ok !== true) {
    // 运行期再校验一次(类型可被 as 绕过):fail-closed。
    throw new Error("putGlobalModel 只接受探测通过(ok:true)的结果");
  }
  const now = input.now ?? Date.now();
  const sk = skForScope(scope);

  // 配置项要写入的属性(不含 ttl —— 纪律②)。
  const attrs: Record<string, unknown> = {
    scope,
    modelId,
    probedAt: probe.probedAt ?? now,
    probeOk: true,
    updatedBy: actor.actor,
    updatedAt: now,
    ...(probe.toolUseOk !== undefined ? { toolUseOk: probe.toolUseOk } : {}),
  };
  assertNoTtl({ sk, ...attrs });

  const names: Record<string, string> = {};
  const values: Record<string, unknown> = { ":one": 1, ":zero": 0 };
  const sets: string[] = [];
  Object.entries(attrs).forEach(([k, v], i) => {
    names[`#a${i}`] = k;
    values[`:a${i}`] = v;
    sets.push(`#a${i} = :a${i}`);
  });
  names["#v"] = "version";
  sets.push("#v = if_not_exists(#v, :zero) + :one");

  if (expectVersion !== undefined) values[":expect"] = expectVersion;
  const configUpdate = {
    TableName: TABLES.SETTINGS,
    Key: { pk: SETTINGS_PK, sk },
    UpdateExpression: `SET ${sets.join(", ")}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
    ...(expectVersion !== undefined ? { ConditionExpression: "#v = :expect" } : {}),
  };

  const { item: auditItem, auditId } = buildAuditItem(
    actor,
    "model-config.update",
    {
      resourceType: "model-config",
      resourceId: scope,
      detail: {
        old: previous ? { modelId: previous.modelId, version: previous.version } : null,
        new: { modelId, toolUseOk: probe.toolUseOk ?? null },
        expectVersion: expectVersion ?? null,
      },
    },
    ctx
  );

  try {
    await docClient.send(
      new TransactWriteCommand({
        TransactItems: [
          { Update: configUpdate },
          versionBumpTransactItem(),
          { Put: { TableName: TABLES.AUDIT, Item: auditItem } },
        ],
      })
    );
  } catch (e) {
    if (isTransactionCanceled(e) && e.CancellationReasons?.[0]?.Code === "ConditionalCheckFailed") {
      throw new ModelVersionConflictError(scope, expectVersion ?? -1);
    }
    throw e;
  }

  if (expectVersion !== undefined) return { version: expectVersion + 1, auditId };
  const after = await getModelSetting(scope);
  return { version: after?.version ?? 1, auditId };
}

/**
 * 删除一个 scope 覆盖(51 SPEC §2 DELETE;「恢复出厂默认」= 删全部覆盖)。
 * 同样三项一事务:Delete(条件 attribute_exists)+ `__version` ADD + 审计 Put。
 * @returns 是否真的删到了(项不存在 ⇒ false,不写审计 / 不 bump)
 */
export async function deleteModelSetting(
  scope: string,
  actor: AuditActorRef,
  ctx?: { method?: string; path?: string },
  previous?: { modelId: string; version: number } | null
): Promise<boolean> {
  const sk = skForScope(scope);
  const { item: auditItem } = buildAuditItem(
    actor,
    "model-config.delete",
    { resourceType: "model-config", resourceId: scope, detail: { old: previous ?? null } },
    ctx
  );
  try {
    await docClient.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Delete: {
              TableName: TABLES.SETTINGS,
              Key: { pk: SETTINGS_PK, sk },
              ConditionExpression: "attribute_exists(sk)",
            },
          },
          versionBumpTransactItem(),
          { Put: { TableName: TABLES.AUDIT, Item: auditItem } },
        ],
      })
    );
    return true;
  } catch (e) {
    if (isTransactionCanceled(e) && e.CancellationReasons?.[0]?.Code === "ConditionalCheckFailed") return false;
    if (isConditionalFail(e)) return false;
    throw e;
  }
}

// ── 探测缓存 ─────────────────────────────────────────────────────────────────────

/** 写探测缓存(51 SPEC §3.4a④:store 坏了**静默跳过**,不影响主流程)。返回是否写成。 */
export async function putProbe(targetId: string, modelId: string, r: ProbeResult, now = Date.now()): Promise<boolean> {
  const item: ProbeCacheItem = {
    pk: SETTINGS_PK,
    sk: skForProbe(targetId, modelId),
    targetId,
    modelId,
    probeOk: r.ok,
    probedAt: r.probedAt ?? now,
    ...(r.error ? { probeError: r.error } : {}),
    ...(r.errorDetail ? { errorDetail: r.errorDetail.slice(0, 500) } : {}),
    ...(r.toolUseOk !== undefined ? { toolUseOk: r.toolUseOk } : {}),
    ...(r.quotaHint ? { quotaHint: r.quotaHint } : {}),
  };
  assertNoTtl(item as unknown as Record<string, unknown>);
  try {
    await docClient.send(new PutCommand({ TableName: TABLES.SETTINGS, Item: item }));
    return true;
  } catch (e) {
    console.warn(`[model-store] 写探测缓存失败(跳过): ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

export async function getProbe(targetId: string, modelId: string): Promise<ProbeCacheItem | null> {
  const { Item } = await docClient.send(
    new GetCommand({ TableName: TABLES.SETTINGS, Key: { pk: SETTINGS_PK, sk: skForProbe(targetId, modelId) } })
  );
  return (Item as ProbeCacheItem | undefined) ?? null;
}

/** 某 target 下全部探测缓存(catalog 用;**只读缓存,绝不触发探测**)。 */
export async function listProbes(targetId: string): Promise<ProbeCacheItem[]> {
  const out: ProbeCacheItem[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await docClient.send(
      new QueryCommand({
        TableName: TABLES.SETTINGS,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": SETTINGS_PK, ":prefix": `${SK_PROBE_PREFIX}${targetId}#` },
        ExclusiveStartKey: startKey,
      })
    );
    for (const raw of res.Items || []) out.push(raw as ProbeCacheItem);
    startKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
  return out;
}

/** 24h 内的探测才算「已知」。 */
export function isProbeFresh(p: { probedAt?: number } | null | undefined, now = Date.now()): boolean {
  return !!p && typeof p.probedAt === "number" && now - p.probedAt < PROBE_TTL_MS;
}

/** 把缓存项还原成 `ProbeResult`(catalog 的 `lastProbe`)。 */
export function probeResultOf(p: ProbeCacheItem): ProbeResult {
  return {
    ok: p.probeOk,
    ...(p.probeError ? { error: p.probeError } : {}),
    ...(p.errorDetail ? { errorDetail: p.errorDetail } : {}),
    ...(p.toolUseOk !== undefined ? { toolUseOk: p.toolUseOk } : {}),
    ...(p.quotaHint ? { quotaHint: p.quotaHint } : {}),
    probedAt: p.probedAt,
  };
}

// ── GPT 传输门控项──────────────────────────────────────────────────────

export async function getTransport(): Promise<TransportItem | null> {
  const { Item } = await docClient.send(
    new GetCommand({ TableName: TABLES.SETTINGS, Key: { pk: SETTINGS_PK, sk: SK_TRANSPORT } })
  );
  return (Item as TransportItem | undefined) ?? null;
}

/**
 * 写传输门控项(三项一事务:Put + `__version` ADD + 审计)。
 * 🔴 `gptReady=true` 的**证据校验**(toolUseOk===true 且 24h 内)在路由层做(`TransportNotVerified`),
 * 这里只负责落库与 bump(51 SPEC §3.4 补强③:不 bump 则 5s 缓存永不刷新)。
 */
export async function putTransport(
  input: Omit<TransportItem, "pk" | "sk">,
  actor: AuditActorRef,
  ctx?: { method?: string; path?: string }
): Promise<void> {
  const item: TransportItem = { pk: SETTINGS_PK, sk: SK_TRANSPORT, ...input };
  assertNoTtl(item as unknown as Record<string, unknown>);
  const { item: auditItem } = buildAuditItem(
    actor,
    "model-config.transport",
    { resourceType: "model-config", resourceId: "__transport", detail: { gptReady: input.gptReady, branch: input.branch, probeModelId: input.probeModelId ?? null } },
    ctx
  );
  await docClient.send(
    new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: TABLES.SETTINGS, Item: item } },
        versionBumpTransactItem(),
        { Put: { TableName: TABLES.AUDIT, Item: auditItem } },
      ],
    })
  );
}

// 仅供单测/脚本:按 sk 直接删(不 bump、不审计)。生产路径不用。
export async function _deleteRawForTests(sk: string): Promise<void> {
  await docClient.send(new DeleteCommand({ TableName: TABLES.SETTINGS, Key: { pk: SETTINGS_PK, sk } }));
}
