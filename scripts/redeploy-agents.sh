#!/usr/bin/env bash
###############################################################################
# redeploy-agents.sh —— 升级 / 刷新三个 AgentCore 智能体(问数 genbi · 网络顾问 netadvisor · 参数顾问 paramadvisor)
#   的【唯一入口】:重新编译 core-dist → 构建并推送三个 ARM64 镜像(tag = 当前 git 短哈希)→ 逐个部署智能体栈,
#   让 Runtime 指向新镜像。= deploy-all.sh 第 4 / 5 步(同一份映射表与函数 scripts/lib/agentcore-agents.sh),
#   抽出来单独可跑。
#
#   ./scripts/redeploy-agents.sh <aws-profile> <主控区> [--check] [--only genbi,netadvisor]
#     --check   只读:打印每个智能体现网 Runtime 正在用的镜像 tag、本机 HEAD 短哈希、两者之间智能体相关源码有没有差;
#               不改任何东西(升级前先跑它,就知道这一版要不要刷智能体)
#     --only    只刷新列出的智能体(缺省三个全刷;镜像构建幂等,全刷最稳)
#
# 🔴 为什么存在:`redeploy-platform.sh` 只部署 ExecEnvDeploy / AirflowServerless / Waf / OmService /
#   Platform 五个栈,**不重建智能体镜像、不部署智能体栈**;而智能体容器里带着 platform/src/lib/<cap>/core 与
#   lib/cookbook 编译出的 core-dist(问数的脚本生成配方就在里面)。10-12 → 10-13 升级后问数智能体仍跑旧配方,
#   就是这么漏的。以后升级 = redeploy-platform.sh(平台)+ 本脚本(智能体),两个都跑;`--check` 告诉你要不要跑。
#
# 🔴 Runtime ARN 与 Memory id **不随镜像变**(栈更新的只是 Runtime 的 ContainerUri)⇒ 平台接线(SSM /bgp/wiring/*、
#   容器 env)不用动,本脚本**不**重部署平台栈;平台代码有变照旧另跑 redeploy-platform.sh。
# 🔴 暖容器按会话复用:正在进行的问数会话可能还在旧容器上跑几分钟;新会话才一定用新镜像。
# 🔴 两个位置参数**都必须写**(本脚本不给静默缺省:漏传就停);只写 --profile 指名的账号;账号号不进任何输出文件。
# 需要:git(有 .git,镜像 tag 用 git 短哈希,ZIP 导出包不行)、Docker + buildx、Node 20 + CDK CLI、AWS CLI v2,
#   以及 infra/ 与 platform/ 各 `npm ci` 过一次(core-prebuild 要 tsc,cdk 要 infra 依赖)。
###############################################################################
set -euo pipefail

usage() {
  printf '用法:bash %s <aws-profile> <主控区> [--check] [--only genbi,netadvisor,paramadvisor]\n' "$0"
  printf '例:  bash %s <profile> us-east-1 --check\n' "$0"
}
# 🔴 不许把旗标当成 profile 名(与 redeploy-platform.sh 同一条教训:`--profile x` 会被当成 PROFILE="--profile")。
if [[ "${1:-}" == -* ]]; then
  printf '\033[1;31m✗ 用法错误:本脚本收**位置参数**,不是旗标\033[0m\n'; usage; exit 2
fi
PROFILE="${1:-}"; REGION="${2:-}"
if [ -z "$PROFILE" ] || [ -z "$REGION" ]; then
  printf '\033[1;31m✗ 必须显式给 <aws-profile> 与 <主控区> 两个参数(本脚本不提供静默缺省)\033[0m\n'; usage; exit 2
fi
shift 2
CHECK=0; ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=1; shift;;
    --only)  ONLY="${2:?--only 后面要跟智能体名,逗号分隔}"; shift 2;;
    --help|-h) usage; exit 0;;
    *) printf '✗ 未知选项:%s\n' "$1"; usage; exit 2;;
  esac
done

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
# 与 deploy-all / redeploy-platform 同一套环境对齐:AWS_PROFILE 供 app.ts 的 SSM 读取继承;
# AWS_REGION / AWS_DEFAULT_REGION 会覆盖 CDK_DEFAULT_REGION ⇒ 一起对齐;KF_HOME_REGION 交给 app.ts 做 synth 期比对。
export AWS_PROFILE="$PROFILE"
export CDK_DEFAULT_REGION="$REGION" AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION" KF_HOME_REGION="$REGION"

info() { printf '   %s\n' "$*"; }
say()  { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
warn() { printf '   \033[1;33m⚠️ %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }
out()  { aws cloudformation describe-stacks --stack-name "$1" --profile "$PROFILE" --region "$REGION" \
           --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text 2>/dev/null; }
# shellcheck source=lib/agentcore-agents.sh
source "$HERE/lib/agentcore-agents.sh"
source "$HERE/lib/execution-regions.sh"  # 放行清单的唯一作者(网络 / 参数顾问的技能角色也有区域条件,见第 3 步)

# 部署模式:与 redeploy-platform.sh 同一条规则 —— 从 SSM /bgp/deploy-mode 读;显式给了且与 SSM 不同 ⇒ 拒。
# 本脚本只读不写 SSM(模式的作者是 deploy-all / redeploy-platform)。synth 整个 app 时 app.ts 要知道模式(决定演示源库栈在不在)。
SSM_MODE=$(aws ssm get-parameter --name /bgp/deploy-mode --query Parameter.Value --output text \
             --profile "$PROFILE" --region "$REGION" 2>/dev/null || true)
[ "$SSM_MODE" = "None" ] && SSM_MODE=""
if [ -n "${BGP_DEPLOY_MODE:-}" ] && [ -n "$SSM_MODE" ] && [ "$BGP_DEPLOY_MODE" != "$SSM_MODE" ]; then
  die "本环境部署模式是 $SSM_MODE(SSM /bgp/deploy-mode),这次给的是 $BGP_DEPLOY_MODE —— 拒绝中途换模式"
fi
export BGP_DEPLOY_MODE="${BGP_DEPLOY_MODE:-${SSM_MODE:-production}}"
case "$BGP_DEPLOY_MODE" in production|demo) ;; *) die "BGP_DEPLOY_MODE 非法:$BGP_DEPLOY_MODE" ;; esac

# 选哪些智能体
declare -a SEL=("${AGENTS[@]}")
if [ -n "$ONLY" ]; then
  IFS=, read -r -a SEL <<<"$ONLY"
  for a in "${SEL[@]}"; do [ -n "${A_STACK[$a]:-}" ] || die "未知智能体:$a(可选:${AGENTS[*]})"; done
fi

say "0) 前置:工具 · 依赖 · 版本"
for t in git aws docker npx; do command -v "$t" >/dev/null 2>&1 || die "缺少工具:$t"; done
# 🔴 先核凭证本身:否则后面每一步「读不到」都会被误诊成「栈没建 / 无权限」(三态要分开:凭证坏 ≠ 对象不在 ≠ 无权)。
ACCT_TAIL=$(aws sts get-caller-identity --profile "$PROFILE" --region "$REGION" --query Account --output text 2>/dev/null | tail -c 5) \
  || true
[ -n "$ACCT_TAIL" ] || die "profile $PROFILE 的凭证不可用(sts get-caller-identity 失败):过期 / 配错 / 没这个 profile;本脚本不往下猜"
HEAD_TAG=$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null) \
  || die "$ROOT 不是 git 仓库(没有 .git):镜像 tag 用 git 短哈希,不能用 ZIP 导出包;请 git clone 并 checkout 发版 tag"
info "本机 HEAD = $HEAD_TAG($(git -C "$ROOT" describe --tags --exact-match 2>/dev/null || echo '不在任何 tag 上'))· 账号 …$ACCT_TAIL(--profile $PROFILE)· 主控区 $REGION · 模式 $BGP_DEPLOY_MODE"
if [ "$CHECK" -eq 0 ]; then
  [ -d "$ROOT/infra/node_modules" ]    || die "infra/ 没装依赖:先 (cd infra && npm ci)"
  [ -d "$ROOT/platform/node_modules" ] || die "platform/ 没装依赖:先 (cd platform && npm ci)(core-prebuild 要用它的 tsc)"
  docker buildx version >/dev/null 2>&1 || die "Docker buildx 不可用(AgentCore 要 arm64 镜像,需要 buildx)"
  DIRTY=$(git -C "$ROOT" status --porcelain -- "${AGENT_SOURCE_PATHS[@]}")
  [ -z "$DIRTY" ] || die "智能体相关源码有未提交改动,git 短哈希 $HEAD_TAG 代表不了镜像内容;先提交:"$'\n'"$DIRTY"
fi

say "0b) 现网智能体版本(只读)"
NEED=0; UNKNOWN=0
for a in "${SEL[@]}"; do
  CUR=$(agentcore_deployed_tag "$a" || true)
  if [ -z "$CUR" ]; then
    warn "$a:读不到现网 Runtime 的镜像 tag(${A_STACK[$a]} 还没建 Runtime,或这个身份没有 bedrock-agentcore:GetAgentRuntime 权限)—— 「读不到」≠「一致」"
    UNKNOWN=$((UNKNOWN+1)); continue
  fi
  if [ "$CUR" = "$HEAD_TAG" ]; then
    info "$a:现网 tag $CUR == 本机 HEAD ✓"
  elif git -C "$ROOT" cat-file -e "$CUR^{commit}" 2>/dev/null; then
    N=$(git -C "$ROOT" diff --name-only "$CUR" HEAD -- "${AGENT_SOURCE_PATHS[@]}" | wc -l | tr -d ' ')
    if [ "$N" -gt 0 ]; then
      info "$a:现网 tag $CUR ≠ HEAD $HEAD_TAG,两版之间智能体相关源码有 $N 个文件不同 ⇒ 需要刷新"
      NEED=$((NEED+1))
    else
      info "$a:现网 tag $CUR ≠ HEAD $HEAD_TAG,但两版之间智能体相关源码无差(只是提交号变了)"
    fi
  else
    info "$a:现网 tag $CUR ≠ HEAD $HEAD_TAG(本机没有提交 $CUR,算不出差异 ⇒ 按需要刷新处理)"
    NEED=$((NEED+1))
  fi
done
if [ "$CHECK" -eq 1 ]; then
  echo
  if [ "$NEED" -gt 0 ]; then
    printf '   结论:%d 个智能体需要刷新 ⇒ 跑 bash %s %s %s\n' "$NEED" "$0" "$PROFILE" "$REGION"
  elif [ "$UNKNOWN" -gt 0 ]; then
    printf '   结论:%d 个智能体现网版本读不到,无法判定;要确定就直接刷一遍(幂等)\n' "$UNKNOWN"
  else
    printf '   结论:智能体与本机 HEAD 一致,这一版不用刷\n'
  fi
  exit 0
fi

say "1) 重新编译 core-dist(platform/src/lib/<cap>/core · lib/cookbook → infra/agent/*/core-dist)"
bash "$HERE/core-prebuild.sh" all
DRIFT=$(git -C "$ROOT" status --porcelain -- infra/agent)
if [ -n "$DRIFT" ]; then
  warn "core-dist 与 TS 源不同步,已就地重生成(deploy-all 也是这样做的);镜像用的是重生成后的内容,请把这些改动提交,否则下次按 tag 取码的人拿到的是旧 core-dist:"
  printf '%s\n' "$DRIFT" | sed 's/^/      /'
fi

say "2) 构建并推送镜像(tag $HEAD_TAG,linux/arm64)"
agentcore_build_push_images "$HEAD_TAG" "${SEL[@]}"

say "3) 部署智能体栈(Runtime → 新镜像;cdk 逐个)"
# 网络顾问 / 参数顾问的技能 Lambda 角色带 `aws:RequestedRegion` 条件(infra/lib/netadvisor-iam.ts / paramadvisor-iam.ts),
#   此前首装与本脚本都没把放行清单交给这两个栈 ⇒ 它们始终只放行主控区(数据源在别的区时顾问探不到)。
#   现在与平台栈同一份清单(home ∪ 注册表在用区 ∪ 候选区),经环境变量交给 cdk(requestedRegionCondition 的第二条通道)。
EXEC_REGIONS=$(exec_regions_resolve)
info "execution-regions = $EXEC_REGIONS(与 redeploy-platform.sh 第 1b 步同一作者)"
export BGP_EXECUTION_REGIONS="$EXEC_REGIONS"
agentcore_deploy_runtimes "$HEAD_TAG" "${SEL[@]}"

say "4) 核对现网(只读)"
BAD=0
for a in "${SEL[@]}"; do
  CUR=$(agentcore_deployed_tag "$a" || true)
  if [ -z "$CUR" ]; then
    warn "$a:栈部署成功,但读不到 Runtime 的镜像 tag(身份无 bedrock-agentcore:GetAgentRuntime?)—— 没看到不等于对"
  elif [ "$CUR" = "$HEAD_TAG" ]; then
    info "$a:Runtime 镜像 tag = $CUR ✓"
  else
    printf '   \033[1;31m✗ %s:栈部署成功但 Runtime 仍指 %s(期望 %s)\033[0m\n' "$a" "$CUR" "$HEAD_TAG"; BAD=$((BAD+1))
  fi
done
[ "$BAD" -eq 0 ] || die "$BAD 个智能体的 Runtime 没切到新镜像"

echo
info "完成:智能体镜像 tag = $HEAD_TAG。Runtime ARN / Memory id 不变 ⇒ 平台接线无需改动。"
info "平台代码也有变的话,另跑 BGP_DEPLOY_MODE=$BGP_DEPLOY_MODE bash $HERE/redeploy-platform.sh $PROFILE $REGION"
info "进行中的问数会话可能还在旧容器上(暖容器按会话复用);新会话一定用新镜像。"
