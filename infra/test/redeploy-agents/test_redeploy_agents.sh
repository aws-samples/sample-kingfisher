#!/usr/bin/env bash
# 序 39 B-76(2026-10-14)—— scripts/redeploy-agents.sh 的离线替身(假 aws / docker / npx,零凭证、零真调用、零构建)。
#   真的执行脚本本体,覆盖**升级前客户要跑的那条路**:参数校验 + 凭证核验 + 部署模式护栏 + `--check` 三态
#   (一致 / 需要刷新 / 读不到 —— 三态必须分开说,「读不到」≠「一致」)+ `--only` 过滤。
#   🔴 边界(诚实):构建推送镜像 / cdk 部署 / 回读核对那一段仍只有真环境能跑(第三十七轮链真跑一次,结论回写台账 B-76)。
#   由 platform/src/lib/exec-env/__tests__/redeploy-agents-harness.test.ts 在 vitest 里真跑(「写了」≠「接上了」)。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SCRIPT="$ROOT/scripts/redeploy-agents.sh"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT

# 假 aws:按子命令回放。账号 / ARN 字面量末 12 位含字母(红线扫描只拦纯数字账号号)。
cat > "$WORK/aws" <<'SH'
#!/usr/bin/env bash
args="$*"
case "$args" in
  *"sts get-caller-identity"*)
    [ -n "${FAKE_STS_FAIL:-}" ] && { echo "An error occurred (ExpiredToken) when calling the GetCallerIdentity operation: The security token included in the request is expired" >&2; exit 254; }
    echo "acct0000ab42"; exit 0;;
  *"ssm get-parameter"*)
    [ -n "${FAKE_SSM_FAIL:-}" ] && { echo "An error occurred (ParameterNotFound)" >&2; exit 254; }
    echo "${FAKE_SSM_MODE:-None}"; exit 0;;
  *"cloudformation describe-stacks"*)
    key=$(sed -E "s/.*OutputKey==[\\']+([A-Za-z]+)[\\']+.*/\1/" <<<"$args")
    case "$key" in
      *RuntimeArn)
        if [ "${FAKE_RT:-1}" = "none" ]; then echo "None"; else echo "arn:aws:bedrock-agentcore:us-east-1:acct0000ab42:runtime/bgp_${key%RuntimeArn}_agent-rt0a1b2c3d"; fi; exit 0;;
      *) echo "acct0000ab42.dkr.ecr.us-east-1.amazonaws.com/bgp-fake-agent"; exit 0;;
    esac;;
  *"bedrock-agentcore-control get-agent-runtime"*)
    [ -z "${FAKE_TAG:-}" ] && { echo "None"; exit 0; }
    id=$(sed -E 's/.*--agent-runtime-id ([^ ]+).*/\1/' <<<"$args")
    echo "acct0000ab42.dkr.ecr.us-east-1.amazonaws.com/bgp-${id%%_agent*}-agent:${FAKE_TAG}"; exit 0;;
esac
echo "fake aws: 未预期的调用 $args" >&2; exit 99
SH
chmod +x "$WORK/aws"
# 假 docker / npx:只为过 `command -v`(--check 路径不碰它们;真碰到就炸出来)
for t in docker npx; do printf '#!/usr/bin/env bash\necho "fake %s 不该被调用: $*" >&2; exit 97\n' "$t" > "$WORK/$t"; chmod +x "$WORK/$t"; done

fails=0; cases=0
strip() { sed 's/\x1b\[[0-9;]*m//g'; }
expect_rc()      { cases=$((cases+1)); if [ "$2" = "$3" ]; then echo "  ok  $1(rc=$2)"; else echo "  ❌  $1:期望 rc=$3 实得 rc=$2"; fails=$((fails+1)); fi; }
expect_has()     { cases=$((cases+1)); if grep -q -- "$3" "$2"; then echo "  ok  $1"; else echo "  ❌  $1:输出里没有「$3」"; sed 's/^/        /' "$2" | head -n 12; fails=$((fails+1)); fi; }
expect_not_has() { cases=$((cases+1)); if grep -q -- "$3" "$2"; then echo "  ❌  $1:输出里不该出现「$3」"; fails=$((fails+1)); else echo "  ok  $1"; fi; }
run() { # run <输出文件> <脚本参数…>(环境变量由调用方放在前面)
  local out="$1"; shift
  local rc=0
  PATH="$WORK:$PATH" bash "$SCRIPT" "$@" 2>&1 | strip > "$out" || rc=${PIPESTATUS[0]}
  echo "$rc"
}
HEAD_TAG=$(git -C "$ROOT" rev-parse --short HEAD)

echo "C1 旗标当成 profile"
rc=$(run "$WORK/c1" --profile p us-east-1 --check);          expect_rc "C1 「--profile x」当首参 ⇒ exit 2" "$rc" 2; expect_has "C1 报「用法错误」" "$WORK/c1" "用法错误"
echo "C2 漏主控区参数"
rc=$(run "$WORK/c2" p);                                       expect_rc "C2 只给 profile ⇒ exit 2(不给静默缺省)" "$rc" 2; expect_has "C2 报「必须显式给」" "$WORK/c2" "必须显式给"
echo "C3 凭证坏"
rc=$(FAKE_STS_FAIL=1 run "$WORK/c3" p us-east-1 --check);    expect_rc "C3 sts 失败 ⇒ exit 1,不往下猜" "$rc" 1; expect_has "C3 报「凭证不可用」" "$WORK/c3" "凭证不可用"; expect_not_has "C3 凭证坏时不许误诊成栈没建" "$WORK/c3" "读不到现网 Runtime"
echo "C4 读不到(栈输出 None)"
rc=$(FAKE_RT=none run "$WORK/c4" p us-east-1 --check);       expect_rc "C4 --check 读不到 ⇒ exit 0(只读)" "$rc" 0; expect_has "C4 每个智能体说「读不到」" "$WORK/c4" "读不到现网 Runtime 的镜像 tag"; expect_has "C4 结论=3 个读不到、无法判定" "$WORK/c4" "3 个智能体现网版本读不到"; expect_not_has "C4 「读不到」≠「一致」" "$WORK/c4" "这一版不用刷"
echo "C5 一致"
rc=$(FAKE_TAG="$HEAD_TAG" run "$WORK/c5" p us-east-1 --check); expect_rc "C5 tag == HEAD ⇒ exit 0" "$rc" 0; expect_has "C5 结论=不用刷" "$WORK/c5" "这一版不用刷"; cases=$((cases+1)); n=$(grep -c "== 本机 HEAD ✓" "$WORK/c5" || true); if [ "$n" = 3 ]; then echo "  ok  C5 三个智能体各一行 ✓"; else echo "  ❌  C5 期望 3 行 ✓,实得 $n"; fails=$((fails+1)); fi
echo "C6 本机没有该提交"
rc=$(FAKE_TAG=deadbee run "$WORK/c6" p us-east-1 --check);   expect_rc "C6 未知 tag ⇒ exit 0" "$rc" 0; expect_has "C6 说「本机没有提交」" "$WORK/c6" "本机没有提交 deadbee"; expect_has "C6 按需要刷新处理" "$WORK/c6" "3 个智能体需要刷新"
echo "C7 旧提交 vs HEAD 的差异计数"
# 🔴 源码路径清单只认 scripts/lib/agentcore-agents.sh 一份(单一作者):这里原来手抄了一份,序 40 给清单加了 platform/src/lib/ai/core
#   之后两边就漂了(脚本数 26、替身数 22 ⇒ 假红)。该文件「只定义,不执行」,先给它要的三个变量 / 三个函数占位再 source。
PROFILE=p; REGION=us-east-1; ROOT="$ROOT"; info() { :; }; die() { echo "$*" >&2; exit 1; }; out() { echo None; }
# shellcheck source=/dev/null
source "$ROOT/scripts/lib/agentcore-agents.sh"
OLD=$(git -C "$ROOT" log --format=%h -n 2 -- "${AGENT_SOURCE_PATHS[@]}" | tail -n 1)
if [ -n "$OLD" ] && [ "$OLD" != "$HEAD_TAG" ]; then
  N=$(git -C "$ROOT" diff --name-only "$OLD" HEAD -- "${AGENT_SOURCE_PATHS[@]}" | wc -l | tr -d ' ')
  rc=$(FAKE_TAG="$OLD" run "$WORK/c7" p us-east-1 --check);  expect_rc "C7 旧 tag ⇒ exit 0" "$rc" 0
  if [ "$N" -gt 0 ]; then expect_has "C7 两版间智能体源码有 $N 个文件不同 ⇒ 需要刷新" "$WORK/c7" "有 $N 个文件不同"; expect_has "C7 结论=需要刷新" "$WORK/c7" "3 个智能体需要刷新"
  else expect_has "C7 两版间无差 ⇒ 只是提交号变了" "$WORK/c7" "无差"; fi
else
  echo "  ⚠️  C7 仓库里找不到第二个触及智能体源码的提交,跳过(不算失败)"
fi
echo "C8 模式不许中途换"
rc=$(BGP_DEPLOY_MODE=demo FAKE_SSM_MODE=production run "$WORK/c8" p us-east-1 --check); expect_rc "C8 显式 demo 但 SSM 是 production ⇒ exit 1" "$rc" 1; expect_has "C8 报「拒绝中途换模式」" "$WORK/c8" "拒绝中途换模式"
echo "C9 未知智能体"
rc=$(run "$WORK/c9" p us-east-1 --check --only bogus);       expect_rc "C9 --only bogus ⇒ exit 1" "$rc" 1; expect_has "C9 报「未知智能体」" "$WORK/c9" "未知智能体:bogus"
echo "C10 --only 过滤"
rc=$(FAKE_TAG="$HEAD_TAG" run "$WORK/c10" p us-east-1 --check --only genbi); expect_rc "C10 --only genbi ⇒ exit 0" "$rc" 0; cases=$((cases+1)); n=$(grep -c "现网 tag" "$WORK/c10" || true); if [ "$n" = 1 ]; then echo "  ok  C10 只核 1 个智能体"; else echo "  ❌  C10 期望 1 行,实得 $n"; fails=$((fails+1)); fi; expect_not_has "C10 假 docker / npx 一次都没被碰" "$WORK/c10" "不该被调用"

if [ "$fails" = 0 ]; then echo "✅ redeploy-agents 离线判据全过($cases 例)"; else echo "❌ $fails / $cases 条不过"; exit 1; fi
