#!/usr/bin/env bash
###############################################################################
# scripts/lib/s3tables-catalog.sh —— S3 Tables 联邦目录 `s3tablescatalog`(Glue Data Catalog 里的 FederatedCatalog,
#   ConnectionName=aws:s3tables)的**安装 / 升级期唯一作者**。
#     s3tables_catalog_exists <region>    只读:存在回 0;不存在回 1;读不到(权限 / 网络)回 2 并把 aws 原话打到 stderr
#     ensure_s3tables_catalog <region>    幂等:有则「已在」;无则 create-catalog(入参与平台运行时
#                                          platform/src/lib/aws/s3tables-catalog.ts 的 s3TablesFederatedCatalogInput 逐字段相同);
#                                          读不到 ⇒ die(不把「读不到」当「不存在」去盲建)
#
# 🔴 为什么存在(序 43 B-91,2026-10-16):Athena 直查 / 问数靠这个目录把本区 S3 Tables 表桶暴露成
#   `"s3tablescatalog/<表桶>"."<命名空间>"."<表>"`。它不是 CDK 能建的资源(CloudFormation 没有对应类型),deploy-all /
#   redeploy-platform / 执行区栈组都没建它;平台只在「同步任务写 S3 Tables」的启动路径里懒创建 ⇒ 全新账号只要没跑过
#   那样一次同步,直查 / 问数一律 CATALOG_NOT_FOUND(…7698 页面驱动 p43c 坐实;…4400 有,是 10-14 一次同步启动顺手建的)。
#   ⇒ 安装(deploy-all 6.3,主控区)与升级(redeploy-platform 3c,主控区 + 每个已注册执行区)都在这里显式开通;
#     运行时另保留一道自愈(同步启动 + 直查,lib/aws/s3tables-catalog.ts)。真就位判据 02-postdeploy-truth.sh 第 10 条。
#
# 使用约定(source 本文件的一方必须**先**定义好):变量 PROFILE;函数 info() die()。本文件只定义,不执行(不 set -e、不改 cwd)。
###############################################################################

S3TABLES_CATALOG_ID="s3tablescatalog"

s3tables_catalog_exists() {  # $1=region ⇒ 0 在 / 1 不在 / 2 读不到
  local region="$1" out
  if out=$(aws glue get-catalog --catalog-id "$S3TABLES_CATALOG_ID" --profile "$PROFILE" --region "$region" --output json 2>&1); then
    return 0
  fi
  case "$out" in
    *EntityNotFoundException*|*"not found"*|*"does not exist"*) return 1;;
  esac
  printf '%s\n' "$out" >&2
  return 2
}

ensure_s3tables_catalog() {  # $1=region
  local region="$1" rc=0 acct input
  [ -n "$region" ] || die "ensure_s3tables_catalog: 缺 region 参数"
  # 🔴 set -e 之下 `f; rc=$?` 会当场杀掉脚本 ⇒ 用 `|| rc=$?`
  s3tables_catalog_exists "$region" || rc=$?
  case "$rc" in
    0) info "  $region:联邦目录 $S3TABLES_CATALOG_ID 已在"; return 0;;
    2) die "$region:读不到联邦目录 $S3TABLES_CATALOG_ID(上面是 aws 原话;是权限 / 网络问题,不是「不存在」,不盲建)";;
  esac
  acct=$(aws sts get-caller-identity --profile "$PROFILE" --query Account --output text 2>/dev/null) \
    || die "$region:取不到账号号(sts get-caller-identity),无法拼联邦目录的 Identifier"
  info "  $region:联邦目录 $S3TABLES_CATALOG_ID 不存在 ⇒ create-catalog(FederatedCatalog aws:s3tables ⇒ 本区全部表桶)"
  # 入参与 platform/src/lib/aws/s3tables-catalog.ts#s3TablesFederatedCatalogInput 逐字段相同(判据钉两边)
  input=$(printf '{"Description":"Federated catalog for S3 Tables","FederatedCatalog":{"Identifier":"arn:aws:s3tables:%s:%s:bucket/*","ConnectionName":"aws:s3tables"},"CreateDatabaseDefaultPermissions":[{"Principal":{"DataLakePrincipalIdentifier":"IAM_ALLOWED_PRINCIPALS"},"Permissions":["ALL"]}],"CreateTableDefaultPermissions":[{"Principal":{"DataLakePrincipalIdentifier":"IAM_ALLOWED_PRINCIPALS"},"Permissions":["ALL"]}]}' "$region" "$acct")
  aws glue create-catalog --profile "$PROFILE" --region "$region" --name "$S3TABLES_CATALOG_ID" --catalog-input "$input" >/dev/null \
    || die "$region:create-catalog 失败(部署身份需要 glue:CreateCatalog 与 glue:PassConnection(connection/aws:s3tables);上面是 aws 原话)"
  rc=0; s3tables_catalog_exists "$region" || rc=$?
  [ "$rc" = 0 ] || die "$region:create-catalog 返回成功但回读不到 $S3TABLES_CATALOG_ID(rc=$rc)"
  info "  $region:联邦目录 $S3TABLES_CATALOG_ID 已开通"
}
