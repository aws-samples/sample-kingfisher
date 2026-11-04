#!/usr/bin/env bash
# 账号级幂等前置项（在 `cdk bootstrap` 之后、部署栈之前执行一次即可）。
#
# 为什么需要它：有些资源是【账号级全局单例】，不能放进 CDK 应用栈——否则在
# 「该资源已存在」的账号上 CloudFormation 会以 AlreadyExists 失败并回滚整个栈。
# 典型坑：OpenSearch/Elasticsearch 的 service-linked role
# (AWSServiceRoleForAmazonElasticsearchService)。在全新 workshop 账号上它往往
# 已存在，导致 BgpOmSearchStack 创建失败。故从栈中移除、改由本脚本幂等保证。
#
# 用法: ./scripts/00-prereqs.sh <aws-profile> [region]
set -euo pipefail
PROFILE="${1:-temp-account}"
REGION="${2:-us-east-1}"

ACCT=$(aws sts get-caller-identity --profile "$PROFILE" --region "$REGION" --query Account --output text)
echo "[prereqs] profile=$PROFILE region=$REGION account=$ACCT"

echo "[prereqs] ensuring service-linked role for es.amazonaws.com (OpenSearch) ..."
if aws iam create-service-linked-role --aws-service-name es.amazonaws.com \
     --profile "$PROFILE" --region "$REGION" >/dev/null 2>&1; then
  echo "  created."
else
  echo "  already exists (ok)."
fi

# 模块 25 (故障诊断 / AWS DevOps Agent): 首次 CreateChat/SendMessage 需 SLR
# AWSServiceRoleForAIDevOps 存在。虽然 TaskRole 有 iam:CreateServiceLinkedRole,但同请求内
# 现建现用有 IAM 最终一致性竞态(实测诊断一直 failed)。故账号级预建,确保已传播。
echo "[prereqs] ensuring service-linked role for aidevops.amazonaws.com (DevOps Agent) ..."
if aws iam create-service-linked-role --aws-service-name aidevops.amazonaws.com \
     --profile "$PROFILE" --region "$REGION" >/dev/null 2>&1; then
  echo "  created."
else
  echo "  already exists (ok)."
fi

# 模块 31 (实时 CDC): DMS 账号级固定名角色。必须【先于】部署 BgpRealtimeStack 存在并传播,
# 否则建 DMS 子网组报 "dms-vpc-role is not configured properly"(IAM 最终一致性竞态:同栈内
# 现建现用会失败)。故作为账号级前置幂等创建,栈部署带 -c skip-dms-roles=1 跳过。
# 模块 31 (DMS Serverless): 需 SLR AWSServiceRoleForDMSServerless(dms.amazonaws.com)。
# 首次 CreateReplicationConfig 时 AWS 建它,但 TaskRole 无 iam:CreateServiceLinkedRole 会失败。账号级预建。
echo "[prereqs] ensuring service-linked role for dms.amazonaws.com (DMS Serverless) ..."
if aws iam create-service-linked-role --aws-service-name dms.amazonaws.com \
     --profile "$PROFILE" --region "$REGION" >/dev/null 2>&1; then
  echo "  created."
else
  echo "  already exists (ok)."
fi

echo "[prereqs] ensuring DMS service roles (dms-vpc-role / dms-cloudwatch-logs-role) ..."
ensure_dms_role() {
  local role="$1" policy="$2"
  aws iam create-role --role-name "$role" \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"dms.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
    --profile "$PROFILE" --region "$REGION" >/dev/null 2>&1 \
    && echo "  + $role created" || echo "  = $role (exists)"
  aws iam attach-role-policy --role-name "$role" --policy-arn "$policy" \
    --profile "$PROFILE" --region "$REGION" >/dev/null 2>&1 || true
}
ensure_dms_role dms-vpc-role            arn:aws:iam::aws:policy/service-role/AmazonDMSVPCManagementRole
ensure_dms_role dms-cloudwatch-logs-role arn:aws:iam::aws:policy/service-role/AmazonDMSCloudWatchLogsRole

echo "[prereqs] done."
