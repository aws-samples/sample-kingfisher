#!/usr/bin/env bash
###############################################################################
# 02-postdeploy-truth.sh —— 部署后的「**真就位**」判据(`deploy-all` exit 0 不算)
#
#   ./scripts/02-postdeploy-truth.sh <aws-profile> [region]
#
# 🔴 为什么(docs/DEPLOY-RUNBOOK.md §5):`deploy-all` 退出 0 只覆盖它自己想到的判据 ——
#   「绿的只是当时想到的东西」。这 10 条是真值查询(加到 10),哪一条红就说明平台**装好了但不可用**。
#   这一串命令以前只写在手册里 ⇒ 换账号就得人肉敲(而人肉会漏)。
#
# 🔴 这**不是**无头页面验收的替代品:它查的是基础设施与接线的真值;
#   「页面上看得见、点得动」只有 `scripts/33-verify-regions-headless.py` 算数(用户红线)。
###############################################################################
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
PROFILE="${1:-temp-account}"
REGION="${2:-us-east-1}"
P="--profile $PROFILE --region $REGION"

BAD=0
ok()  { printf '  \033[1;32m✅\033[0m %s\n' "$*"; }
bad() { printf '  \033[1;31m❌\033[0m %s\n' "$*"; BAD=$((BAD+1)); }
sec() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }

out() { aws cloudformation describe-stacks $P --stack-name "$1" \
          --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text 2>/dev/null; }

sec "1) 栈全绿(无 ROLLBACK / FAILED)"
# 🔴 list-stacks 会把**已删除的栈**(DELETE_COMPLETE)留 90 天:首装回滚 → 删空栈 → 重跑成功的账号里,
#   同一个栈名会同时有一条 CREATE_COMPLETE(现网)和若干条 DELETE_COMPLETE(历史)。历史记录不是现网栈,
#   不能算「非 COMPLETE」(2026-10-19 全新账号重装后本条恒红,假红)。DELETE_IN_PROGRESS / DELETE_FAILED 仍是现网状态,照旧算红。
ROWS=$(aws cloudformation list-stacks $P --query 'StackSummaries[?starts_with(StackName,`Bgp`) && StackStatus!=`DELETE_COMPLETE`].[StackName,StackStatus]' --output text 2>/dev/null | sort -u)
TOT=$(printf '%s\n' "$ROWS" | grep -c . || true)
BADS=$(printf '%s\n' "$ROWS" | grep -Ev 'CREATE_COMPLETE|UPDATE_COMPLETE' || true)
if [ -n "$BADS" ]; then bad "有非 COMPLETE 的栈:$(printf '%s' "$BADS" | tr '\n' ' ')"; else ok "$TOT 个 Bgp* 栈全 COMPLETE"; fi

sec "2) 应用真在跑(running==desired 且只有 1 个 deployment)"
SVC=$(aws ecs describe-services $P --cluster bgp-cluster --services bgp-platform \
        --query 'services[0].[runningCount,desiredCount,length(deployments)]' --output text 2>/dev/null || true)
set -- ${SVC:-}
if [ "${1:-}" = "${2:-}" ] && [ -n "${1:-}" ] && [ "${3:-}" = "1" ]; then ok "ECS running=$1 desired=$2 deployments=$3"
else bad "ECS 状态不对:running=${1:-?} desired=${2:-?} deployments=${3:-?}(还在滚动 / 有任务起不来)"; fi

sec "3) 入口真可达(出 <title>Kingfisher</title>,且不是缓存页)"
URL=$(out BgpPlatformStack PlatformUrl)
if [ -z "$URL" ] || [ "$URL" = "None" ]; then bad "读不到 BgpPlatformStack.PlatformUrl"
else
  H=$(curl -sS -D- -o /tmp/kf-idx.html --max-time 30 "$URL/" 2>/dev/null | tr -d '\r' || true)
  if grep -q '<title>Kingfisher' /tmp/kf-idx.html 2>/dev/null; then
    ok "$URL 出 Kingfisher 首页($(printf '%s' "$H" | grep -i '^x-cache:' | head -1 | tr -d '\n' || echo 'x-cache 未回'))"
  else bad "$URL 首页不对(前 120 字:$(head -c 120 /tmp/kf-idx.html 2>/dev/null | tr -d '\n'))"; fi
fi

sec "4) 鉴权闸生效(未登录打 /api/projects 必须 401)"
if [ -n "${URL:-}" ] && [ "$URL" != "None" ]; then
  C=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$URL/api/projects" 2>/dev/null || echo 000)
  [ "$C" = "401" ] && ok "未登录 /api/projects = 401" || bad "未登录 /api/projects = $C(不是 401 ⇒ 鉴权闸没生效!)"
fi

sec "5) 能登录,且 token 里带 bgp-admin 组"
CID=$(out BgpAuthStack ClientId)
PW=$(python3 -c "import json;print(json.load(open('${BGP_PW_FILE:-/tmp/bgp-cognito-pw-$PROFILE.json}'))['admin'])" 2>/dev/null || true)
if [ -z "$CID" ] || [ "$CID" = "None" ]; then bad "读不到 BgpAuthStack.ClientId"
elif [ -z "$PW" ]; then bad "拿不到 admin 口令(${BGP_PW_FILE:-/tmp/bgp-cognito-pw-$PROFILE.json} 不在?)"
else
  TOK=$(aws cognito-idp initiate-auth $P --auth-flow USER_PASSWORD_AUTH --client-id "$CID" \
          --auth-parameters USERNAME=admin,PASSWORD="$PW" --query 'AuthenticationResult.IdToken' --output text 2>/dev/null || true)
  if [ -z "$TOK" ] || [ "$TOK" = "None" ]; then bad "admin 登录失败(口令对不上?)"
  else
    GRP=$(printf '%s' "$TOK" | python3 -c '
import sys,json,base64
p=sys.stdin.read().split(".")[1]; p+="="*(-len(p)%4)
print(",".join(json.loads(base64.urlsafe_b64decode(p)).get("cognito:groups") or []))' 2>/dev/null || true)
    case ",$GRP," in *,bgp-admin,*) ok "admin 登录成功,组=$GRP";; *) bad "登录成功但组里没有 bgp-admin(组=$GRP)";; esac
  fi
fi

sec "6) 关键表就位(bgp-query-handles 主键必须是 handleId、TTL 属性 ttl ENABLED)"
K=$(aws dynamodb describe-table $P --table-name bgp-query-handles --query 'Table.KeySchema[0].AttributeName' --output text 2>/dev/null || true)
[ "$K" = "handleId" ] && ok "bgp-query-handles 主键 = handleId" || bad "bgp-query-handles 主键 = ${K:-读不到}(应为 handleId)"
T=$(aws dynamodb describe-time-to-live $P --table-name bgp-query-handles --query 'TimeToLiveDescription.[TimeToLiveStatus,AttributeName]' --output text 2>/dev/null || true)
case "$T" in "ENABLED	ttl") ok "TTL = ENABLED on ttl";; *) bad "TTL 不对:${T:-读不到}";; esac

sec "7) 接线没被冲回(裸 cdk deploy 会把 AI 接线静默冲成空)"
TD=$(aws ecs describe-services $P --cluster bgp-cluster --services bgp-platform --query 'services[0].taskDefinition' --output text 2>/dev/null || true)
if [ -z "$TD" ] || [ "$TD" = "None" ]; then bad "读不到 task definition"
else
  ENVJ=$(aws ecs describe-task-definition $P --task-definition "$TD" \
          --query 'taskDefinition.containerDefinitions[0].environment' --output json 2>/dev/null || echo '[]')
  for K2 in OPENMETADATA_URL GENBI_BACKEND GENBI_RUNTIME_ARN NETADVISOR_RUNTIME_ARN PARAMADVISOR_RUNTIME_ARN; do
    V=$(printf '%s' "$ENVJ" | python3 -c "
import json,sys
e={x['name']:x.get('value','') for x in json.load(sys.stdin)}
print(e.get('$K2',''))" 2>/dev/null || true)
    [ -n "$V" ] && ok "$K2 非空" || bad "$K2 是空的 ⇒ 用 scripts/redeploy-platform.sh 重接线(别裸 cdk deploy)"
  done
fi

sec "8) 执行环境部署机制在(缺它新建执行环境必报 Function not found)"
aws lambda get-function-configuration $P --function-name bgp-exec-env-broker >/dev/null 2>&1 \
  && ok "broker Lambda bgp-exec-env-broker 在" || bad "没有 bgp-exec-env-broker ⇒ 补发 BgpExecEnvDeployStack"
aws codebuild batch-get-projects $P --names bgp-exec-env-deploy --query 'projects[0].name' --output text >/dev/null 2>&1 \
  && ok "CodeBuild 项目 bgp-exec-env-deploy 在" || bad "没有 bgp-exec-env-deploy ⇒ 补发 BgpExecEnvDeployStack"

sec "9) 执行环境注册表里 home 已 active"
# 🔴 键名是 `pk`/`sk`(值分别是 "env" / targetId)—— 别按语义猜成 `env`/`targetId`:
#   第一版就是这么猜的,get-item 静默回空 ⇒ 判据把「明明是 active」报成「没有这一行」(假红)。
HS=$(aws dynamodb get-item $P --table-name bgp-execution-envs \
       --key '{"pk":{"S":"env"},"sk":{"S":"tgt_home"}}' \
       --query 'Item.status.S' --output text 2>/dev/null || true)
[ "$HS" = "active" ] && ok "tgt_home = active" || bad "tgt_home 状态 = ${HS:-没有这一行}(应为 active)"

sec "10) S3 Tables 联邦目录 s3tablescatalog 在(没有它数据湖直查 / 问数一律 CATALOG_NOT_FOUND)"
# 🔴 不是 CDK 资源:由 deploy-all 6.3 / redeploy-platform 3c 开通。读不到与不存在这里都算不过(都得先修才可用)。
CAT=$(aws glue get-catalog $P --catalog-id s3tablescatalog --query 'Catalog.FederatedCatalog.ConnectionName' --output text 2>/dev/null || true)
[ "$CAT" = "aws:s3tables" ] && ok "s3tablescatalog 在(FederatedCatalog aws:s3tables)" \
  || bad "s3tablescatalog = ${CAT:-不存在 / 读不到} ⇒ 跑 scripts/redeploy-platform.sh(第 3c 步会对主控区与每个执行区开通)"

printf '\n\033[1;36m== 真就位结论 ==\033[0m\n'
if [ "$BAD" -gt 0 ]; then
  printf '\033[1;31m❌ %s 条不过 —— 平台装好了但不可用,先修这些\033[0m\n' "$BAD"; exit 1
fi
printf '\033[1;32m✅ 全部通过\033[0m —— 基础设施与接线真就位。\n'
printf '   🔴 但这**不等于**功能可用:页面级验收见 docs/DEPLOY-RUNBOOK.md §4bis / §4ter。\n'
exit 0
