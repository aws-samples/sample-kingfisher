// S3 Tables 联邦目录 `s3tablescatalog` 的**运行时唯一作者**。
//
// 事实:Athena 直查 / 问数靠 Glue Data Catalog 里的 FederatedCatalog(ConnectionName=aws:s3tables)把本区所有 S3 Tables 表桶
//   暴露成 `"s3tablescatalog/<表桶>"."<命名空间>"."<表>"`。它不是 CDK 能建的资源(CloudFormation 没有对应类型);原来只有
//   `lib/sync/start-run.ts` 在「同步任务写 S3 Tables」的启动路径里懒创建 ⇒ 全新账号只要没跑过那样一次同步,数据湖直查一律
//   `CATALOG_NOT_FOUND`(…7698 页面驱动 p43c SETUP-A 坐实;…4400 之所以有,是 2026-10-14 一次同步启动顺手建的,CloudTrail 可查)。
// 修法:安装 / 升级期 `scripts/lib/s3tables-catalog.sh` 显式开通(主控区 + 每个执行区);运行时同步启动与直查两处都调这里自愈。
//   两处入参(Identifier / ConnectionName / 两组默认权限)必须逐字段相同,判据 `__tests__/s3tables-catalog.test.ts` 钉。
import { CreateCatalogCommand, GetCatalogCommand, type CatalogInput, type GlueClient } from "@aws-sdk/client-glue";

export const S3TABLES_FEDERATED_CATALOG_ID = "s3tablescatalog";
export const S3TABLES_FEDERATED_CONNECTION = "aws:s3tables";

/** 开通联邦目录的入参(与 `scripts/lib/s3tables-catalog.sh` 的 `--catalog-input` 逐字段相同)。 */
export function s3TablesFederatedCatalogInput(region: string, accountId: string): CatalogInput {
  return {
    Description: "Federated catalog for S3 Tables",
    FederatedCatalog: {
      Identifier: `arn:aws:s3tables:${region}:${accountId}:bucket/*`,
      ConnectionName: S3TABLES_FEDERATED_CONNECTION,
    },
    CreateDatabaseDefaultPermissions: [{ Principal: { DataLakePrincipalIdentifier: "IAM_ALLOWED_PRINCIPALS" }, Permissions: ["ALL"] }],
    CreateTableDefaultPermissions: [{ Principal: { DataLakePrincipalIdentifier: "IAM_ALLOWED_PRINCIPALS" }, Permissions: ["ALL"] }],
  };
}

type GlueSender = Pick<GlueClient, "send">;

/** 查询文本 / 查询上下文是否打到联邦目录(只有这种查询才需要先确保目录在;别的 Athena 查询不碰 Glue)。 */
export function touchesS3TablesCatalog(query: string, context?: { catalog?: string }): boolean {
  return (context?.catalog || "").startsWith(S3TABLES_FEDERATED_CATALOG_ID) || query.includes(`${S3TABLES_FEDERATED_CATALOG_ID}/`);
}

/**
 * 确保某个区的联邦目录存在:GetCatalog 成功 ⇒ "existed";失败 ⇒ CreateCatalog(AlreadyExists 视为成功 ⇒ "existed")⇒ "created";
 * 其它错误如实上抛 —— 不许吞(吞掉的后果是下游 Glue 作业 / Athena 报一句离根因很远的 Catalog not found)。
 * 🔴 region 必填且非空(不猜主控区);accountId 只在**要建**时才需要(GetCatalog 不用它)—— 目录已在而账号号拿不到,不该把一条本来能跑的查询拦下;
 *    目录不在又没有账号号 ⇒ 抛清楚的话,不盲拼 Identifier。
 */
export async function ensureS3TablesFederatedCatalog(
  glue: GlueSender,
  where: { region: string; accountId: string },
): Promise<"existed" | "created"> {
  if (!where.region) throw new Error("ensureS3TablesFederatedCatalog: 缺 region(联邦目录是区级资源,不猜主控区)");
  try {
    await glue.send(new GetCatalogCommand({ CatalogId: S3TABLES_FEDERATED_CATALOG_ID }));
    return "existed";
  } catch {
    // 与原同步启动路径同义:GetCatalog 任何失败都去建;建不成才是真错(下面如实上抛)。
  }
  if (!where.accountId) {
    throw new Error(`ensureS3TablesFederatedCatalog: ${where.region} 的联邦目录 ${S3TABLES_FEDERATED_CATALOG_ID} 不存在,且缺 accountId(AWS_ACCOUNT_ID)无法开通`);
  }
  try {
    await glue.send(new CreateCatalogCommand({
      Name: S3TABLES_FEDERATED_CATALOG_ID,
      CatalogInput: s3TablesFederatedCatalogInput(where.region, where.accountId),
    }));
    return "created";
  } catch (e: any) {
    const name = e?.name || "";
    if (name === "AlreadyExistsException" || /already exists/i.test(e?.message || "")) return "existed";
    throw e;
  }
}
