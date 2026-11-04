// 模块 26 — 数据驱动「工具型 skill」注册表服务。
// 一个注册技能 = 经审核的只读查询模板（SQL 模板，或 HTTP 外部 API 调用）+ 参数声明。模型经 Gateway 工具
// run_registered_skill(skill, params) 按名调用,Lambda 渲染参数(安全)→守卫→执行。
// 新技能 = 加一行(纯数据,零部署、后续会话自动可用)。pk=projectId("global"通用), sk=skillId。
import { PutCommand, QueryCommand, DeleteCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
// @kf-batch 50-project-delete-orphans —— owned-only 读法与口径那边同一个作者
import { queryAllPagesOwned } from "@/lib/genbi/context";

export const GLOBAL_SCOPE = "global";

export interface SkillParam {
  name: string;
  type: "number" | "string" | "identifier";
  description?: string;
  required?: boolean;
}

// HTTP/外部 API 技能配置。urlTemplate/bodyTemplate 含 {{param}} 占位。
// 安全：host 段不得含占位符（目标域名注册时即固定）、仅 https、执行时再做 SSRF 守卫。
export interface HttpSkillConfig {
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  urlTemplate: string;
  headers?: Record<string, string>;
  bodyTemplate?: string;
  resultPath?: string; // JSON 响应中定位数组/对象的点路径（可选）
}

export interface RegisteredSkill {
  projectId: string;
  skillId: string;
  name: string;            // 调用标识(英文/下划线), 如 top_customers_by_region
  description: string;     // 给模型看的用途说明
  kind: "sql" | "http";    // 技能类型：SQL 模板 或 HTTP 外部 API
  engine: "redshift" | "athena"; // 仅 kind=sql 有意义
  sqlTemplate?: string;    // kind=sql：只读 SELECT/WITH, 含 {{param}} 占位
  http?: HttpSkillConfig;  // kind=http：外部 API 配置
  params: SkillParam[];
  enabled: boolean;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

const NAME_RE = /^[a-z][a-z0-9_]{1,48}$/i;
export function isValidSkillName(n: unknown): n is string {
  return typeof n === "string" && NAME_RE.test(n);
}

// 校验 HTTP 技能配置：仅 https、host 段不含占位符（防参数劫持目标域名）、非内网域名。返回错误信息或 null。
export function validateHttpConfig(http: any): string | null {
  if (!http || typeof http !== "object") return "缺少 HTTP 配置";
  const method = String(http.method || "GET").toUpperCase();
  if (!["GET", "POST", "PUT", "DELETE", "PATCH"].includes(method)) return "method 非法";
  const tpl = String(http.urlTemplate || "").trim();
  if (!tpl) return "缺少 urlTemplate";
  if (!/^https:\/\//i.test(tpl)) return "urlTemplate 必须以 https:// 开头";
  // 取出 host 段（scheme://host[:port]/...）做静态校验：host 内不得出现 {{}} 占位符。
  const m = tpl.match(/^https:\/\/([^/?#]+)/i);
  if (!m) return "无法解析 URL 主机名";
  const hostPort = m[1];
  if (/\{\{/.test(hostPort)) return "目标主机名不允许使用参数占位符（仅路径/查询/请求体可用 {{param}}）";
  const host = hostPort.split(":")[0].toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) return "禁止指向内网/本地主机名";
  // 形如 IP 的主机名做内网段静态拦截（DNS 名在执行时再解析校验）。
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const p = host.split(".").map(Number);
    if (p[0] === 0 || p[0] === 10 || p[0] === 127 || (p[0] === 169 && p[1] === 254) ||
        (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) ||
        (p[0] === 100 && p[1] >= 64 && p[1] <= 127)) return "禁止指向内网 IP";
  }
  return null;
}

export async function listSkills(projectId: string): Promise<RegisteredSkill[]> {
  const q = async (pid: string) => {
    try {
      const { Items = [] } = await docClient.send(new QueryCommand({
        TableName: TABLES.GENBI_SKILLS,
        KeyConditionExpression: "projectId = :p",
        ExpressionAttributeValues: { ":p": pid },
      }));
      return Items as RegisteredSkill[];
    } catch { return []; }
  };
  const [proj, glob] = await Promise.all([q(projectId), projectId === GLOBAL_SCOPE ? Promise.resolve([]) : q(GLOBAL_SCOPE)]);
  return [...proj, ...glob].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

/**
 * @kf-batch 50-WP23-project-delete-own-only
 * 🔴 只数本项目自己的技能(不合并 `global`)—— 与 `listContextOwnedByProject` 同一条理由:
 * 删项目的守卫问的是「这个项目**拥有**什么」,而 `listSkills` 为了问数可用性合并了全局技能。
 * 合并版拿去当归属判据 ⇒ 空项目永远删不掉,且让用户去删**全局共享**的东西。
 */
export async function listSkillsOwnedByProject(projectId: string): Promise<RegisteredSkill[]> {
  // @kf-batch 50-project-delete-orphans —— 🔴 原来复用 `listSkills`:那里每个分区 `catch { return []; }` 且只读第一页
  //   ⇒ 删项目守卫读失败时数成 0 ⇒ 放行删除(fail-open)。唯一调用方是删除守卫 ⇒ 改走 owned-only 读法:读不到就抛、翻页到底。
  return (await queryAllPagesOwned(TABLES.GENBI_SKILLS, projectId)) as unknown as RegisteredSkill[];
}

export async function createSkill(input: {
  projectId: string; name: string; description: string; kind?: "sql" | "http";
  engine?: "redshift" | "athena"; sqlTemplate?: string; http?: HttpSkillConfig;
  params: SkillParam[]; createdBy?: string;
}): Promise<RegisteredSkill> {
  const now = new Date().toISOString();
  const kind: "sql" | "http" = input.kind === "http" ? "http" : "sql";
  const s: RegisteredSkill = {
    projectId: input.projectId,
    skillId: ulid(),
    name: input.name.trim(),
    description: (input.description || "").trim(),
    kind,
    engine: input.engine === "athena" ? "athena" : "redshift",
    params: Array.isArray(input.params) ? input.params : [],
    enabled: true,
    ...(kind === "sql" ? { sqlTemplate: (input.sqlTemplate || "").trim() } : {}),
    ...(kind === "http" && input.http ? {
      http: {
        method: (String(input.http.method || "GET").toUpperCase() as HttpSkillConfig["method"]),
        urlTemplate: String(input.http.urlTemplate || "").trim(),
        ...(input.http.headers && Object.keys(input.http.headers).length ? { headers: input.http.headers } : {}),
        ...(input.http.bodyTemplate ? { bodyTemplate: String(input.http.bodyTemplate) } : {}),
        ...(input.http.resultPath ? { resultPath: String(input.http.resultPath).trim() } : {}),
      },
    } : {}),
    ...(input.createdBy ? { createdBy: input.createdBy } : {}),
    createdAt: now,
    updatedAt: now,
  };
  await docClient.send(new PutCommand({ TableName: TABLES.GENBI_SKILLS, Item: s }));
  return s;
}

export async function deleteSkill(projectId: string, skillId: string): Promise<void> {
  await docClient.send(new DeleteCommand({ TableName: TABLES.GENBI_SKILLS, Key: { projectId, skillId } }));
}

// 一键预置 global 公共 BI 技能（**upsert**：不存在则建，已存在则按 name 原地更新
// description/sqlTemplate/params——保留 skillId 不变）。仅平台管理员。
// 定义单一事实源在 lib/genbi/global-skills-seed.ts；改了定义(如技能描述)重新 seed 即同步到线上,
// 账号轮换/环境重建后 seed 一次即恢复。**改为 upsert 的原因**:此前"已存在跳过"导致改了
// 描述/模板永远同步不到线上(技能是单一事实源,应可更新)。
export async function seedGlobalBiSkills(actor?: string): Promise<{ created: string[]; updated: string[] }> {
  const { GLOBAL_BI_SKILLS } = await import("./global-skills-seed");
  const existing = await listSkills(GLOBAL_SCOPE);
  const byName = new Map(existing.filter((s) => s.projectId === GLOBAL_SCOPE).map((s) => [s.name, s]));
  const created: string[] = [];
  const updated: string[] = [];
  const now = new Date().toISOString();
  for (const def of GLOBAL_BI_SKILLS) {
    const cur = byName.get(def.name);
    if (cur) {
      // 原地更新(保留 skillId/createdAt/enabled)：只覆盖会变的业务字段。
      const merged: RegisteredSkill = {
        ...cur,
        description: def.description.trim(),
        kind: "sql",
        engine: def.engine === "athena" ? "athena" : "redshift",
        sqlTemplate: (def.sqlTemplate || "").trim(),
        params: Array.isArray(def.params) ? def.params : [],
        updatedAt: now,
      };
      await docClient.send(new PutCommand({ TableName: TABLES.GENBI_SKILLS, Item: merged }));
      updated.push(def.name);
    } else {
      await createSkill({
        projectId: GLOBAL_SCOPE,
        name: def.name,
        description: def.description,
        kind: "sql",
        engine: def.engine,
        sqlTemplate: def.sqlTemplate,
        params: def.params,
        createdBy: actor,
      });
      created.push(def.name);
    }
  }
  return { created, updated };
}

export async function getSkill(projectId: string, skillId: string): Promise<RegisteredSkill | null> {
  const { Item } = await docClient.send(new GetCommand({ TableName: TABLES.GENBI_SKILLS, Key: { projectId, skillId } }));
  return (Item as RegisteredSkill) || null;
}
