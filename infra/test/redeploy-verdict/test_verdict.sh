#!/usr/bin/env bash
# @kf-batch 50-WP27-9cap-matrix
# IAM 模拟门裁决的**三态接线**离线判据 —— 把 `scripts/redeploy-platform.sh` 里那一段**逐字抽出来**,
# 在与真脚本相同的 `set -euo pipefail` 之下,对门的退出码 rc ∈ {0,1,2,3,4} 各跑一次。
#
#     bash infra/test/redeploy-verdict/test_verdict.sh      # 退出码 0 = 全过
#
# 🔴🔴 **为什么必须这样测(2026-09-19 真踩,同族第三次)**:那一段原来写的是
#     iam_gate_verdict "$IAM_GATE_RC"; VERDICT=$?
#   在 `set -euo pipefail` 之下,**函数回非 0 就当场把脚本杀掉** ⇒ 下面 case 里除了「0 绿」以外的
#   每一条话(包括 2026-09-17 专门为三态写的那两条)**一次都没打印过**:真环境日志停在门的摘要
#   后面,脚本静默退出,谁也不知道它本来该说什么。
#   也就是说:**三态写在代码里、却从来没有接上**(记忆 `unwired-code-is-unverified`)。
#   ⇒ 判据不能只看「源码里有没有那几句话」(那种文本判据当时是绿的!),必须**真的在 errexit 下跑一遍**
#     并断言每一态都确实打印了自己那句话。
#
# 🔴 逐字抽取:用 `# >>> iam-gate-verdict-block` / `# <<< iam-gate-verdict-block` 两个标记夹住,
#   本文件不复制那段逻辑的任何一行 —— 复制就会有两份,而漏改的那一份就是下一次假绿。
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
SRC="$REPO/scripts/redeploy-platform.sh"
BLOCK=/tmp/kf_verdict_block.$$.sh
trap 'rm -f "$BLOCK" /tmp/kf_verdict_out.$$.txt' EXIT

fails=0
n=0
chk() { # $1=说明 $2=期望 $3=实际
  n=$((n + 1))
  if [ "$2" = "$3" ]; then printf '  ✅ %s(%s)\n' "$1" "$3"
  else printf '  ❌ %s:期望 %s,实际 %s\n' "$1" "$2" "$3"; fails=$((fails + 1)); fi
}

# ── 抽取 ──────────────────────────────────────────────────────────────────────
awk '/^# >>> iam-gate-verdict-block/{f=1;next} /^# <<< iam-gate-verdict-block/{f=0} f' "$SRC" > "$BLOCK"
LINES=$(grep -c '' "$BLOCK")
n=$((n + 1))
if [ "$LINES" -ge 20 ]; then printf '  ✅ 抽到裁决段 %s 行\n' "$LINES"
else printf '  ❌ 只抽到 %s 行 ⇒ 标记丢了/改名了,这组判据在空转\n' "$LINES"; fails=$((fails + 1)); fi
# 负向:抽出来的那段**不许**含真正去调门的那一行的无条件形式(否则离线判据会真发 AWS 请求)
n=$((n + 1))
if grep -q 'IAM_GATE_RC:-' "$BLOCK"; then printf '  ✅ 段内对 IAM_GATE_RC 有「已给就不再跑」的守卫(离线可驱动)\n'
else printf '  ❌ 段内没有 IAM_GATE_RC 注入口 ⇒ 离线跑会真去调 AWS\n'; fails=$((fails + 1)); fi

# ── 逐态真跑(与真脚本同样的 set -euo pipefail)──────────────────────────────
run_rc() { # $1=门的退出码 ⇒ 打印「退出码|输出」
  local out rc
  out=$(
    set -euo pipefail
    PROFILE=p REGION=r ROOT=/nonexistent EXEC_REGIONS=r
    say()  { printf 'SAY:%s\n' "$*"; }
    die()  { printf 'DIE:%s\n' "$*"; exit 1; }
    IAM_GATE_RC="$1"
    # shellcheck disable=SC1090
    . "$BLOCK"
  2>&1 ) ; rc=$?
  printf '%s|%s' "$rc" "$(printf '%s' "$out" | tr '\n' '~')"
}

echo "== rc=0(全 allowed)=="
r=$(run_rc 0); chk "退出码" "0" "${r%%|*}"
case "${r#*|}" in *"SAY:"*"全绿"*) chk "说了「全绿」" "yes" "yes";; *) chk "说了「全绿」" "yes" "no($(printf '%s' "${r#*|}" | cut -c1-90))";; esac
case "${r#*|}" in *"IAM_GATE_VERDICT=green"*) chk "机读裁决" "green" "green";; *) chk "机读裁决" "green" "缺";; esac

echo "== rc=1(有真红)=="
r=$(run_rc 1); chk "退出码" "1" "${r%%|*}"
case "${r#*|}" in *"DIE:"*"模拟门红"*) chk "🔴 真红那一句**真的打印了**" "yes" "yes";; *) chk "🔴 真红那一句**真的打印了**" "yes" "no($(printf '%s' "${r#*|}" | cut -c1-90))";; esac

echo "== rc=2(门自己没跑成)=="
r=$(run_rc 2); chk "退出码" "3" "${r%%|*}"
case "${r#*|}" in *"没有执行"*) chk "🔴 「门没执行」那一段**真的打印了**" "yes" "yes";; *) chk "🔴 「门没执行」那一段**真的打印了**" "yes" "no";; esac

echo "== rc=4(有环境阻塞、无真红)=="
r=$(run_rc 4); chk "退出码(不许中止部署链)" "0" "${r%%|*}"
case "${r#*|}" in *"验不了"*) chk "🔴 「本账号验不了」那一段**真的打印了**" "yes" "yes";; *) chk "🔴 「本账号验不了」那一段**真的打印了**" "yes" "no";; esac
case "${r#*|}" in *"不是过关"*) chk "并且明说了「不是过关」" "yes" "yes";; *) chk "并且明说了「不是过关」" "yes" "no";; esac
case "${r#*|}" in *"IAM_GATE_VERDICT=env-blocked"*) chk "机读裁决" "env-blocked" "env-blocked";; *) chk "机读裁决" "env-blocked" "缺";; esac

echo "== rc=3(门契约里没有这个码 ⇒ 当真红处理,fail-closed)=="
r=$(run_rc 3); chk "退出码" "1" "${r%%|*}"

printf '\n%s 三态接线:%s/%s 通过\n' "$([ "$fails" = 0 ] && echo ✅ || echo ❌)" "$((n - fails))" "$n"
[ "$fails" = 0 ]
