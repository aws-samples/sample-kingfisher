#!/usr/bin/env bash
# + 51-v2-multi-vendor—— scripts/resolve-home-model.sh 离线判据
#   (假 aws,零凭证、零真调用)。真的执行脚本本体。
#   ① 本区地理配置优先 ② 本区配置调不通 ⇒ 落到 global. ③ 全链调不通 ⇒ 非零退出、stdout 空、stderr 逐条列出
#   ④ 别的模型 / INACTIVE 的配置不当候选 ⑤ 列配置被拒 ⇒ 仍按形态剥前缀试基础模型并把拒因带出来
#   ⑥ 候选链:第一候选账号级被拒(「not available for this account」原话)⇒ 落到第二候选的本区推理配置,stderr 留痕
#   ⑦ env BGP_MODEL_CANDIDATES 显式覆盖 ⇒ stderr 标「候选来自 env」 ⑧ 候选本身是本区推理配置 id ⇒ 先试它
#   ⑨ 基础模型按 list-inference-profiles 的 modelArn **真值**反推(不写厂商正则)⑩ 三个部署脚本都接了解析器
#   由 platform/src/lib/ai/__tests__/resolve-home-model-harness.test.ts 在 vitest 里真跑。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SCRIPT="$ROOT/scripts/resolve-home-model.sh"
DEFAULT=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['defaultModelId'])" "$ROOT/platform/ai-model.json")
BASE="${DEFAULT#*.}"   # 出厂默认是 <geo>.<vendor>.<model> 形(us.anthropic.…);剥掉首段就是基础模型
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
cat > "$WORK/aws" <<'SH'
#!/usr/bin/env bash
# 假 aws:list-inference-profiles 回 $FAKE_PROFILES(或按 $FAKE_LIST_DENY 拒);converse 只对 $FAKE_OK 里的 id 成功;
#   含 zai.glm-5.3 的 id 一律回 Bedrock 真实原话「not available for this account」(2026-10-14 临时账号实测)
args="$*"
if [[ "$args" == *"list-inference-profiles"* ]]; then
  [ -n "${FAKE_LIST_DENY:-}" ] && { echo "An error occurred (AccessDeniedException) when calling ListInferenceProfiles" >&2; exit 254; }
  echo "$FAKE_PROFILES"; exit 0
fi
if [[ "$args" == *"converse"* ]]; then
  mid=$(sed -E 's/.*--model-id ([^ ]+).*/\1/' <<<"$args")
  echo "$mid" >> "$FAKE_CALLS"
  for ok in $FAKE_OK; do [ "$ok" = "$mid" ] && { echo end_turn; exit 0; }; done
  case "$mid" in *zai.glm-5.3*) echo "An error occurred (AccessDeniedException) when calling the Converse operation: zai.glm-5.3 is not available for this account. Contact AWS Sales for access." >&2;;
                 *) echo "An error occurred (ValidationException): Invocation of model ID $mid isn't supported" >&2;; esac
  exit 254
fi
exit 99
SH
chmod +x "$WORK/aws"
arn() { printf 'arn:aws:bedrock:eu-west-1::foundation-model/%s' "$1"; }
prof() { printf '{"inferenceProfileId":"%s","status":"%s","models":[{"modelArn":"%s"}]}' "$1" "${3:-ACTIVE}" "$(arn "$2")"; }
PROFILES="{\"inferenceProfileSummaries\":[$(prof "eu.$BASE" "$BASE"),$(prof "global.$BASE" "$BASE"),$(prof "eu.anthropic.claude-haiku-x" "anthropic.claude-haiku-x"),$(prof "apac.$BASE" "$BASE" INACTIVE),$(prof "eu.zai.glm-5.3" "zai.glm-5.3"),$(prof "global.zai.glm-5.3" "zai.glm-5.3"),$(prof "eu.moonshotai.kimi-k3" "moonshotai.kimi-k3"),$(prof "global.moonshotai.kimi-k3" "moonshotai.kimi-k3")]}"
fails=0; cases=0
check() { cases=$((cases+1)); if [ "$2" = "$3" ]; then echo "  ok  $1"; else echo "  ❌  $1:期望 [$3] 实得 [$2]"; fails=$((fails+1)); fi; }
has()   { cases=$((cases+1)); if grep -q -- "$2" "$WORK/err"; then echo "  ok  $1"; else echo "  ❌  $1:stderr 里没有「$2」"; sed 's/^/        /' "$WORK/err" | head -n 8; fails=$((fails+1)); fi; }
run() { FAKE_CALLS="$WORK/calls" PATH="$WORK:$PATH" bash "$SCRIPT" p eu-west-1 2>"$WORK/err"; }

: > "$WORK/calls"; out=$(FAKE_PROFILES="$PROFILES" FAKE_OK="eu.$BASE global.$BASE" run || true)
check "① 本区地理配置优先(候选 us.* 在欧洲列不到 ⇒ 按 modelArn 真值反推基础模型)" "$out" "eu.$BASE"
check "⑨ 第一次真调用就是 eu.(不试 us. 候选原文)" "$(head -n 1 "$WORK/calls")" "eu.$BASE"
: > "$WORK/calls"; out=$(FAKE_PROFILES="$PROFILES" FAKE_OK="global.$BASE" run || true)
check "② 本区配置调不通 ⇒ global." "$out" "global.$BASE"
check "④ 候选只有指向该基础模型且 ACTIVE 的(haiku / INACTIVE 不试)" "$(tr '\n' ' ' < "$WORK/calls")" "eu.$BASE global.$BASE "
has "② 失败的那次留痕在 stderr(✗ 候选 → id —— 原话)" "✗ 候选 $DEFAULT → eu.$BASE —— "
: > "$WORK/calls"; rc=0; out=$(FAKE_PROFILES="$PROFILES" FAKE_OK="" run) || rc=$?
check "③ 全链调不通 ⇒ 非零退出、stdout 空" "$rc:$out" "1:"
has "③ 首候选的拒因列出" "$BASE —— "
has "③ 第二候选(glm-5.3)的展开与账号级原话列出" "eu.zai.glm-5.3 —— An error occurred (AccessDeniedException) when calling the Converse operation: zai.glm-5.3 is not available for this account"
has "③ 第三候选(kimi-k3)也试过" "eu.moonshotai.kimi-k3 —— "
has "③ 总结句点名候选链" "找不到能用的默认大模型(候选链:"
: > "$WORK/calls"; out=$(FAKE_LIST_DENY=1 FAKE_PROFILES="" FAKE_OK="$BASE" run || true)
check "⑤ 列配置被拒 ⇒ 按形态剥前缀仍试基础模型" "$out" "$BASE"
: > "$WORK/calls"; rc=0; FAKE_LIST_DENY=1 FAKE_PROFILES="" FAKE_OK="" run >/dev/null || rc=$?
has "⑤ 列配置的拒因带出来" "列推理配置本身失败"
check "⑤ 全不通仍 rc=1" "$rc" "1"
: > "$WORK/calls"; out=$(BGP_MODEL_CANDIDATES="zai.glm-5.3 moonshotai.kimi-k3" FAKE_PROFILES="$PROFILES" FAKE_OK="eu.moonshotai.kimi-k3" run || true)
check "⑥ 候选链:glm-5.3 账号级被拒 ⇒ 落到第二候选的本区推理配置" "$out" "eu.moonshotai.kimi-k3"
check "⑥ 调用顺序:eu.zai → global.zai → zai 裸 id → eu.kimi(成功即停)" "$(tr '\n' ' ' < "$WORK/calls")" "eu.zai.glm-5.3 global.zai.glm-5.3 zai.glm-5.3 eu.moonshotai.kimi-k3 "
has "⑥ stderr 留痕 glm-5.3 的三个展开 id 与「not available for this account」" "✗ 候选 zai.glm-5.3 → global.zai.glm-5.3 —— "
has "⑥ 成功时说明候选到实际 id 的映射" "候选 moonshotai.kimi-k3 在 eu-west-1 以推理配置 eu.moonshotai.kimi-k3 调通"
has "⑦ env 覆盖候选链时 stderr 标明「候选来自 env」" "候选来自 env BGP_MODEL_CANDIDATES"
: > "$WORK/calls"; out=$(BGP_MODEL_CANDIDATES="global.$BASE" FAKE_PROFILES="$PROFILES" FAKE_OK="global.$BASE eu.$BASE" run || true)
check "⑧ 候选本身是本区推理配置 id ⇒ 先试它本身(不被 eu. 抢先)" "$out" "global.$BASE"
check "⑧ 第一次调用就是候选本身" "$(head -n 1 "$WORK/calls")" "global.$BASE"

# ⑩ 三个部署脚本都接了解析器(显式 BEDROCK_MODEL_ID 优先;01-preflight 第 7 项改调它)
for f in deploy-all.sh redeploy-platform.sh; do
  cases=$((cases+1))
  grep -q 'if \[ -z "${BEDROCK_MODEL_ID:-}" \]; then' "$ROOT/scripts/$f" && grep -q 'resolve-home-model.sh" "$PROFILE" "$REGION"' "$ROOT/scripts/$f" \
    && echo "  ok  ⑩ $f 接了解析器且显式值优先" || { echo "  ❌  ⑩ $f 没接解析器"; fails=$((fails+1)); }
done
cases=$((cases+1)); grep -q 'resolve-home-model.sh" "$PROFILE" "$REGION"' "$ROOT/scripts/01-preflight-account.sh" \
  && echo "  ok  ⑩ 01-preflight 第 7 项改调解析器(候选链逐个真 converse)" || { echo "  ❌  ⑩ 01-preflight 没接解析器"; fails=$((fails+1)); }
cases=$((cases+1)); grep -qE 'anthropic\|openai' "$SCRIPT" && { echo "  ❌  ⑨ 脚本里仍有厂商正则"; fails=$((fails+1)); } || echo "  ok  ⑨ 脚本里没有厂商正则(基础模型按 modelArn 真值反推)"
[ "$fails" = 0 ] && echo "✅ 主控区模型解析判据全过($cases 例)" || { echo "❌ $fails / $cases 条不过"; exit 1; }
