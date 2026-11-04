// 业务知识 / 口径 / 规则库服务。
// 供智能问数(GenBI Agent)与代码生成查阅:业务术语的特定叫法、口径定义、注意事项/规则等。
// pk = projectId（"global" 为跨项目通用), sk = entryId(ULID)。按 项目 + global 合并返回。
import { PutCommand, QueryCommand, DeleteCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
// 类型与格式化逻辑已收敛进 @genbi/core（语义层单一来源,容器/Lambda 共用）。
// 此文件保留 DynamoDB 读写(适配器)+ re-export core 的类型/格式化,现有 import 路径不变。
import type { ContextKind, ContextEntry } from "./core/types";
import { filterAndRankContext } from "./core/context-format";
export type { ContextKind, ContextEntry } from "./core/types";
export {
  CONTEXT_KIND_LABEL, CONTEXT_SECTION_TITLE,
  contextToPromptText, contextToUsedItems,
} from "./core/context-format";
export type { UsedContextItem } from "./core/context-format";

export const GLOBAL_SCOPE = "global";

const KINDS: ContextKind[] = ["caliber", "term", "rule"];
export function isKind(v: unknown): v is ContextKind {
  return typeof v === "string" && (KINDS as string[]).includes(v);
}

export async function listContext(projectId: string): Promise<ContextEntry[]> {
  const q = async (pid: string) => {
    try {
      const { Items = [] } = await docClient.send(
        new QueryCommand({
          TableName: TABLES.GENBI_CONTEXT,
          KeyConditionExpression: "projectId = :p",
          ExpressionAttributeValues: { ":p": pid },
        })
      );
      return Items as ContextEntry[];
    } catch {
      return [];
    }
  };
  const [proj, glob] = await Promise.all([q(projectId), projectId === GLOBAL_SCOPE ? Promise.resolve([]) : q(GLOBAL_SCOPE)]);
  return [...proj, ...glob].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

/**
 * 🔴🔴 **只数本项目自己的条目**(不合并 `global`)。2026-09-15 真环境(段 `gbc` GC-15)抓到:
 * 删项目的守卫复用了上面那个 `listContext`,而它为了 grounding **刻意合并 `global` 作用域** ⇒
 * 一个**刚建出来、什么都没有**的项目会被报「问数业务口径 13 个,请先迁移或删除」——
 * 而那 13 条是**全局共享**的,谁删了都影响所有项目。用户看到的是「新建的空项目删不掉,
 * 而让我去删的东西不是我的」。
 *
 * 根因是「同一个集合被当成两件事用」:grounding 要的是「这个项目能看见什么」(项目 ∪ global),
 * 而删除守卫要的是「这个项目**拥有**什么」(只有项目自己)。两种语义必须有两个作者。
 */
export async function listContextOwnedByProject(projectId: string): Promise<ContextEntry[]> {
  // 🔴 原来这里 `try { … } catch { return []; }` 且只读第一页
  //   删项目守卫靠它数「问数业务口径」,读失败 / 第二页 ⇒ 数成 0 ⇒ **放行删除**(fail-open,正好是最坏方向)。
  //   这个函数的唯一调用方就是删除守卫 ⇒ 读不到必须**抛**(守卫变 count:null ⇒ 阻断),且翻页到底。
  //   (合并版 `listContext` 给问数 grounding 用,读失败降级成空是它自己的取舍,不动。)
  return (await queryAllPagesOwned(TABLES.GENBI_CONTEXT, projectId)) as unknown as ContextEntry[];
}

/** owned-only 读法共用:按 pk 翻页到底;翻不完就抛;只收 `projectId` 恰为本项目的行。 */
export async function queryAllPagesOwned(table: string, projectId: string, maxPages = 50): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  let startKey: Record<string, unknown> | undefined;
  for (let page = 0; page < maxPages; page++) {
    const r = await docClient.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: "projectId = :p",
        ExpressionAttributeValues: { ":p": projectId },
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      })
    );
    for (const it of (r.Items ?? []) as Array<Record<string, unknown>>) {
      if (String(it.projectId ?? "") === projectId) out.push(it);
    }
    startKey = r.LastEvaluatedKey as Record<string, unknown> | undefined;
    if (!startKey) return out;
  }
  throw new Error(`${table}:翻页超过 ${maxPages} 页仍未到尾 ⇒ 数不清,拒绝回一个可能偏小的数`);
}

// 供 Agent/codegen grounding 用：返回启用条目（关键词仅用于相关项排前，不丢弃任何条目）。
// 过滤/排序/截断逻辑收敛于 @genbi/core filterAndRankContext（与 Lambda lookup_business_context 共用同一算法）；
// 本函数只负责从 DynamoDB 读出条目（IO 适配器）。
export async function getContextForGrounding(projectId: string, keywords?: string): Promise<ContextEntry[]> {
  return filterAndRankContext(await listContext(projectId), keywords);
}

export async function createContext(input: {
  projectId: string;
  kind: ContextKind;
  title: string;
  body: string;
  scope?: string;
  tags?: string[];
  createdBy?: string;
}): Promise<ContextEntry> {
  const now = new Date().toISOString();
  const e: ContextEntry = {
    projectId: input.projectId,
    entryId: ulid(),
    kind: input.kind,
    title: input.title.trim(),
    body: (input.body || "").trim(),
    ...(input.scope ? { scope: input.scope } : {}),
    ...(input.tags && input.tags.length ? { tags: input.tags } : {}),
    enabled: true,
    ...(input.createdBy ? { createdBy: input.createdBy } : {}),
    createdAt: now,
    updatedAt: now,
  };
  await docClient.send(new PutCommand({ TableName: TABLES.GENBI_CONTEXT, Item: e }));
  return e;
}

export async function deleteContext(projectId: string, entryId: string): Promise<void> {
  await docClient.send(new DeleteCommand({ TableName: TABLES.GENBI_CONTEXT, Key: { projectId, entryId } }));
}

// 更新条目:保留主键(projectId/entryId)与 createdAt/createdBy/enabled,覆盖可编辑业务字段
// (kind/title/body/scope/tags)。条目不存在则抛错。scope/tags 传空即清除该字段。
export async function updateContext(
  projectId: string,
  entryId: string,
  patch: { kind?: ContextKind; title?: string; body?: string; scope?: string; tags?: string[] }
): Promise<ContextEntry> {
  const cur = await getContext(projectId, entryId);
  if (!cur) throw new Error("条目不存在");
  const now = new Date().toISOString();
  const next: ContextEntry = {
    ...cur,
    kind: patch.kind ?? cur.kind,
    title: (patch.title ?? cur.title).trim(),
    body: (patch.body ?? cur.body ?? "").trim(),
    updatedAt: now,
  };
  // scope/tags 显式覆盖:传了非空则设,传空字符串/空数组则清除(不保留旧值)。
  if (patch.scope !== undefined) { if (patch.scope.trim()) next.scope = patch.scope.trim(); else delete next.scope; }
  if (patch.tags !== undefined) { if (patch.tags.length) next.tags = patch.tags; else delete next.tags; }
  await docClient.send(new PutCommand({ TableName: TABLES.GENBI_CONTEXT, Item: next }));
  return next;
}

// 一键预置 global 通用业务口径/术语/规则。幂等 upsert:按 (kind+title) 去重——不存在则建,
// 已存在则原地更新 body/scope/tags(保留 entryId/createdAt/enabled)。与 seedGlobalBiSkills 对称,
// 供 POST /api/genbi/context/seed 调用。改了种子定义重跑即同步线上。best-effort 不抛断整批。
export async function seedGlobalContext(actor?: string): Promise<{ created: string[]; updated: string[] }> {
  const { GLOBAL_CONTEXT_SEEDS } = await import("./global-context-seed");
  const existing = await listContext(GLOBAL_SCOPE);
  const key = (kind: string, title: string) => `${kind}::${title.trim()}`;
  const byKey = new Map(existing.filter((e) => e.projectId === GLOBAL_SCOPE).map((e) => [key(e.kind, e.title), e]));
  const created: string[] = [];
  const updated: string[] = [];
  const now = new Date().toISOString();
  for (const def of GLOBAL_CONTEXT_SEEDS) {
    const cur = byKey.get(key(def.kind, def.title));
    if (cur) {
      const merged: ContextEntry = {
        ...cur,
        body: (def.body || "").trim(),
        ...(def.scope ? { scope: def.scope } : {}),
        ...(def.tags && def.tags.length ? { tags: def.tags } : {}),
        updatedAt: now,
      };
      await docClient.send(new PutCommand({ TableName: TABLES.GENBI_CONTEXT, Item: merged }));
      updated.push(def.title);
    } else {
      await createContext({
        projectId: GLOBAL_SCOPE,
        kind: def.kind,
        title: def.title,
        body: def.body,
        scope: def.scope,
        tags: def.tags,
        createdBy: actor,
      });
      created.push(def.title);
    }
  }
  return { created, updated };
}

export async function getContext(projectId: string, entryId: string): Promise<ContextEntry | null> {
  const { Item } = await docClient.send(new GetCommand({ TableName: TABLES.GENBI_CONTEXT, Key: { projectId, entryId } }));
  return (Item as ContextEntry) || null;
}

// 注:CONTEXT_KIND_LABEL / CONTEXT_SECTION_TITLE / contextToPromptText / contextToUsedItems
// 及 UsedContextItem 已收敛进 @genbi/core/context-format,本文件顶部 re-export（语义层单一来源）。
