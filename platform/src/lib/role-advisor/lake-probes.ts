// 数据湖表桶路由—— **按表桶量权限**的探针(设计稿 §6.6),纯函数。
//
// 【缺陷原形】自定义执行角色预检只量引擎基线 + 脚本 / 依赖的 s3:// 引用,对 S3 Tables 一个字不量 ⇒ 角色缺某个桶的
//   s3tables 权限照样保存成功,运行到第一次访问表才 403。
// 【规则】每条被选中的路由(§6.3 selectRoutes 的产物,带 access):
//   read  ⇒ 桶 ARN 上 GetTableBucket / ListNamespaces / GetNamespace / ListTables;表 ARN(bucket/<桶>/table/*)上 GetTable /
//            GetTableMetadataLocation / GetTableData;
//   write ⇒ 再加 桶 ARN 上 CreateNamespace / CreateTable;表 ARN 上 PutTableData / UpdateTableMetadataLocation;
//   Glue 引擎 ⇒ 另量联邦目录(Iceberg GlueCatalog 经 Glue Data Catalog 读元数据):catalog/s3tablescatalog/<桶> ·
//            database/s3tablescatalog/<桶>/* · table/s3tablescatalog/<桶>/*/* 上的 GetDatabase / GetTable / GetTables;写再加
//            CreateTable / UpdateTable / CreateDatabase。EMR 的 S3TablesCatalog 不走 Glue ⇒ 不量这组。
// 每条探针 sid = `LakeRoute:<alias>:<read|write>`,why 点名路由、桶与访问方式;预检文案据 sid 前缀给出第 ④ 条出路。
// 🔴 本文件只 import 类型,不碰 AWS:它是 lib/lake/routes.ts 的附属作者(routes.ts re-export 它)。
import type { SelectedRoute } from "@/lib/lake/routes";
import type { ExecRoleEngine } from "@/lib/execution-role/types";

export const LAKE_ROUTE_SID_PREFIX = "LakeRoute:";

export interface LakeRouteProbe {
  sid: string;
  action: string;
  resource: string;
  why: string;
}

const S3T_BUCKET_READ = ["s3tables:GetTableBucket", "s3tables:ListNamespaces", "s3tables:GetNamespace", "s3tables:ListTables"];
const S3T_TABLE_READ = ["s3tables:GetTable", "s3tables:GetTableMetadataLocation", "s3tables:GetTableData"];
const S3T_BUCKET_WRITE = ["s3tables:CreateNamespace", "s3tables:CreateTable"];
const S3T_TABLE_WRITE = ["s3tables:PutTableData", "s3tables:UpdateTableMetadataLocation"];
const GLUE_READ = ["glue:GetDatabase", "glue:GetTable", "glue:GetTables"];
const GLUE_WRITE = ["glue:CreateTable", "glue:UpdateTable", "glue:CreateDatabase"];

/** 联邦目录三种资源形态(与 IAM 对 Glue Data Catalog 资源的 ARN 形态一致;目录 id = s3tablescatalog/<桶>)。 */
export function federatedCatalogArns(region: string, account: string, bucket: string): string[] {
  return [
    `arn:aws:glue:${region}:${account}:catalog/s3tablescatalog/${bucket}`,
    `arn:aws:glue:${region}:${account}:database/s3tablescatalog/${bucket}/*`,
    `arn:aws:glue:${region}:${account}:table/s3tablescatalog/${bucket}/*/*`,
  ];
}

export function lakeRouteProbes(routes: readonly SelectedRoute[], ctx: { engine: ExecRoleEngine; account: string }): LakeRouteProbe[] {
  const out: LakeRouteProbe[] = [];
  for (const r of routes) {
    const sid = `${LAKE_ROUTE_SID_PREFIX}${r.alias}:${r.access}`;
    const why = `作业声明了数据湖路由「${r.alias}」(${r.bucket})为${r.access === "write" ? "写" : "读"};没有这条权限,运行会在第一次访问该桶的表时就 403`;
    const bucketArn = `arn:aws:s3tables:${r.region}:${ctx.account}:bucket/${r.bucket}`;
    const tableArn = `${bucketArn}/table/*`;
    const push = (actions: readonly string[], resource: string) => { for (const action of actions) out.push({ sid, action, resource, why }); };
    push(S3T_BUCKET_READ, bucketArn);
    push(S3T_TABLE_READ, tableArn);
    if (r.access === "write") { push(S3T_BUCKET_WRITE, bucketArn); push(S3T_TABLE_WRITE, tableArn); }
    if (ctx.engine === "glue") {
      for (const arn of federatedCatalogArns(r.region, ctx.account, r.bucket)) {
        push(GLUE_READ, arn);
        if (r.access === "write") push(GLUE_WRITE, arn);
      }
    }
  }
  return out;
}
