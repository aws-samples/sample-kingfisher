#!/usr/bin/env bash
###############################################################################
# 01-preflight-account.sh —— **换账号后开跑 deploy-all 之前**的一次性体检(可复用)
#
#   ./scripts/01-preflight-account.sh <aws-profile> [home-region] [second-region]
#
# 🔴 为什么必须有(docs/DEPLOY-RUNBOOK.md §0 的教训):2026-08-29 在一个共用账号上部署,
#   `deploy-all` 跑到**第 40 分钟**才撞墙,而两个失败点都是 30 秒能提前查出来的。
#   临时账号的权限**每个都裁得不一样**,所以换账号必须重跑体检,不能凭上次经验开跑。
#   这份手册以前只是**手册里的一串命令** —— 也就是每换一次账号就得人肉敲一遍(而人肉会漏)。
#
# 判据分两级:
#   ❌ 硬失败 = 不修就别开跑(整个部署没戏 / 必在半路炸)⇒ 非零退出
#   ⚠️ 软提示 = 能开跑但要知道边界(比如第三个 region 被组织策略拦 ⇒ 某些段注定只能登记)
#
# 🔴 只读 / 可逆:所有写探测都当场撤销(建角色即删、建桶即删、建 user pool 即删)。
# 🔴 只碰 `--profile` 指名的那个账号;账号号不进任何文件(只打尾 4 位)。
###############################################################################
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

PROFILE="${1:-temp-account}"
REGION="${2:-us-east-1}"
REGION2="${3:-us-west-2}"
# 域外对照区:用来判「第三个 region 到底能不能用」(段 w5a 需要它)
REGION3="${KF_T3_REGION:-eu-west-1}"
P="--profile $PROFILE"

HARD=0; SOFT=0
ok()   { printf '  \033[1;32m✅\033[0m %s\n' "$*"; }
bad()  { printf '  \033[1;31m❌\033[0m %s\n' "$*"; HARD=$((HARD+1)); }
soft() { printf '  \033[1;33m⚠️\033[0m %s\n' "$*"; SOFT=$((SOFT+1)); }
sec()  { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }

sec "0) 身份(🔴 必须是你被授权写的那个 profile —— 凭证存在 ≠ 有授权)"
IDENT=$(aws sts get-caller-identity $P --region "$REGION" --output json 2>&1) || true
ACCT=$(printf '%s' "$IDENT" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("Account",""))' 2>/dev/null || true)
if [ -z "$ACCT" ]; then
  bad "拿不到身份(凭证过期?):$(printf '%s' "$IDENT" | head -c 200)"
  printf '\n\033[1;31m体检中止:先刷新 %s 的凭证\033[0m\n' "$PROFILE"; exit 1
fi
ok "profile=$PROFILE 账号=…${ACCT: -4} 主控区=$REGION 第二区=$REGION2"
# ARN 里带账号号 ⇒ 打印前替换成尾 4 位(账号号不进任何输出)
printf '     ARN: %s\n' "$(printf '%s' "$IDENT" \
  | python3 -c 'import json,sys;print(json.load(sys.stdin).get("Arn",""))' 2>/dev/null \
  | sed "s/$ACCT/…${ACCT: -4}/g")"

sec "1) 目标 region 里有没有别人的负载(往别人的 workshop region 里塞资源会撞配额、也给对方造 drift)"
for R in "$REGION" "$REGION2"; do
  ST=$(aws cloudformation list-stacks $P --region "$R" --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE CREATE_IN_PROGRESS \
        --query 'StackSummaries[].StackName' --output text 2>/dev/null | tr '\t' '\n' | grep -v '^$' || true)
  N=$(printf '%s' "$ST" | grep -c . || true); NB=$(printf '%s' "$ST" | grep -vc '^Bgp\|^CDKToolkit' || true)
  if [ "${NB:-0}" -gt 0 ]; then
    soft "$R 有 ${NB} 个**非本平台**的栈(别人的负载?):$(printf '%s' "$ST" | grep -v '^Bgp\|^CDKToolkit' | head -5 | tr '\n' ' ')"
  else
    ok "$R 干净(${N:-0} 个栈,全是本平台 / CDKToolkit)"
  fi
done

sec "2) VPC 配额(region 级默认上限 5;满了第一步就 VpcLimitExceeded)"
for R in "$REGION" "$REGION2"; do
  N=$(aws ec2 describe-vpcs $P --region "$R" --query 'length(Vpcs)' --output text 2>/dev/null || echo "?")
  if [ "$N" = "?" ]; then bad "$R describe-vpcs 失败"
  elif [ "$N" -ge 5 ]; then bad "$R VPC $N/5 已满 ⇒ 走 RUNBOOK §2 导入现有 VPC(EXISTING_VPC_ID=…)"
  else ok "$R VPC $N/5"; fi
done

sec "3) EIP 用量(主控区控制面 VPC 的 2 个 NAT 网关各占 1 个 EIP;执行环境零出网不占 EIP;临时账号常见上限 5/区)"
for R in "$REGION" "$REGION2"; do
  N=$(aws ec2 describe-addresses $P --region "$R" --query 'length(Addresses)' --output text 2>/dev/null || true)
  case "$N" in
    ''|*[!0-9]*) soft "$R describe-addresses 读不到数(权限?)";;
    *) if [ "$N" -ge 4 ]; then soft "$R EIP 已占 $N/5 —— 若这是主控区,装控制面 VPC(2 个 NAT)可能撞配额(负向夹具要先腾)"
       else ok "$R EIP 已占 $N"; fi;;
  esac
done

sec "4) IAM 建角色(平台要建几十个角色;⚠️ 探测的 --description 不许写中文,IAM 该字段只收 Latin)"
RN="bgp-preflight-probe-$(date +%s)"
if aws iam create-role $P --role-name "$RN" --description "preflight probe" \
     --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
     >/dev/null 2>&1; then
  aws iam delete-role $P --role-name "$RN" >/dev/null 2>&1 && ok "可建角色(已删除探针角色)" || soft "角色建出来了但删不掉:$RN(手工清)"
else
  bad "不能建 IAM 角色 ⇒ 整个部署没戏"
fi

sec "5) 🔴 Cognito 管理写(最常被裁、而且失败得最晚 —— 在第 11 步)"
PID=$(aws cognito-idp create-user-pool $P --region "$REGION" --pool-name "bgp-preflight-$(date +%s)" \
        --query 'UserPool.Id' --output text 2>/dev/null || true)
if [ -z "$PID" ] || [ "$PID" = "None" ]; then
  bad "连 CreateUserPool 都不行 ⇒ 见 RUNBOOK §3(引导 Lambda 路径 B)"
else
  FAIL=""
  aws cognito-idp create-group $P --region "$REGION" --user-pool-id "$PID" --group-name probe >/dev/null 2>&1 || FAIL="$FAIL CreateGroup"
  aws cognito-idp admin-create-user $P --region "$REGION" --user-pool-id "$PID" --username probe --message-action SUPPRESS >/dev/null 2>&1 || FAIL="$FAIL AdminCreateUser"
  aws cognito-idp admin-set-user-password $P --region "$REGION" --user-pool-id "$PID" --username probe --password "Pf-$(date +%s)Aa!" --permanent >/dev/null 2>&1 || FAIL="$FAIL AdminSetUserPassword"
  aws cognito-idp admin-add-user-to-group $P --region "$REGION" --user-pool-id "$PID" --username probe --group-name probe >/dev/null 2>&1 || FAIL="$FAIL AdminAddUserToGroup"
  aws cognito-idp delete-user-pool $P --region "$REGION" --user-pool-id "$PID" >/dev/null 2>&1 || soft "探针 user pool 没删掉:$PID(手工清)"
  if [ -n "$FAIL" ]; then
    soft "Cognito 管理写被裁:$FAIL ⇒ 第 11 步会走 RUNBOOK §3 的引导 Lambda(路径 B);它**不会**中止部署"
  else
    ok "Cognito 五个管理动作全放行(路径 A 直连,行为与从前一致)"
  fi
fi

sec "6) 🔴 cdk.out 里有没有**别的账号**的 asset 桶名(2026-09-19 真踩到)"
# 为什么单列一条:asset 自愈会读 `cdk.out/*.assets.json` 的 bucketName。换账号后那里还留着上一个
# 账号的桶名,自愈的 fail-closed 护栏会当场拒绝并要求删 cdk.out —— 提前查掉,省一轮 40 分钟。
if [ -d "$ROOT/infra/cdk.out" ]; then
  FOREIGN=$(grep -ho '"bucketName": *"[^"]*"' "$ROOT"/infra/cdk.out/*.assets.json 2>/dev/null \
            | sed 's/.*"\(cdk-[^"]*\)".*/\1/' | sort -u | grep -v -- "-$ACCT-" || true)
  if [ -n "$FOREIGN" ]; then
    bad "infra/cdk.out 里有别的账号的 asset 桶(自愈会 fail-closed 拒绝)⇒ 先 rm -rf infra/cdk.out;涉及 $(printf '%s\n' "$FOREIGN" | grep -c .) 个($(printf '%s' "$FOREIGN" | tr '\n' ' ' | sed -E 's/([0-9]{3})[0-9]{5}([0-9]{4})/\1…\2/g'))"
  else
    ok "infra/cdk.out 的 asset 桶都属于本账号"
  fi
else
  ok "infra/cdk.out 不存在(干净起跑)"
fi

sec "7) Bedrock:🔴 列表里 ACTIVE 不算可用,必须**真 converse** 一次(候选链逐个试,任一通过即可)"
# @kf-batch 51-v2-multi-vendor(模块 51 v2.0,51 SPEC §7.7)—— 不再只探出厂默认一个:交给 resolve-home-model.sh 按
#   platform/ai-model.json 的 candidateModelIds(Claude Opus → GLM 5.3 → Kimi K3)逐候选展开本区推理配置并真 converse,
#   与 deploy-all 选型用的是**同一段逻辑**(这里只读、不写任何资源)。
CANDS=$(python3 -c "import json;c=json.load(open('$ROOT/platform/ai-model.json'));print(' / '.join(c.get('candidateModelIds') or [c['defaultModelId']]))" 2>/dev/null || true)
if [ -z "$CANDS" ]; then
  bad "读不到 platform/ai-model.json 的 defaultModelId / candidateModelIds"
else
  RES_ERR=$(mktemp)
  if MODEL=$(bash "$HERE/resolve-home-model.sh" "$PROFILE" "$REGION" 2>"$RES_ERR"); then
    ok "候选链($CANDS)里真 converse 通过的第一个:$MODEL(部署时会注入 BEDROCK_MODEL_ID)"
  else
    bad "候选链($CANDS)在 $REGION **一个都不可用**:$(tr '\n' ' ' <"$RES_ERR" | head -c 700)
       ⇒ 9 个 AI 消费点会集体哑火。先在该区开通模型访问;或部署后在 /settings「AI 模型」卡热配(秒级生效)"
  fi
  rm -f "$RES_ERR"
fi

sec "8) CDK bootstrap / docker / 依赖"
V=$(aws ssm get-parameter $P --region "$REGION" --name /cdk-bootstrap/hnb659fds/version --query 'Parameter.Value' --output text 2>/dev/null || true)
[ -n "$V" ] && ok "CDK bootstrap 版本 $V" || ok "未 bootstrap(deploy-all 第 2 步会做)"
docker version --format '{{.Server.Version}}' >/dev/null 2>&1 && ok "docker 可用($(docker version --format '{{.Server.Version}}' 2>/dev/null))" || bad "docker 不可用(ECS 镜像 + 3 个 AgentCore 镜像都在本地构建)"
docker buildx version >/dev/null 2>&1 && ok "buildx 可用" || bad "buildx 不可用"
for D in infra platform; do
  [ -d "$ROOT/$D/node_modules" ] && ok "$D/node_modules 在" || bad "$D 缺依赖 ⇒ 先 (cd $D && npm ci),否则 CDK synth 直接 TSError"
done

sec "9) 🔴 region 放行面(只读探测不可信 —— 用**可逆的真写**量:建桶即删)"
# 「被拒」≠「这条路被禁」:要逐个 region 量。第三个 region 通不通决定段 w5a 是真跑还是只能登记。
for R in "$REGION" "$REGION2" "$REGION3"; do
  B="bgp-scp-probe-$(date +%s)-$R"
  if [ "$R" = "us-east-1" ]; then CBC=(); else CBC=(--create-bucket-configuration "LocationConstraint=$R"); fi
  if aws s3api create-bucket $P --bucket "$B" --region "$R" "${CBC[@]}" >/dev/null 2>/tmp/kf-scp-$R.err; then
    aws s3api delete-bucket $P --bucket "$B" --region "$R" >/dev/null 2>&1
    ok "$R 可写(探针桶已删)"
  else
    # AWS 的报错文本里会带完整账号号(「User: arn:aws:sts::<账号>:assumed-role/…」)⇒ 一律脱敏成尾 4 位
    MSG=$(head -c 200 "/tmp/kf-scp-$R.err" | tr -d '\n' | sed "s/$ACCT/…${ACCT: -4}/g")
    if [ "$R" = "$REGION3" ]; then
      soft "$R 被拒(组织策略?)⇒ 第三个 region 这轮做不出来,段 w5a 只能**如实登记成环境限制**:$MSG"
    else
      bad "$R 被拒 —— 这是要用的区!:$MSG"
    fi
  fi
done

printf '\n\033[1;36m== 体检结论 ==\033[0m\n'
if [ "$HARD" -gt 0 ]; then
  printf '\033[1;31m❌ 硬失败 %s 项 · ⚠️ 软提示 %s 项 —— 修完硬失败再开跑\033[0m\n' "$HARD" "$SOFT"
  exit 1
fi
printf '\033[1;32m✅ 硬项全过\033[0m · ⚠️ 软提示 %s 项(边界已知)\n' "$SOFT"
printf '   下一步:BGP_DEPLOY_MODE=production ./scripts/deploy-all.sh %s %s   (约 60–90 分钟)\n' "$PROFILE" "$REGION"
printf '          模式必填且定下后不许换:production = 客户生产(不造数、只建 admin);demo = 演示 / 验收环境(演示数据 + 测试账号)\n'
printf '   再下一步:docs/DEPLOY-RUNBOOK.md §4bis「换账号后把多 region 全链路重做出来」\n'
exit 0
