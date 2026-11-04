#!/usr/bin/env bash
###############################################################################
# 32-verify-all-regions.sh —— **每个 region 一遍七类能力**的可复用验证入口(造数 → 真跑 → 收官表)。
#
#   ./scripts/32-verify-all-regions.sh <aws-profile> [home-region] [选项]
#     --stage create|run|all   建对象 / 只跑 / 全做(默认 all)
#     --only sync,etl,emr,workflow,gov,model,realtime,genbi   只跑其中几环(默认全跑)
#     --seed auto|force|skip   造数策略(默认 auto:该区湖里没有 gamedata 才造)
#     --scale N                非 home 区造数玩家数(默认 20000 ⇒ 约 70 万行)
#     --targets a,b            只做这几个 targetId(默认注册表里全部 active)
#
# 🔴 **为什么必须在仓里**(用户 2026-09-18:「一个临时账号只能管 3 天」):
#   换账号后要能一条命令把「多 region 全链路真跑一遍」重做出来。此前这层编排只存在于
#   /tmp 的一次性脚本里 —— 账号一换就得从头手搓,而手搓的每一步都是新的出错机会。
#
# 它做什么(每个活跃 target 各一遍):
#   ① 造数据:非 home 用 `23-seed-game-region.sh` 在**该区**就地生成(与主控区**同构**的 7 张表);
#      home 用 `22-seed-game.sh` 灌源库 MySQL(auto 模式下按 Glue 作业是否成功跑过判断)。
#   ② **九类**能力真跑:`31-showcase-region.py`(产品 API 建**长期保留**的 Showcase-* 对象并跑到成功;
#      2026-09-补上实时计算与智能问数 —— 此前它们在矩阵外 = 默认豁免):
#      数据源 → 同步 → 离线 ETL(Redshift SQL + Glue PySpark)→ 计算(EMR Serverless)
#      → 编排(发布 + 每日定时 + 触发一次)→ 数据治理(元数据镜像 + 质量规则评估)→ 数据建模(落地)。
#   ③ 汇总:每区一张能力 × 状态表,末尾打总表;**任一区有失败就整体非零退出**。
#
# 🔴 与 `qa-game/verify/*` 的分工:那些是无头验收(自造夹具、验完删净、本机不入库);
#   本脚本建的是**长期保留、用户切到那个区就能看见**的示范对象 —— 两者都要有,不能互相代替
#   (「判据全绿而用户看到空页面」这个坑已经踩过两次)。
#
# 🔴 只写 `--profile` 指名的那个账号;账号号不进任何输出文件。
###############################################################################
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
cd "$ROOT"

PROFILE="${1:-temp-account}"; shift || true
REGION="${1:-us-east-1}"; case "${1:-}" in --*) ;; *) shift || true;; esac

STAGE=all; ONLY=""; SEED=auto; SCALE=20000; ONLY_TARGETS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --stage) STAGE="${2:?}"; shift 2;;
    --only) ONLY="${2:?}"; shift 2;;
    --seed) SEED="${2:?}"; shift 2;;
    --scale) SCALE="${2:?}"; shift 2;;
    --targets) ONLY_TARGETS="${2:?}"; shift 2;;
    *) echo "未知选项:$1"; exit 2;;
  esac
done

info() { printf '\033[1;36m== %s ==\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m❌ %s\033[0m\n' "$*"; exit 1; }

command -v python3 >/dev/null || die "需要 python3"
python3 -c "import boto3" 2>/dev/null || die "需要 boto3(pip install boto3)"

ACCT_TAIL=$(aws sts get-caller-identity --profile "$PROFILE" --region "$REGION" --query Account --output text 2>/dev/null | tail -c 4)
[ -n "$ACCT_TAIL" ] || die "profile $PROFILE 拿不到身份(凭证过期?)"
info "账号 …$ACCT_TAIL · profile=$PROFILE · 主控区=$REGION · stage=$STAGE only=${ONLY:-全部} seed=$SEED"

# ── 活跃 target 清单(注册表是落点的唯一真值源,零硬编码)────────────────────
TARGETS_JSON=$(aws dynamodb scan --table-name bgp-execution-envs --profile "$PROFILE" --region "$REGION" --output json 2>/dev/null) \
  || die "读不到执行环境注册表 bgp-execution-envs(平台装了吗?)"
mapfile -t ROWS < <(printf '%s' "$TARGETS_JSON" | python3 -c '
import json, sys
d = json.load(sys.stdin)
for it in d.get("Items", []):
    g = lambda k: (it.get(k) or {}).get("S") or ""
    if not g("targetId") or not g("region"):
        continue
    if g("status") not in ("active", "ready", "in-service", "running", "legacy-seeded"):
        continue
    res = {k: list(v.values())[0] for k, v in (it.get("resources", {}).get("M") or {}).items() if "S" in v}
    print("\t".join([g("targetId"), g("region"), res.get("datalakeBucket", "")]))
')
[ "${#ROWS[@]}" -gt 0 ] || die "注册表里没有活跃的执行环境"

FAILED=(); GAPS=(); DONE=()
for row in "${ROWS[@]}"; do
  TID=$(printf '%s' "$row" | cut -f1); TREG=$(printf '%s' "$row" | cut -f2); LAKE=$(printf '%s' "$row" | cut -f3)
  if [ -n "$ONLY_TARGETS" ] && ! printf '%s' ",$ONLY_TARGETS," | grep -q ",$TID,"; then
    continue
  fi
  info "target $TID($TREG)"

  # ── ① 造数据 ────────────────────────────────────────────────────────────────
  if [ "$SEED" != "skip" ] && [ "$STAGE" != "create" ]; then
    if [ "$TID" = "tgt_home" ]; then
      # home 的源是 RDS MySQL:auto 模式按「造数 Glue 作业有没有成功跑过」判(CLI 读不到库里内容)
      need=1
      if [ "$SEED" = "auto" ]; then
        st=$(aws glue get-job-runs --job-name bgp-game-seed --profile "$PROFILE" --region "$TREG" \
              --query 'JobRuns[0].JobRunState' --output text 2>/dev/null || echo NONE)
        [ "$st" = "SUCCEEDED" ] && need=0 && echo "  · 源库已灌过(bgp-game-seed 上次 SUCCEEDED)⇒ 跳过造数"
      fi
      if [ "$need" = 1 ]; then
        echo "  · 灌源库 MySQL(22-seed-game.sh)"
        bash "$HERE/22-seed-game.sh" "$PROFILE" "$TREG" || { FAILED+=("$TID:seed-home"); warn "$TID 造数失败,仍继续跑后面的区"; }
      fi
    else
      need=1
      if [ "$SEED" = "auto" ] && [ -n "$LAKE" ]; then
        n=$(aws s3 ls "s3://$LAKE/gamedata/ad_channels/" --profile "$PROFILE" --region "$TREG" 2>/dev/null | wc -l)
        [ "$n" -gt 0 ] && need=0 && echo "  · 该区湖里已有 gamedata(ad_channels $n 个对象)⇒ 跳过造数"
      fi
      if [ "$need" = 1 ]; then
        echo "  · 在该区就地造数(23-seed-game-region.sh,scale=$SCALE)"
        bash "$HERE/23-seed-game-region.sh" "$PROFILE" "$TID" "$SCALE" "$TREG" \
          || { FAILED+=("$TID:seed-region"); warn "$TID 造数失败,仍继续跑后面的区"; }
      fi
    fi
  fi

  # ── ② 七类能力真跑 + 收官表 ────────────────────────────────────────────────
  LOG="/tmp/verify-all-regions-$TID.log"
  args=(--profile "$PROFILE" --target "$TID" --stage "$STAGE" --home-region "$REGION")
  [ -n "$ONLY" ] && args+=(--only "$ONLY")
  python3 "$HERE/31-showcase-region.py" "${args[@]}" 2>&1 | tee "$LOG"
  rc=${PIPESTATUS[0]}
  DONE+=("$TID")
  # 收官表里的 ⚠️ 合同缺口不算失败(如实登记,见 31 脚本的 Ledger)
  # 🔴 `grep -c` 无命中时**已经会打印 0 并回非零**;再 `|| echo 0` 就产出两行 ⇒ `[ "$g" -gt 0 ]` 当场报
  #    "integer expression expected"(首跑实测)。取值一律 `|| true` + 兜默认,别叠加一次输出。
  g=$(grep -c '⚠️ 合同缺口' "$LOG" 2>/dev/null || true); g=${g:-0}
  [ "$g" -gt 0 ] 2>/dev/null && GAPS+=("$TID:$g")
  [ "$rc" -ne 0 ] && FAILED+=("$TID:capabilities")
done

echo
info "总表(每区一遍七类能力)"
for t in "${DONE[@]}"; do
  printf '  %-14s %s\n' "$t" "$(grep -E '^(✅|❌) tgt' "/tmp/verify-all-regions-$t.log" 2>/dev/null | tail -1)"
done
[ "${#GAPS[@]}" -gt 0 ] && warn "合同缺口(如实登记,非失败):${GAPS[*]}"
if [ "${#FAILED[@]}" -gt 0 ]; then
  die "有区没跑通:${FAILED[*]}(逐区日志 /tmp/verify-all-regions-<targetId>.log)"
fi
info "✅ 全部区域七类能力跑通(合同缺口见上)。示范对象**长期保留**,切到对应执行范围即可见。"
