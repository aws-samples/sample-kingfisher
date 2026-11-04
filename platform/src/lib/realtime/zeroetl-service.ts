// 模块 31 (Zero-ETL) — RDS MySQL → Redshift 真·CDC 增量同步编排服务层(修复 B6)。
//
// "增量同步(incremental)" 的正道通道 = 托管 Zero-ETL Integration(近实时 CDC),
// 替代此前 Glue 批处理靠 WHERE 谓词模拟的"假增量"。本服务把人工 CLI 实测打通的全链路
// 固化为幂等代码:
//   1) 独立 Redshift Serverless namespace + workgroup(开 enable_case_sensitive_identifier,
//      隔离 case-sensitivity 全局风险——主 bgp-namespace 绝不改);
//   2) namespace 资源策略授权 redshift.amazonaws.com 入站集成(Condition 锁定源实例 ARN);
//   3) rds:CreateIntegration(源=RDS实例ARN,目标=namespaceARN,data-filter 限定库.表);
//   4) 等集成 active 后在独立 wg 内 `CREATE DATABASE <db> FROM INTEGRATION '<id>'`
//      —— ⚠️ MySQL 源【不带】DATABASE 子句(MySQL 库→Redshift schema;带子句会报
//         "Unknown (arn, db) pair");需 superuser(CREATEDB+CREATEUSER);
//   5) 停止任务 = DeleteIntegration(成本闭环)。
//
// 实测铁证(见 RESUME-REALTIME / ZERO-ETL-DESIGN.local.md):
//   · 源参数仅需 binlog_format=ROW + binlog_row_image=full;不需要 DMS 的 checksum/row_metadata。
//   · 集成激活耗时长(~50min 冷启动,与表大小无关),故启动【异步】+ 状态端点幂等推进,
//     不靠单条超长轮询(进程重启即丢)。
//   · 独立 namespace 查询认证:用其自身 admin 密钥(superuser)或 IAM 临时凭证;
//     主 namespace 的 admin 密钥【无法】认证独立 namespace(实测 FATAL password auth failed)。
//   · 凭证零硬编码(红线②):独立 namespace admin 密码随机生成、仅写入 Secrets Manager。

import { homeRegion } from "@/lib/place/home-region";
// G6(模块 50):凭证缓存改复合键 —— 见下方 getZeroEtlSecretArn 的注释。
// @kf-batch 50-WP31-place-first-class —— 散建客户端收口到唯一工厂(L3;行为保持:构造参数原样,见 lib/aws/clients.ts#sdkClient)
import { sdkClient } from "@/lib/aws/clients";
import { HOME_TARGET_ID, isHome } from "@/lib/exec-env/target-id";
import { credCacheKey, ProcessCache } from "@/lib/exec-env/cred-cache";
import { RDSClient, CreateIntegrationCommand, DeleteIntegrationCommand, DescribeIntegrationsCommand } from "@aws-sdk/client-rds";
import { RedshiftClient, PutResourcePolicyCommand } from "@aws-sdk/client-redshift";
import {
  RedshiftServerlessClient,
  GetNamespaceCommand,
  CreateNamespaceCommand,
  UpdateNamespaceCommand,
  GetWorkgroupCommand,
  CreateWorkgroupCommand,
} from "@aws-sdk/client-redshift-serverless";
import { ExecuteStatementCommand, DescribeStatementCommand, GetStatementResultCommand } from "@aws-sdk/client-redshift-data";
import { redshiftClientForHomeOnly } from "@/lib/exec-env/target-clients";
import { SecretsManagerClient, DescribeSecretCommand, CreateSecretCommand, PutSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { randomBytes } from "crypto";
import { logger } from "@/lib/observability/logger";

const region = homeRegion();

// 独立 Zero-ETL 数仓(与主 bgp-namespace 隔离,规避 enable_case_sensitive_identifier 全局影响)。
export const ZEROETL_NAMESPACE = process.env.ZEROETL_NAMESPACE || "bgp-zeroetl-ns";
export const ZEROETL_WORKGROUP = process.env.ZEROETL_WORKGROUP || "bgp-zeroetl-wg";
const ZEROETL_SECRET_ID = process.env.ZEROETL_SECRET_ID || "bgp/zeroetl/admin";
const ZEROETL_ADMIN_USER = "admin";
const ZEROETL_BASE_RPU = 8; // 最小基础容量,控成本

const rds = sdkClient("data-plane", RDSClient, { region });
const redshift = sdkClient("data-plane", RedshiftClient, { region });
const rss = sdkClient("data-plane", RedshiftServerlessClient, { region });

// 生成 Redshift 接受、无禁用字符({},;/@" 空格)的强密码(含大小写+数字)。
function genRedshiftPassword(): string {
  return "Zx9" + randomBytes(24).toString("base64").replace(/[^A-Za-z0-9]/g, "") + "aB7";
}

// 资源命名(由 taskId 派生,稳定可追溯,符合命名规则)。
export function zeroEtlNames(taskId: string) {
  const short = taskId.slice(-12).toLowerCase().replace(/[^a-z0-9]/g, "");
  return {
    integrationName: `bgp-zeroetl-${short}`,
    destDb: `zeroetl_${short}`,
  };
}

const notFound = (e: any) =>
  e?.name === "ResourceNotFoundException" || /not (exist|found)/i.test(e?.message || "");

// 独立 namespace admin 密钥 ARN(缓存)。缺失返回 undefined,查询时回退 IAM 临时凭证。
//
// ── 🔴 G6(模块 50)改造:进程级**单值**缓存 → **复合键**缓存 ───────────────────────
// 这是 R9 才发现的**第二个**凭证缓存。只改 `redshift/admin-secret.ts` 那一个的话,
// **zero-etl 查询路径会绕过隔离**(`redshift/execute` 与 zero-etl 是两条分叉:
// 前者按 workgroup 三元分派,后者用本函数),等于隔离只做了一半、还看不出任何异常。
// 键 = `${targetId}#${project ?? "-"}#zeroetl-admin`(SSOT 见 lib/exec-env/cred-cache.ts)。
//
// 无参调用 == 从前的 home 路径,逐字节等价(同 env、同 DescribeSecret、同样缓存负结果);
// 非 home 显式抛错(本函数不该从 env 猜别的区域的 secret)。G 阶段无人传非 home ⇒ 行为变化 0。
const ZEROETL_CRED_PURPOSE = "zeroetl-admin";
const zeroEtlArnCache = new ProcessCache<string>();

function zeroEtlCacheKey(targetId: string, project?: string): string {
  if (!isHome(targetId)) {
    throw new Error(
      `getZeroEtlSecretArn 只负责 home 的 zero-etl admin secret;target ${targetId} 请走 ` +
        `getPrivilegedCred(targetId, { purpose: "project-context" })(50 SPEC §3.9)`
    );
  }
  return credCacheKey({ targetId, project, purpose: ZEROETL_CRED_PURPOSE });
}

export async function getZeroEtlSecretArn(opts?: { targetId?: string; project?: string }): Promise<string | undefined> {
  const key = zeroEtlCacheKey(opts?.targetId ?? HOME_TARGET_ID, opts?.project);
  const v = await zeroEtlArnCache.resolve(key, async () => {
    try {
      const sm = sdkClient("data-plane", SecretsManagerClient, { region });
      const r = await sm.send(new DescribeSecretCommand({ SecretId: ZEROETL_SECRET_ID }));
      return r.ARN || null;
    } catch {
      return null;
    }
  });
  return v || undefined;
}

/** 单测 / 排障用:清缓存。 */
export function __resetZeroEtlSecretArnCache(): void {
  zeroEtlArnCache.clear();
}

/**
 * secret 写后失活:清掉该 target 的**全部** zero-etl 槽。
 *
 * 🔴 **G7 修正(外部审核 v2 P2-2 连带发现)**:原来只清 `zeroEtlCacheKey(HOME_TARGET_ID)`
 * 这**一个**槽(project 为空的那个)。但缓存键含 project 维 ⇒ 同 target 下可能有多个槽,
 * 它们缓存的是同一个 secret。"secret 从不存在 → 刚创建"这一转换后,**按 project 缓存的 `null`
 * 会留着**,那个 project 的调用继续回落 IAM 身份,而且不报错、看不出来。
 * **失活粒度必须 ≥ 缓存粒度**,否则就是一次 no-op 式的"看起来失活了"。
 */
export function invalidateZeroEtlSecretArn(targetId: string = HOME_TARGET_ID): number {
  zeroEtlCacheKey(targetId); // 复用同一道 home 校验:非 home 直接抛,不静默无操作
  return zeroEtlArnCache.invalidatePrefix(`${targetId}#`);
}

// 写独立 namespace admin 密钥(完整字段;密码仅入 Secrets Manager,不进日志)。
async function writeZeroEtlSecret(sm: SecretsManagerClient, username: string, password: string): Promise<void> {
  const secretString = JSON.stringify({
    username,
    password,
    host: `${ZEROETL_WORKGROUP}.${process.env.AWS_ACCOUNT_ID || ""}.${region}.redshift-serverless.amazonaws.com`,
    port: 5439,
    database: "dev",
  });
  try {
    await sm.send(new CreateSecretCommand({ Name: ZEROETL_SECRET_ID, SecretString: secretString }));
  } catch {
    await sm.send(new PutSecretValueCommand({ SecretId: ZEROETL_SECRET_ID, SecretString: secretString }));
  }
  // 失效缓存,下次重新解析 ARN。G6:按复合键失效(不误清别的 target);
  // G7:清该 target 的**全部**槽 —— 只清 project 为空那一槽会漏掉按 project 缓存的 null(见函数注释)。
  invalidateZeroEtlSecretArn(HOME_TARGET_ID);
}

export interface ZeroEtlWarehouse {
  namespaceArn: string;
  workgroupName: string;
  secretArn?: string;
}

// 幂等确保独立 Zero-ETL 数仓就绪(namespace + 开 case-sensitive 的 workgroup + admin 密钥)。
// 已存在则复用(本账号验证期已建,reusable);workgroup 首建 ~1min 进入 AVAILABLE。
export async function ensureZeroEtlWarehouse(): Promise<ZeroEtlWarehouse> {
  const sm = sdkClient("data-plane", SecretsManagerClient, { region });

  // 1) namespace:查→建。建/补时生成 admin 密码写入密钥。
  let namespaceArn = "";
  try {
    const g = await rss.send(new GetNamespaceCommand({ namespaceName: ZEROETL_NAMESPACE }));
    namespaceArn = g.namespace?.namespaceArn || "";
    // namespace 已存在:确保密钥也在(否则重设 admin 密码并写密钥,保证后续认证可用)。
    let secretExists = false;
    try {
      await sm.send(new DescribeSecretCommand({ SecretId: ZEROETL_SECRET_ID }));
      secretExists = true;
    } catch {
      /* 密钥缺失 */
    }
    if (!secretExists) {
      const pwd = genRedshiftPassword();
      await rss.send(new UpdateNamespaceCommand({ namespaceName: ZEROETL_NAMESPACE, adminUsername: ZEROETL_ADMIN_USER, adminUserPassword: pwd }));
      await writeZeroEtlSecret(sm, ZEROETL_ADMIN_USER, pwd);
      logger.info("zeroetl.namespace.secret.reset", { namespace: ZEROETL_NAMESPACE });
    }
  } catch (e: any) {
    if (!notFound(e)) throw e;
    const pwd = genRedshiftPassword();
    const c = await rss.send(new CreateNamespaceCommand({ namespaceName: ZEROETL_NAMESPACE, adminUsername: ZEROETL_ADMIN_USER, adminUserPassword: pwd, dbName: "dev" }));
    namespaceArn = c.namespace?.namespaceArn || "";
    await writeZeroEtlSecret(sm, ZEROETL_ADMIN_USER, pwd);
    logger.info("zeroetl.namespace.created", { namespace: ZEROETL_NAMESPACE });
  }

  // 2) workgroup:查→建(开 enable_case_sensitive_identifier — Zero-ETL 必需;最小 RPU 控成本)。
  try {
    await rss.send(new GetWorkgroupCommand({ workgroupName: ZEROETL_WORKGROUP }));
  } catch (e: any) {
    if (!notFound(e)) throw e;
    await rss.send(new CreateWorkgroupCommand({
      workgroupName: ZEROETL_WORKGROUP,
      namespaceName: ZEROETL_NAMESPACE,
      baseCapacity: ZEROETL_BASE_RPU,
      configParameters: [{ parameterKey: "enable_case_sensitive_identifier", parameterValue: "true" }],
    }));
    logger.info("zeroetl.workgroup.created", { workgroup: ZEROETL_WORKGROUP });
  }

  const secretArn = await getZeroEtlSecretArn();
  return { namespaceArn, workgroupName: ZEROETL_WORKGROUP, secretArn };
}

// namespace 资源策略:授权 redshift 服务做入站集成(锁定源实例 ARN)+ 本账号 root 建入站集成。
// 幂等:直接 Put 覆盖。
export async function ensureNamespaceResourcePolicy(namespaceArn: string, sourceArn: string, accountId: string): Promise<void> {
  const policy = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "redshift.amazonaws.com" },
        Action: ["redshift:AuthorizeInboundIntegration"],
        Condition: { StringEquals: { "aws:SourceArn": sourceArn } },
      },
      {
        Effect: "Allow",
        Principal: { AWS: `arn:aws:iam::${accountId}:root` },
        Action: "redshift:CreateInboundIntegration",
      },
    ],
  });
  await redshift.send(new PutResourcePolicyCommand({ ResourceArn: namespaceArn, Policy: policy }));
  logger.info("zeroetl.resourcepolicy.put", { namespaceArn });
}

// data-filter 构造:限定库.表(无表则整库)。多表逗号分隔。
export function buildZeroEtlDataFilter(database: string, tables: string[]): string {
  if (!tables || tables.length === 0) return `include: ${database}.*`;
  return "include: " + tables.map((t) => `${database}.${t}`).join(", ");
}

function arnToIntegrationId(arn: string): string {
  return arn.split(":integration:").pop() || arn.split("/").pop() || arn;
}

// 按名查已有集成(DescribeIntegrations 无 name 过滤,列举后匹配),用于幂等。
async function findIntegrationByName(name: string): Promise<{ arn: string; status: string } | null> {
  const r = await rds.send(new DescribeIntegrationsCommand({}));
  const found = (r.Integrations || []).find((i) => i.IntegrationName === name);
  return found ? { arn: found.IntegrationArn!, status: found.Status || "unknown" } : null;
}

export interface IntegrationRef {
  integrationArn: string;
  integrationId: string;
  status: string;
}

// 幂等创建集成(撞名复用)。
export async function ensureIntegration(input: {
  sourceArn: string;
  targetArn: string;
  integrationName: string;
  dataFilter: string;
}): Promise<IntegrationRef> {
  const existing = await findIntegrationByName(input.integrationName);
  if (existing) {
    return { integrationArn: existing.arn, integrationId: arnToIntegrationId(existing.arn), status: existing.status };
  }
  const r = await rds.send(
    new CreateIntegrationCommand({
      SourceArn: input.sourceArn,
      TargetArn: input.targetArn,
      IntegrationName: input.integrationName,
      DataFilter: input.dataFilter,
    })
  );
  logger.info("zeroetl.integration.created", { name: input.integrationName });
  return { integrationArn: r.IntegrationArn!, integrationId: arnToIntegrationId(r.IntegrationArn!), status: r.Status || "creating" };
}

// 查集成状态 + 错误(creating / active / failed / ...)。
export async function getIntegrationStatus(integrationArn: string): Promise<{ status: string; errors: string[] }> {
  const r = await rds.send(new DescribeIntegrationsCommand({ IntegrationIdentifier: integrationArn }));
  const i = r.Integrations?.[0];
  return {
    status: i?.Status || "unknown",
    errors: (i?.Errors || []).map((e) => `${e.ErrorCode || ""}: ${e.ErrorMessage || ""}`.trim()),
  };
}

// 在独立 wg 上以 admin(superuser)身份执行 SQL,等 FINISHED。缺密钥则回退 IAM 临时凭证。
async function execZeroEtlSql(sql: string, database = "dev"): Promise<string> {
  // @kf-batch 50-WP2-directquery —— 合同 home-only:zero-ETL 是**主控区里的独立 namespace**,
  // 有自己的密钥缓存(`getZeroEtlSecretArn` 对非 home 直接抛)⇒ 这条路不存在"按 target 取 region"。
  const client = redshiftClientForHomeOnly("zeroetl-home-namespace");
  const SecretArn = await getZeroEtlSecretArn();
  const { Id } = await client.send(
    new ExecuteStatementCommand({ Sql: sql, WorkgroupName: ZEROETL_WORKGROUP, Database: database, ...(SecretArn ? { SecretArn } : {}) })
  );
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const d = await client.send(new DescribeStatementCommand({ Id }));
    if (d.Status === "FINISHED") return Id!;
    if (d.Status === "FAILED" || d.Status === "ABORTED") throw new Error(`Redshift SQL 失败: ${d.Error || d.Status}`);
  }
  throw new Error("Redshift SQL 超时");
}

// 目标库是否已存在(幂等建库前置)。
export async function destinationDatabaseExists(destDb: string): Promise<boolean> {
  // @kf-batch 50-WP2-directquery —— 合同 home-only:zero-ETL 是**主控区里的独立 namespace**,
  // 有自己的密钥缓存(`getZeroEtlSecretArn` 对非 home 直接抛)⇒ 这条路不存在"按 target 取 region"。
  const client = redshiftClientForHomeOnly("zeroetl-home-namespace");
  const SecretArn = await getZeroEtlSecretArn();
  const { Id } = await client.send(
    new ExecuteStatementCommand({
      Sql: `SELECT 1 FROM pg_database_info WHERE datname = '${destDb}';`,
      WorkgroupName: ZEROETL_WORKGROUP,
      Database: "dev",
      ...(SecretArn ? { SecretArn } : {}),
    })
  );
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const d = await client.send(new DescribeStatementCommand({ Id }));
    if (d.Status === "FINISHED") {
      const res = await client.send(new GetStatementResultCommand({ Id }));
      return (res.Records?.length || 0) > 0;
    }
    if (d.Status === "FAILED" || d.Status === "ABORTED") throw new Error(`查库失败: ${d.Error || d.Status}`);
  }
  throw new Error("查库超时");
}

// 幂等建目标库:CREATE DATABASE <db> FROM INTEGRATION '<id>';(⚠️ MySQL 源不带 DATABASE 子句)。
// 须在集成 active 后调用;需 superuser。
export async function ensureDestinationDatabase(destDb: string, integrationId: string): Promise<void> {
  if (await destinationDatabaseExists(destDb)) return;
  await execZeroEtlSql(`CREATE DATABASE ${destDb} FROM INTEGRATION '${integrationId}';`);
  logger.info("zeroetl.destdb.created", { destDb });
}

// 查各表已复制行数(供详情页/验证展示)。某表查不到(同步中/无 PK)返回 null,不臆造。
export async function getReplicatedCounts(destDb: string, schema: string, tables: string[]): Promise<{ table: string; rows: number | null }[]> {
  // @kf-batch 50-WP2-directquery —— 合同 home-only:zero-ETL 是**主控区里的独立 namespace**,
  // 有自己的密钥缓存(`getZeroEtlSecretArn` 对非 home 直接抛)⇒ 这条路不存在"按 target 取 region"。
  const client = redshiftClientForHomeOnly("zeroetl-home-namespace");
  const SecretArn = await getZeroEtlSecretArn();
  const out: { table: string; rows: number | null }[] = [];
  for (const t of tables) {
    let rows: number | null = null;
    try {
      const { Id } = await client.send(
        new ExecuteStatementCommand({ Sql: `SELECT COUNT(*) FROM ${schema}.${t};`, WorkgroupName: ZEROETL_WORKGROUP, Database: destDb, ...(SecretArn ? { SecretArn } : {}) })
      );
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const d = await client.send(new DescribeStatementCommand({ Id }));
        if (d.Status === "FINISHED") {
          const res = await client.send(new GetStatementResultCommand({ Id }));
          const cell = res.Records?.[0]?.[0];
          rows = cell?.longValue != null ? Number(cell.longValue) : cell?.stringValue != null ? Number(cell.stringValue) : null;
          break;
        }
        if (d.Status === "FAILED" || d.Status === "ABORTED") break;
      }
    } catch {
      /* best-effort */
    }
    out.push({ table: t, rows });
  }
  return out;
}

// 删集成(停止任务的成本闭环)。
export async function deleteZeroEtlIntegration(integrationArn: string): Promise<void> {
  await rds.send(new DeleteIntegrationCommand({ IntegrationIdentifier: integrationArn }));
  logger.info("zeroetl.integration.deleted", { integrationArn });
}

// 删目标库(best-effort;集成删除后调用,便于同名任务重启时干净重建)。
export async function dropDestinationDatabase(destDb: string): Promise<void> {
  try {
    await execZeroEtlSql(`DROP DATABASE ${destDb};`);
    logger.info("zeroetl.destdb.dropped", { destDb });
  } catch (e: any) {
    logger.warn?.("zeroetl.destdb.drop.failed", { destDb, error: String(e?.message || e).slice(0, 200) });
  }
}
