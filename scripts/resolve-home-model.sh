#!/usr/bin/env bash
###############################################################################
# resolve-home-model.sh —— 按**账号真值**为主控区选出能用的默认大模型 id(打印到 stdout)
#
#   MODEL=$(bash scripts/resolve-home-model.sh <profile> <home-region>) || exit 1
#
# @kf-batch 50-PROD-A-launch-hardening(h)
# 🔴 为什么:出厂默认(platform/ai-model.json)是 `us.anthropic.…` —— **美国**跨区推理配置,
#   只能从美国的区调用。客户把主控区选在欧洲 / 亚太 ⇒ 平台 9 个 AI 能力全部哑火(部署却是绿的)。
# @kf-batch 51-v2-multi-vendor(模块 51 v2.0,51 SPEC §7.7)
# 🔴 候选链:ai-model.json 的 `candidateModelIds`(有序;老 json 没有该字段 ⇒ [defaultModelId])。一个候选在本账号 /
#   本区不可用(账号级未开放 / 未订阅 / 该区没有)就试下一个 —— 2026-10-14 临时账号实测 GLM 5.3 整个账号被拒
#   (「not available for this account」)而 Kimi K3 能用;链上哪个先通就用哪个,**不许带着不能用的模型上线**。
#   env BGP_MODEL_CANDIDATES(空格分隔)可显式覆盖候选链 —— 只用于排障 / 测试,stderr 会打出「候选来自 env」。
# 做法(不猜、不写厂商正则):
#   ① 列**主控区**的推理配置(list-inference-profiles)一次;
#   ② 对每个候选:它本身是推理配置 id ⇒ 基础模型 = 该配置 models[].modelArn 的末段;否则候选就是基础模型 id
#      (**真值匹配**,不靠正则猜地理前缀 / 厂商段);
#      展开顺序:候选本身(若是配置 id)→ 指向该基础模型的本区地理配置(us. / eu. / apac. / jp. …)→ global. → 基础模型本身;
#   ③ 逐个**真 converse 一次**(maxTokens=16 —— Kimi K3 的下限,给 1 会被拒成「不可用」;成本可忽略),第一个成功的就是答案(不是候选原文时 stderr 会说明映射);
#   ④ 全链一个都不成 ⇒ 退出非零并逐条列出「候选 → 展开 id —— 失败原话」。
# 只读 + 若干次极小的推理调用;不写任何资源。
###############################################################################
set -euo pipefail
PROFILE="${1:?用法:resolve-home-model.sh <profile> <home-region>}"
REGION="${2:?用法:resolve-home-model.sh <profile> <home-region>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
JSON="$HERE/../platform/ai-model.json"

if [ -n "${BGP_MODEL_CANDIDATES:-}" ]; then
  CANDIDATES="$BGP_MODEL_CANDIDATES"
  echo "⚠️ 候选来自 env BGP_MODEL_CANDIDATES(仅排障 / 测试):$CANDIDATES" >&2
else
  CANDIDATES=$(python3 -c '
import json, sys
cfg = json.load(open(sys.argv[1]))
print(" ".join(cfg.get("candidateModelIds") or [cfg["defaultModelId"]]))' "$JSON")
fi

LIST_ERR=""
ERRF=$(mktemp)
if ! PROFILES_JSON=$(aws bedrock list-inference-profiles --profile "$PROFILE" --region "$REGION" --output json 2>"$ERRF"); then
  LIST_ERR=$(tail -1 "$ERRF" | cut -c1-200); PROFILES_JSON='{}'
fi
rm -f "$ERRF"

TRIED=""
for C in $CANDIDATES; do
  EXPANDED=$(CAND="$C" PROFILES_JSON="$PROFILES_JSON" python3 - <<'PY'
import json, os, re
cand = os.environ["CAND"]
rows = (json.loads(os.environ["PROFILES_JSON"] or "{}").get("inferenceProfileSummaries") or [])
def base_of(row):
    arn = ((row.get("models") or [{}])[0].get("modelArn") or "")
    return arn.rsplit("/", 1)[-1] if "/" in arn else ""
by_id = {(r.get("inferenceProfileId") or ""): r for r in rows}
bases = {b for b in (base_of(r) for r in rows) if b}
if cand in by_id and base_of(by_id[cand]):
    base = base_of(by_id[cand])                       # 候选本身就是本区的推理配置 ⇒ 基础模型取它指向的 modelArn
else:
    hits = [b for b in bases if cand.endswith("." + b)]  # 候选是别区的推理配置 id(如欧洲主控区拿到 us.*)⇒ 用本区真值反推基础模型
    base = max(hits, key=len) if hits else cand          # 都不是 ⇒ 候选就是基础模型 id
regional, global_ = [], []
for r in rows:
    pid = r.get("inferenceProfileId") or ""
    if not pid or r.get("status", "ACTIVE") != "ACTIVE" or base_of(r) != base:
        continue
    (global_ if pid.startswith("global.") else regional).append(pid)
ordered = ([cand] if cand in by_id else []) + sorted(regional) + sorted(global_) + [base]
if not rows:
    # 列不到推理配置(被拒 / 空)⇒ 没有真值可反推;补一个**按形态**剥掉首段的变体放最后试(<geo>.<vendor>.<model> 形才剥)
    m = re.match(r"^[a-z]+(?:-[a-z]+)*\.([a-z0-9-]+\..+)$", cand)
    if m:
        ordered.append(m.group(1))
seen = set()
print(" ".join(x for x in ordered if not (x in seen or seen.add(x))))
PY
)
  for M in $EXPANDED; do
    # 🔴 maxTokens 不能给 1:Kimi K3 的下限是 16(2026-10-14 …7698 真环境原话「Invalid 'max_output_tokens': integer below minimum value.
    #   Expected a value >= 16」),给 1 会被当成「候选不可用」跳过 ⇒ 候选链永远落不到 Kimi(页面驱动段 p51b M26-a 抓到)。16 个 token 的探测成本可忽略。
    if ERR=$(aws bedrock-runtime converse --profile "$PROFILE" --region "$REGION" --model-id "$M" \
          --messages '[{"role":"user","content":[{"text":"ping"}]}]' --inference-config maxTokens=16 \
          --query 'stopReason' --output text 2>&1 >/dev/null); then
      [ "$M" = "$C" ] || echo "候选 $C 在 $REGION 以推理配置 $M 调通" >&2
      echo "$M"
      exit 0
    fi
    LINE="  ✗ 候选 $C → $M —— $(echo "$ERR" | tail -1 | cut -c1-200)"
    echo "$LINE" >&2
    TRIED="$TRIED\n$LINE"
  done
done
[ -n "$LIST_ERR" ] && TRIED="$TRIED\n  ✗ (列推理配置本身失败:$LIST_ERR)"
echo -e "❌ 主控区 $REGION 找不到能用的默认大模型(候选链:$CANDIDATES)。逐个真调用过:$TRIED\n   ⇒ 先在该区开通模型访问,或部署后在 /settings「AI 模型」卡选一个探测通过的。" >&2
exit 1
