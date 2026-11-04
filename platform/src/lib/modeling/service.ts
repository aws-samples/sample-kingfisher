// 数仓建模服务层。
//
// 分层(D1)/ 数据域·主题域(D2)/ 数据标准(D2)/ 码表(D2)/ 建模资产归属 的 CRUD,
// + 码表落地 Redshift。均为低频低量配置数据,用"单逻辑分区 + ULID 排序键"(同指标中台模式)。
//
// 复用:docClient/TABLES(lib/aws/dynamodb)、ulid、码表落地走 ./redshift(安全 SQL + 统一执行)。

import { PutCommand, QueryCommand, GetCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { safeIdent } from "./redshift";
// 码表物理落点的唯一作者(SPEC §3.9d.3;过渡期 = public.dim_code_<code>)
import { codeTableLandingFqn } from "./landing-fqn";
import { isValidTargetId } from "@/lib/exec-env/target-id";
import { perTargetTruth } from "./landing-shared";
import { pushStandardGlossary } from "@/lib/openmetadata/om-glossary";
import type { DataLayer, DataDomain, DataStandard, CodeTable, CodeValue, ModelAssetBinding } from "./types";

const LAYER_PK = "layer";
const DOMAIN_PK = "domain";
const STANDARD_PK = "standard";
const CODETABLE_PK = "codetable";

const now = () => new Date().toISOString();

/**
 * 治理约定的**适用区**(分层 / 数据域 / 数据标准共用这一个规范化器)。
 *
 * 🔴 只认合法 targetId,并且**空数组与未给一律回 undefined**(= 不写这个字段 = 全平台通用):
 * 写一个空数组进去会让读侧的「未声明 ⇒ 全平台通用」判断落到「声明了但一个区都不匹配」——
 * 那条定义就会在**所有**视角里消失(fail-silent 的经典形态)。
 * 🔴 也刻意不做「存在性校验」:治理约定可以先写、区后装(约定先于实现是常态);
 * 而执行体(作业 / 数据源)必须当场真解析落点 —— 两类东西的严格程度本来就不同。
 */
function normalizeApplicableTargets(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const list = Array.from(
    new Set(raw.filter((x): x is string => typeof x === "string" && isValidTargetId(x)))
  ).sort();
  return list.length > 0 ? list : undefined;
}
const str = (v: unknown) => (v == null ? "" : String(v)).trim();
// 业务编码白名单:与 Redshift 标识符同规则(码表 code 会用于落地表名 dim_code_<code>)。
const CODE_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ─── D1 数据分层 ───────────────────────────────────────────────────────────────
const STD_LAYERS: Array<Pick<DataLayer, "code" | "name" | "schema" | "seq" | "description">> = [
  { code: "ODS", name: "操作数据层", schema: "ods", seq: 1, description: "贴源层,源系统原始数据落地" },
  { code: "DWD", name: "明细数据层", schema: "dwd", seq: 2, description: "明细事实,清洗规范后的最细粒度数据" },
  { code: "DWS", name: "汇总数据层", schema: "dws", seq: 3, description: "轻度汇总,按主题聚合的宽表" },
  { code: "ADS", name: "应用数据层", schema: "ads", seq: 4, description: "应用层,面向报表/接口的结果数据" },
];

export async function listLayers(): Promise<DataLayer[]> {
  const { Items = [] } = await docClient.send(
    new QueryCommand({ TableName: TABLES.DATA_LAYERS, KeyConditionExpression: "pk = :p", ExpressionAttributeValues: { ":p": LAYER_PK } })
  );
  return (Items as DataLayer[]).sort((a, b) => (a.seq ?? 99) - (b.seq ?? 99));
}

export async function getLayer(layerId: string): Promise<DataLayer | null> {
  const { Item } = await docClient.send(new GetCommand({ TableName: TABLES.DATA_LAYERS, Key: { pk: LAYER_PK, layerId } }));
  return (Item as DataLayer) || null;
}

function validateLayer(input: any): Pick<DataLayer, "code" | "name" | "schema" | "seq" | "description"> & { targets?: string[] } {
  const code = str(input.code).toUpperCase();
  if (!code) throw new Error("缺少分层编码");
  const schema = str(input.schema);
  if (!schema) throw new Error("缺少 Redshift schema");
  safeIdent(schema); // schema 用于物理建表,白名单校验
  if (!str(input.name)) throw new Error("缺少分层名称");
  const seq = Number.isFinite(Number(input.seq)) ? Number(input.seq) : 99;
  return {
    code, name: str(input.name), schema, seq,
    description: input.description ? str(input.description) : undefined,
    // 适用区(未给 = 全平台通用)
    ...(normalizeApplicableTargets(input.targets) ? { targets: normalizeApplicableTargets(input.targets)! } : {}),
  };
}

export async function createLayer(input: any, actor?: string): Promise<DataLayer> {
  const v = validateLayer(input);
  const ts = now();
  const layer: DataLayer & { pk: string } = { pk: LAYER_PK, layerId: ulid(), ...v, ...(actor ? { createdBy: actor } : {}), createdAt: ts, updatedAt: ts };
  await docClient.send(new PutCommand({ TableName: TABLES.DATA_LAYERS, Item: layer }));
  return layer;
}

export async function updateLayer(layerId: string, patch: any): Promise<DataLayer | null> {
  const current = await getLayer(layerId);
  if (!current) return null;
  const v = validateLayer({ ...current, ...patch });
  const updated: DataLayer & { pk: string } = { pk: LAYER_PK, layerId, ...v, createdBy: current.createdBy, createdAt: current.createdAt, updatedAt: now() };
  await docClient.send(new PutCommand({ TableName: TABLES.DATA_LAYERS, Item: updated }));
  return updated;
}

export async function deleteLayer(layerId: string): Promise<void> {
  await docClient.send(new DeleteCommand({ TableName: TABLES.DATA_LAYERS, Key: { pk: LAYER_PK, layerId } }));
}

// 一键预置标准分层(幂等:已存在同 code 的不重复建)。
export async function seedLayers(actor?: string): Promise<DataLayer[]> {
  const existing = await listLayers();
  const have = new Set(existing.map((l) => l.code));
  const created: DataLayer[] = [];
  for (const def of STD_LAYERS) {
    if (have.has(def.code)) continue;
    created.push(await createLayer(def, actor));
  }
  return created;
}

// ─── D2 数据域 / 主题域 ─────────────────────────────────────────────────────────
export async function listDomains(): Promise<DataDomain[]> {
  const { Items = [] } = await docClient.send(
    new QueryCommand({ TableName: TABLES.DATA_DOMAINS, KeyConditionExpression: "pk = :p", ExpressionAttributeValues: { ":p": DOMAIN_PK } })
  );
  return Items as DataDomain[];
}

export async function getDomain(domainId: string): Promise<DataDomain | null> {
  const { Item } = await docClient.send(new GetCommand({ TableName: TABLES.DATA_DOMAINS, Key: { pk: DOMAIN_PK, domainId } }));
  return (Item as DataDomain) || null;
}

async function validateDomain(input: any): Promise<Pick<DataDomain, "name" | "code" | "parentId" | "level" | "owner" | "description"> & { targets?: string[] }> {
  if (!str(input.name)) throw new Error("缺少域名称");
  if (!str(input.code)) throw new Error("缺少域编码");
  const parentId = input.parentId ? str(input.parentId) : undefined;
  // 父必须是已存在的数据域(level 1);最多两级。
  if (parentId) {
    const parent = await getDomain(parentId);
    if (!parent) throw new Error("父数据域不存在");
    if (parent.level !== 1) throw new Error("仅支持两级:主题域必须挂在数据域下");
  }
  return {
    name: str(input.name), code: str(input.code), parentId, level: parentId ? 2 : 1,
    owner: input.owner ? str(input.owner) : undefined,
    description: input.description ? str(input.description) : undefined,
    // 适用区(未给 = 全平台通用)
    ...(normalizeApplicableTargets(input.targets) ? { targets: normalizeApplicableTargets(input.targets)! } : {}),
  };
}

export async function createDomain(input: any, actor?: string): Promise<DataDomain> {
  const v = await validateDomain(input);
  const ts = now();
  const domain: DataDomain & { pk: string } = { pk: DOMAIN_PK, domainId: ulid(), ...v, ...(actor ? { createdBy: actor } : {}), createdAt: ts, updatedAt: ts };
  await docClient.send(new PutCommand({ TableName: TABLES.DATA_DOMAINS, Item: domain }));
  return domain;
}

export async function updateDomain(domainId: string, patch: any): Promise<DataDomain | null> {
  const current = await getDomain(domainId);
  if (!current) return null;
  // level/parentId 重新校验(允许改父,但不允许把自己设为父)。
  if (patch.parentId && str(patch.parentId) === domainId) throw new Error("不能将自己设为父域");
  const v = await validateDomain({ ...current, ...patch });
  const updated: DataDomain & { pk: string } = { pk: DOMAIN_PK, domainId, ...v, createdBy: current.createdBy, createdAt: current.createdAt, updatedAt: now() };
  await docClient.send(new PutCommand({ TableName: TABLES.DATA_DOMAINS, Item: updated }));
  return updated;
}

// 删除数据域时,若其下还有主题域,拒绝(防孤儿)。
export async function deleteDomain(domainId: string): Promise<void> {
  const all = await listDomains();
  const hasChildren = all.some((d) => d.parentId === domainId);
  if (hasChildren) throw new Error("该数据域下还有主题域,请先删除子域");
  await docClient.send(new DeleteCommand({ TableName: TABLES.DATA_DOMAINS, Key: { pk: DOMAIN_PK, domainId } }));
}

// ─── D2 数据标准 ───────────────────────────────────────────────────────────────
export async function listStandards(): Promise<DataStandard[]> {
  const { Items = [] } = await docClient.send(
    new QueryCommand({ TableName: TABLES.DATA_STANDARDS, KeyConditionExpression: "pk = :p", ExpressionAttributeValues: { ":p": STANDARD_PK } })
  );
  return Items as DataStandard[];
}

export async function getStandard(standardId: string): Promise<DataStandard | null> {
  const { Item } = await docClient.send(new GetCommand({ TableName: TABLES.DATA_STANDARDS, Key: { pk: STANDARD_PK, standardId } }));
  return (Item as DataStandard) || null;
}

function validateStandard(input: any): Omit<DataStandard, "standardId" | "createdAt" | "updatedAt" | "createdBy"> & { targets?: string[] } {
  if (!str(input.name)) throw new Error("缺少标准名称");
  if (!str(input.code)) throw new Error("缺少标准编码");
  if (!str(input.dataType)) throw new Error("缺少标准数据类型");
  return {
    name: str(input.name),
    code: str(input.code),
    dataType: str(input.dataType),
    ...(input.length != null && input.length !== "" ? { length: Number(input.length) } : {}),
    ...(input.unit ? { unit: str(input.unit) } : {}),
    ...(input.refCodeTableId ? { refCodeTableId: str(input.refCodeTableId) } : {}),
    ...(input.namingRule ? { namingRule: str(input.namingRule) } : {}),
    ...(input.constraint ? { constraint: str(input.constraint) } : {}),
    ...(input.description ? { description: str(input.description) } : {}),
    // 适用区(未给 = 全平台通用)
    ...(normalizeApplicableTargets(input.targets) ? { targets: normalizeApplicableTargets(input.targets)! } : {}),
  };
}

export async function createStandard(input: any, actor?: string): Promise<DataStandard> {
  const v = validateStandard(input);
  const ts = now();
  const standard: DataStandard & { pk: string } = { pk: STANDARD_PK, standardId: ulid(), ...v, ...(actor ? { createdBy: actor } : {}), createdAt: ts, updatedAt: ts };
  await docClient.send(new PutCommand({ TableName: TABLES.DATA_STANDARDS, Item: standard }));
  pushStandardGlossary(standard).catch(() => {}); // best-effort 推 OM Glossary Term
  return standard;
}

export async function updateStandard(standardId: string, patch: any): Promise<DataStandard | null> {
  const current = await getStandard(standardId);
  if (!current) return null;
  const v = validateStandard({ ...current, ...patch });
  const updated: DataStandard & { pk: string } = { pk: STANDARD_PK, standardId, ...v, createdBy: current.createdBy, createdAt: current.createdAt, updatedAt: now() };
  await docClient.send(new PutCommand({ TableName: TABLES.DATA_STANDARDS, Item: updated }));
  pushStandardGlossary(updated).catch(() => {}); // best-effort 推 OM Glossary Term
  return updated;
}

export async function deleteStandard(standardId: string): Promise<void> {
  await docClient.send(new DeleteCommand({ TableName: TABLES.DATA_STANDARDS, Key: { pk: STANDARD_PK, standardId } }));
}

// ─── D2 码表 ───────────────────────────────────────────────────────────────────
export async function listCodeTables(): Promise<CodeTable[]> {
  const { Items = [] } = await docClient.send(
    new QueryCommand({ TableName: TABLES.CODE_TABLES, KeyConditionExpression: "pk = :p", ExpressionAttributeValues: { ":p": CODETABLE_PK } })
  );
  return Items as CodeTable[];
}

export async function getCodeTable(codeTableId: string): Promise<CodeTable | null> {
  const { Item } = await docClient.send(new GetCommand({ TableName: TABLES.CODE_TABLES, Key: { pk: CODETABLE_PK, codeTableId } }));
  return (Item as CodeTable) || null;
}

function normalizeValues(raw: any): CodeValue[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((v: any, i: number) => ({ value: str(v?.value), label: str(v?.label), seq: Number.isFinite(Number(v?.seq)) ? Number(v.seq) : i }))
    .filter((v: CodeValue) => v.value !== "");
}

function validateCodeTable(input: any): Pick<CodeTable, "name" | "code" | "description" | "values"> {
  if (!str(input.name)) throw new Error("缺少码表名称");
  const code = str(input.code);
  if (!code) throw new Error("缺少码表编码");
  // code 用于落地表名 dim_code_<code>,严格白名单。
  if (!CODE_RE.test(code)) throw new Error("码表编码须为字母/下划线起头的标识符(用于落地表名)");
  return { name: str(input.name), code, description: input.description ? str(input.description) : undefined, values: normalizeValues(input.values) };
}

export async function createCodeTable(input: any, actor?: string): Promise<CodeTable> {
  const v = validateCodeTable(input);
  const ts = now();
  const ct: CodeTable & { pk: string } = { pk: CODETABLE_PK, codeTableId: ulid(), ...v, landed: false, ...(actor ? { createdBy: actor } : {}), createdAt: ts, updatedAt: ts };
  await docClient.send(new PutCommand({ TableName: TABLES.CODE_TABLES, Item: ct }));
  return ct;
}

export async function updateCodeTable(codeTableId: string, patch: any): Promise<CodeTable | null> {
  const current = await getCodeTable(codeTableId);
  if (!current) return null;
  const v = validateCodeTable({ ...current, ...patch });
  // 编码或枚举值变更后,落地状态视为失效(需重新落地),但保留历史 landedTable 供参考。
  const codeOrValuesChanged = v.code !== current.code || JSON.stringify(v.values) !== JSON.stringify(current.values);
  const updated: CodeTable & { pk: string } = {
    pk: CODETABLE_PK, codeTableId, ...v,
    landed: codeOrValuesChanged ? false : current.landed,
    ...(current.landedTable ? { landedTable: current.landedTable } : {}),
    ...(current.landedAt ? { landedAt: current.landedAt } : {}),
    // 🔴🔴 **逐 target 真值必须原样带过**(W3-d2 施工时逮到的真 bug)。
    // 这一行有**两个作者**:定义编辑(name/code/values)与落地记录(targets/landedByTarget),
    // 而这里是**全量 Put** ⇒ 不显式带过就等于"编辑一次定义把另一个作者的东西抹掉"。
    // 后果不是"少个字段",是**看板误报 + 残留被藏**:改个中文名就让每一格从 ⚠版本不齐 退化成
    // ⚠未落地(而库里那些表还在),连 `targets` 一起丢掉之后连「残留」都看不见了。
    ...perTargetTruth(current as unknown as Record<string, unknown>),
    createdBy: current.createdBy, createdAt: current.createdAt, updatedAt: now(),
  };
  await docClient.send(new PutCommand({ TableName: TABLES.CODE_TABLES, Item: updated }));
  return updated;
}

// 🔴 删定义**受控**(50 SPEC v3.20 §3.8):此前这里只删 DDB 一行,而每个区落地的物理表原地不动、
//    平台从此不再知道它们 = 静默造孤儿 —— 正是「残留」态要暴露的东西被入口自己制造出来。
//    现在:仍有落地产物 ⇒ 抛 `DeleteDecisionRequired`(路由回 409),用户要么逐区〔解绑并清理〕,
//    要么带 `keepTables` + 确认串**显式**保留(审计逐表登记「刻意保留」)。
export async function deleteCodeTable(
  codeTableId: string,
  opts: { keepTables?: boolean; confirm?: string | null } = {}
): Promise<{ keptTables: import("./unbind-shared").LandedArtifact[] }> {
  const ct = await getCodeTable(codeTableId);
  if (!ct) return { keptTables: [] }; // 幂等:已经没了就算删成
  const { assertDeletable } = await import("./unbind-shared");
  const keptTables = assertDeletable(ct, { keepTables: opts.keepTables, confirm: opts.confirm, expectedConfirm: ct.code });
  await docClient.send(new DeleteCommand({ TableName: TABLES.CODE_TABLES, Key: { pk: CODETABLE_PK, codeTableId } }));
  return { keptTables };
}

/**
 * 解绑某个 target(可选连清理)。编排在 `./unbind.ts`(先 DROP、观测为空、再去记录);这里只负责
 * 码表专有的两件事:物理落点怎么算、home 投影字段怎么回写。
 */
export async function unbindCodeTable(
  codeTableId: string,
  // `actor` 必填:非主控区的 DROP 走 admin 受控通道,要具名操作者
  opts: { targetId: string; cleanup: boolean; confirm?: string | null; actor: import("@/lib/exec-env/admin-ddl-executor").AuthenticatedActor | null }
): Promise<{ codeTable: CodeTable; dropped: boolean; table: string }> {
  const ct = await getCodeTable(codeTableId);
  if (!ct) throw new Error("码表不存在");
  const landingAt = codeTableLandingFqn(ct);
  const { bindingTargets } = await import("@/lib/exec-env/data-plane-target");
  const { HOME_TARGET_ID } = await import("@/lib/exec-env/target-id");
  const { performUnbind } = await import("./unbind");
  const { landedStateOf } = await import("./landing-shared");
  const defHash = await codeTableDefHash(ct);
  const out = await performUnbind<CodeTable>({
    boundTargets: bindingTargets(ct as { targets?: unknown }),
    landedByTarget: ct.landedByTarget,
    targetId: opts.targetId,
    cleanup: opts.cleanup,
    confirm: opts.confirm,
    schema: landingAt.schema,
    table: landingAt.table,
    kind: "code-table",
    objectId: ct.codeTableId,
    actor: opts.actor,
    save: async ({ targets, landedByTarget }) => {
      // 🔴 home 投影三字段**重算**,不许从旧行 spread 过来(清理掉 home 之后 `landedTable` 还留着 = 假绿)
      const { landed: _l, landedTable: _lt, landedAt: _la, ...rest } = ct as CodeTable & { pk?: string };
      void _l; void _lt; void _la;
      const homeRec = landedByTarget[HOME_TARGET_ID];
      const updated: CodeTable & { pk: string } = {
        ...(rest as CodeTable),
        pk: CODETABLE_PK,
        targets,
        landedByTarget,
        landed: homeRec ? landedStateOf(homeRec, defHash) === "ok" : false,
        ...(homeRec?.table ? { landedTable: homeRec.table } : {}),
        ...(homeRec?.at ? { landedAt: homeRec.at } : {}),
        updatedAt: now(),
      };
      await docClient.send(new PutCommand({ TableName: TABLES.CODE_TABLES, Item: updated }));
      return updated;
    },
  });
  return { codeTable: out.row, dropped: out.dropped, table: out.table };
}

/** 解绑弹窗的影响预览(行数是 `svv_table_info` 估值;credential-gap / 无记录 ⇒ 不连库)。 */
export async function previewUnbindCodeTable(
  codeTableId: string,
  targetId: string
): Promise<{ table: string; status: string | null; lastLandedAt: string | null; rowCountEstimate: number | null; bound: boolean }> {
  const ct = await getCodeTable(codeTableId);
  if (!ct) throw new Error("码表不存在");
  const { bindingTargets } = await import("@/lib/exec-env/data-plane-target");
  const rec = ct.landedByTarget?.[targetId];
  const landingAt = codeTableLandingFqn(ct);
  const table = landingAt.fqn;
  let rowCountEstimate: number | null = null;
  if (rec && rec.status !== "credential-gap") {
    const { estimateRows } = await import("./landing");
    rowCountEstimate = await estimateRows(targetId, { schema: landingAt.schema, table: landingAt.table }).catch(() => null);
  }
  return {
    table,
    status: rec?.status ?? null,
    lastLandedAt: rec?.at ?? null,
    rowCountEstimate,
    bound: bindingTargets(ct as { targets?: unknown }).includes(targetId),
  };
}

// 码表落地 Redshift:建物理码表 dim_code_<code> 并幂等灌入枚举值。
// 🔴 **逐 target 物化 + 观测态回写**(轴A,50 SPEC §1.3 / INTERACTION §4ter):
//    落地不再是一个 bool,而是每个 target 一条 `LandedRecord`(含**观测到的列签名**)。
//    `landed`/`landedTable`/`landedAt` 降为 **home 那一格的投影**,只为读兼容(列表页在用)。
export async function landCodeTableById(
  codeTableId: string,
  // `residencyActor`:落地前逐 target 写区域审计的行为主体(路由传用户;缺省平台服务主体)
  // `actor`(**必填**,无默认):非主控区落地走 admin 受控通道 + 窄权写者,
  //   要具名操作者;路由传 `actorFromIdentity(identity)`,`null` = 显式声明没有(非主控区那一格判 failed 说清原因)。
  opts: {
    targets?: string[];
    force?: boolean;
    probeOnly?: boolean;
    residencyActor?: import("@/lib/exec-env/residency-audit").ResidencyActor;
    actor: import("@/lib/exec-env/admin-ddl-executor").AuthenticatedActor | null;
  }
): Promise<CodeTable> {
  const ct = await getCodeTable(codeTableId);
  if (!ct) throw new Error("码表不存在");
  if (!ct.values?.length) throw new Error("码表无枚举值,无法落地");
  const { landToTargets, defHashOf, CODE_TABLE_COLUMNS, landedStateOf } = await import("./landing");
  const { buildLandStatements, buildCodeTableWriteStatements } = await import("./redshift");
  const { bindingTargets } = await import("@/lib/exec-env/data-plane-target");
  const { HOME_TARGET_ID } = await import("@/lib/exec-env/target-id");

  const { schema, table } = codeTableLandingFqn(ct);
  // 🔴 定义哈希只覆盖**决定物理产物**的东西(code + 枚举值 + schema)——
  //    把 name/description 也算进去会让改个中文名就整片判「版本不齐」(误报)。
  const defHash = defHashOf({ code: ct.code, schema, values: (ct.values || []).map((v) => [v.value, v.label, v.seq ?? null]) });
  // 🔴🔴 **本次落地的目标** 与 **定义的绑定** 是两件事(W3-d2 施工时逮到的第三个真 bug):
  // 原来把 `targets` 直接写回绑定 ⇒ 点一下看板格子上的〔落地到此 region〕(只带那一个区)
  // 就把**其它区静默解绑**了 —— 那是「下发动作有副作用改绑定」,任务侧早已明令禁止
  // (W3-b:子集重发点名未绑区直接拒、绝不动绑定)。
  // ⇒ 落地只作用于 `landing`;绑定 **只增不减**(落地即绑定;解绑必须是显式动作,本期没有,已登记)。
  const bound = bindingTargets(ct as { targets?: unknown });
  const landing = opts.targets?.length ? opts.targets : bound;
  const targets = Array.from(new Set([...bound, ...landing]));

  const statements = buildLandStatements(ct.code, ct.values, schema);
  // 🔴 落地**之前**逐 target 写区域审计(entry=modeling-land;SPEC v3.23 §3.2):home / 同法域 ⇒ null;
  //    跨法域 ⇒ 先同意前置(409)再区域全量 + 中央摘要,写不成 ⇒ 抛、一条语句都不执行。probeOnly 只观测不动库,不审。
  //    与选 tgt_usw2_a 同一条路(没有任何「被驻留门控」的判定)。
  if (!opts.probeOnly) {
    const { residencyAudit, auditActorOrService } = await import("@/lib/exec-env/residency-audit");
    for (const tid of landing) {
      await residencyAudit({ ...auditActorOrService(opts.residencyActor), targetId: tid, entry: "modeling-land", sqlText: statements.join(";\n") });
    }
  }

  const recs = await landToTargets({
    targets: landing,
    kind: "code-table",
    objectId: ct.codeTableId,
    actor: opts.actor,
    schema,
    table,
    expectedColumns: CODE_TABLE_COLUMNS,
    statements,
    // 非主控区只有数据层由窄权写者执行(结构层走 admin 模板,与 `statements` 第一条同一个作者)
    writeStatements: buildCodeTableWriteStatements(ct.code, ct.values, schema),
    defHash,
    // 🔴 把**已有记录**传进去:只观测(probeOnly)时指纹要沿用上一条 ——
    //    否则点一下〔重新检测〕就能把「值改了但列结构没变」的表判成已落(假绿)。
    previous: ct.landedByTarget || null,
    ...(opts.force ? { force: true } : {}),
    ...(opts.probeOnly ? { probeOnly: true } : {}),
  });

  const ts = now();
  const merged = { ...(ct.landedByTarget || {}), ...recs };
  const homeRec = merged[HOME_TARGET_ID];
  const updated: CodeTable & { pk: string } = {
    ...(ct as CodeTable),
    pk: CODETABLE_PK,
    targets,
    landedByTarget: merged,
    // home 投影(读兼容):🔴 只有 home 那一格**真是 ok** 才写 true —— drift/failed 绝不显示为已落地
    landed: homeRec ? landedStateOf(homeRec, defHash) === "ok" : ct.landed,
    ...(homeRec?.table ? { landedTable: homeRec.table } : {}),
    ...(homeRec?.at ? { landedAt: homeRec.at } : {}),
    updatedAt: ts,
  };
  await docClient.send(new PutCommand({ TableName: TABLES.CODE_TABLES, Item: updated }));
  return updated;
}

/** 当前定义哈希(读侧判「版本不齐」用;与落地时算法**同一处**)。 */
export async function codeTableDefHash(ct: Pick<CodeTable, "code" | "values">): Promise<string> {
  const { defHashOf } = await import("./landing");
  return defHashOf({ code: ct.code, schema: codeTableLandingFqn(ct).schema, values: (ct.values || []).map((v) => [v.value, v.label, v.seq ?? null]) });
}

/**
 * 列表读侧:给每行补 `defHash` 与物理落点。
 *
 * 🔴 **算出来、不落库**:落库就有了第二个真值源,而漂移的表现恰好是"面板说版本不齐、其实是它自己记错了"
 * (与矩阵的 `currentVersion` 取版本快照表、不在资源行另存一份,同一条纪律)。
 */
export async function listCodeTablesEnriched(): Promise<Array<CodeTable & { defHash: string; physicalTable: string }>> {
  const rows = await listCodeTables();
  return Promise.all(
    rows.map(async (ct) => ({
      ...ct,
      defHash: await codeTableDefHash(ct),
      // 🔴 一致性矩阵的 `physical` 取的就是这个字段 ⇒ 第四个消费者同样经 SSOT(§3.9d.3)
      physicalTable: codeTableLandingFqn(ct).fqn,
    }))
  );
}

// ─── 建模资产归属(表/指标 → 分层/域)─────────────────────────────────────────
export async function getAssetBinding(fqn: string): Promise<ModelAssetBinding | null> {
  const { Item } = await docClient.send(new GetCommand({ TableName: TABLES.MODEL_ASSETS, Key: { fqn, sk: "binding" } }));
  return (Item as ModelAssetBinding) || null;
}

export async function setAssetBinding(input: any, actor?: string): Promise<ModelAssetBinding> {
  const fqn = str(input.fqn);
  if (!fqn) throw new Error("缺少资产 FQN");
  const kind = input.kind === "metric" ? "metric" : "table";
  const binding = {
    fqn, sk: "binding", kind,
    ...(input.layerId ? { layerId: str(input.layerId) } : {}),
    ...(input.domainId ? { domainId: str(input.domainId) } : {}),
    ...(actor ? { boundBy: actor } : {}),
    boundAt: now(),
  };
  await docClient.send(new PutCommand({ TableName: TABLES.MODEL_ASSETS, Item: binding }));
  const { sk, ...rest } = binding as any;
  return rest as ModelAssetBinding;
}
