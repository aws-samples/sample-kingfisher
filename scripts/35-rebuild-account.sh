#!/usr/bin/env bash
###############################################################################
# 35-rebuild-account.sh —— **一条命令**:换了临时账号之后,把整套东西重新拉起来并用**无头浏览器**验到位
#
#   ./scripts/35-rebuild-account.sh <profile> [home-region] [second-region] [选项]
#     --from <阶段>    从某个阶段开始(缺省 preflight);阶段名见下
#     --only <阶段>    只跑某一个阶段
#     --skip <a,b>     跳过这些阶段
#     --scale N        第二区造数玩家数(默认 20000 ≈ 63 万行)
#
#   阶段(顺序即依赖):
#     preflight   前置体检(8+4 项;硬失败就别开跑)          scripts/01-preflight-account.sh
#     deploy      全量部署(约 45–90 分钟)                    scripts/deploy-all.sh
#     truth       部署后「真就位」9 条真值查询                scripts/02-postdeploy-truth.sh
#     seed-home   主控区源库造数(游戏买量 7 表 ≈ 1200 万行)  scripts/22-seed-game.sh
#     add-region  **页面向导**在第二个 region 拉起执行环境     scripts/34-add-region-headless.py
#     seed-region 第二区就地造同构数据集                       scripts/23-seed-game-region.sh
#     showcase    每区七类能力真跑 + 长期保留的示范对象        scripts/32-verify-all-regions.sh
#     headless    🔴 无头浏览器逐区验收 + 三维矩阵             scripts/33-verify-regions-headless.py
#
# 🔴 为什么要有这一条命令(用户 2026-09-19 原话:「脚本也要沉淀保存,不能只是放到临时目录,
#   我们后面这样可以快速通过无头浏览器拉起来环境和快速进行无头浏览器验证」):
#   临时账号常常只能用 3 天。2026-09-19 这一轮的编排一开始散在 /tmp 的十几个一次性小脚本里 ——
#   账号一换就得从头手搓,而手搓的每一步都是新的出错机会。本脚本把**当天真的跑通的那个顺序**固化下来。
#
# 🔴 三条顺序纪律(都是真踩出来的,写死在这里):
#   ① `add-region` 之后必须**放行该 region** 才能「检测初始化」—— 平台 IAM 的 `aws:RequestedRegion`
#      是部署期静态写进策略的;放行清单由 `redeploy-platform.sh` 从注册表推导 ⇒ 必须在注册之后。
#      (34 号脚本自己会在构建完成后跑一次放行,这里不必额外做。)
#   ② 两套造数脚本的 schema 必须逐列一致;不一致会让第二个区的 ETL/编排/治理一起红,而根因离症状很远。
#   ③ `headless` 才是收尾判据:「接口通」不等于「页面上看得见、点得动」。
#
# 🔴 只写 `--profile` 指名的那个账号;账号号不进任何输出文件。
###############################################################################
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
cd "$ROOT"

PROFILE="${1:-temp-account}"; shift || true
REGION="us-east-1"; REGION2="us-west-2"
case "${1:-}" in ""|--*) ;; *) REGION="$1"; shift;; esac
case "${1:-}" in ""|--*) ;; *) REGION2="$1"; shift;; esac

ALL_STAGES="preflight deploy truth seed-home add-region seed-region showcase headless"
FROM=""; ONLY=""; SKIP=""; SCALE=20000
while [ $# -gt 0 ]; do
  case "$1" in
    --from) FROM="${2:?}"; shift 2;;
    --only) ONLY="${2:?}"; shift 2;;
    --skip) SKIP="${2:?}"; shift 2;;
    --scale) SCALE="${2:?}"; shift 2;;
    *) echo "未知选项:$1"; exit 2;;
  esac
done

# 🔴 生产上线批次 A:本脚本拉起的是**演示 / 验收**环境(造数 + 演示源库 + 测试账号都要)⇒ 显式 demo。
#   客户生产账号不要用本脚本,直接 BGP_DEPLOY_MODE=production ./scripts/deploy-all.sh。
export BGP_DEPLOY_MODE=demo
LOGDIR="/tmp/kf-rebuild-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$LOGDIR"
say()  { printf '\n\033[1;36m═══ %s ═══\033[0m\n' "$*"; }
info() { printf '   %s\n' "$*"; }
die()  { printf '\033[1;31m❌ %s\033[0m\n' "$*"; printf '   日志都在 %s\n' "$LOGDIR"; exit 1; }

want() {
  local s="$1"
  [ -n "$ONLY" ] && { [ "$ONLY" = "$s" ] && return 0 || return 1; }
  case ",$SKIP," in *",$s,"*) return 1;; esac
  if [ -n "$FROM" ]; then
    local seen=0
    for x in $ALL_STAGES; do
      [ "$x" = "$FROM" ] && seen=1
      [ "$x" = "$s" ] && { [ "$seen" = 1 ] && return 0 || return 1; }
    done
  fi
  return 0
}

# 阶段跑法统一:实时打屏 + 全量落日志 + 失败即中止(不让后面的阶段在坏地基上白跑)
stage() {
  local name="$1"; shift
  local log="$LOGDIR/$name.log"
  say "$name  →  $log"
  if "$@" 2>&1 | tee "$log"; then
    local rc=${PIPESTATUS[0]}
    [ "$rc" = 0 ] || die "阶段 $name 退出码 $rc(日志 $log)"
  else
    die "阶段 $name 起不来(日志 $log)"
  fi
  info "阶段 $name ✅"
}

ACCT_TAIL=$(aws sts get-caller-identity --profile "$PROFILE" --region "$REGION" --query Account --output text 2>/dev/null | tail -c 5)
[ -n "$ACCT_TAIL" ] || die "profile $PROFILE 拿不到身份(凭证过期?)"
printf '\033[1;36m账号 …%s · profile=%s · 主控区=%s · 第二区=%s\033[0m\n' "$ACCT_TAIL" "$PROFILE" "$REGION" "$REGION2"
printf '阶段:%s\n' "${ONLY:-${FROM:+从 $FROM 起}}${ONLY:+只跑 $ONLY}"
printf '日志目录:%s\n' "$LOGDIR"

# ── preflight ────────────────────────────────────────────────────────────────
if want preflight; then
  # 🔴 换账号后 infra/cdk.out 里常留着**上一个账号**的 asset 桶名,而第 2.5 步的自愈是 fail-closed
  #   ⇒ 提前清掉,省一轮 40 分钟(体检也会报这一项,这里顺手做掉)
  if [ -d infra/cdk.out ] && grep -ql "cdk-hnb659fds-assets-" infra/cdk.out/*.assets.json 2>/dev/null; then
    if grep -ho '"bucketName": *"[^"]*"' infra/cdk.out/*.assets.json 2>/dev/null | grep -qv -- "-$(aws sts get-caller-identity --profile "$PROFILE" --query Account --output text)-"; then
      info "infra/cdk.out 里有别的账号的 asset 桶 ⇒ 清掉(陈旧 synth 产物,可重建)"
      rm -rf infra/cdk.out
    fi
  fi
  stage preflight "$HERE/01-preflight-account.sh" "$PROFILE" "$REGION" "$REGION2"
fi

# ── deploy ───────────────────────────────────────────────────────────────────
want deploy && stage deploy "$HERE/deploy-all.sh" "$PROFILE" "$REGION"

# ── truth ────────────────────────────────────────────────────────────────────
want truth && stage truth "$HERE/02-postdeploy-truth.sh" "$PROFILE" "$REGION"

# 口令:第 11 步落盘的那份(验收层与造数层都从这里取,不靠「记得 export」)
PWFILE="${BGP_PW_FILE:-/tmp/bgp-cognito-pw-$PROFILE.json}"
if [ -f "$PWFILE" ]; then
  BGP_ADMIN_PASSWORD="$(python3 -c "import json;print(json.load(open('$PWFILE'))['admin'])" 2>/dev/null || true)"
  export BGP_ADMIN_PASSWORD
  export BGP_USER_PW_JSON="$(cat "$PWFILE")"
fi

# ── seed-home ────────────────────────────────────────────────────────────────
want seed-home && stage seed-home "$HERE/22-seed-game.sh" "$PROFILE" "$REGION"

# ── add-region(页面向导 + 放行 + 检测初始化 + 启用;幂等)────────────────────
want add-region && stage add-region python3 "$HERE/34-add-region-headless.py" \
  --profile "$PROFILE" --region "$REGION2" --home-region "$REGION"

# ── seed-region(该区就地造同构数据集)───────────────────────────────────────
if want seed-region; then
  TIDS=$(aws dynamodb scan --table-name bgp-execution-envs --profile "$PROFILE" --region "$REGION" \
          --query 'Items[?status.S==`active`].targetId.S' --output text 2>/dev/null | tr '\t' '\n' | grep -v '^tgt_home$' | grep -v '^$' || true)
  [ -n "$TIDS" ] || die "注册表里没有非 home 的 active 执行环境(add-region 没成?)"
  for T in $TIDS; do
    stage "seed-region-$T" "$HERE/23-seed-game-region.sh" "$PROFILE" "$T" "$SCALE"
  done
fi

# ── showcase(每区七类能力真跑 + 长期保留的示范对象)─────────────────────────
want showcase && stage showcase "$HERE/32-verify-all-regions.sh" "$PROFILE" "$REGION" --seed skip

# ── headless(🔴 收尾判据:只有页面级验证算数)───────────────────────────────
if want headless; then
  stage headless python3 "$HERE/33-verify-regions-headless.py" --profile "$PROFILE" \
    --home-region "$REGION" --run-engines --run-dispatch \
    --emit-matrix "$LOGDIR/capability-matrix.json" --shots qa-game/shots-headless
  info "三维矩阵:$LOGDIR/capability-matrix.json(Stop hook 判据 ⑥ 吃这张表)"
fi

say "全部阶段完成"
info "日志目录:$LOGDIR"
info "平台地址:$(aws cloudformation describe-stacks --profile "$PROFILE" --region "$REGION" --stack-name BgpPlatformStack \
      --query "Stacks[0].Outputs[?OutputKey=='PlatformUrl'].OutputValue" --output text 2>/dev/null)"
info "登录:admin / 口令在 $PWFILE(600 权限,不进仓)"
info "🔴 收官还要跑一次全量硬门:python3 qa-game/verify/verify_mr_all.py(本机专用,不入库)"
