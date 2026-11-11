#!/usr/bin/env bash
# scripts/11-seed-demo-memberships.sh 的离线替身(假 aws / curl,零凭证、零真调用),真的执行脚本本体。
#   覆盖:参数校验 · 部署模式护栏(production 零写入 / 模式冲突拒绝)· 口令来源(env / 落盘文件 / 都没有)· 令牌经头文件不经命令行 ·
#   只对没有成员行的账号 POST(已有的不动,角色不被盖回)· 请求体逐字 · 收口核对(POST 失败 ⇒ 非零并点名)· --check 三态 ·
#   口令 / 令牌绝不出现在输出里 · 名册 ⊆ 10-bootstrap-cognito.sh 名册 · 默认空间 id / 成员表名与平台常量同字面。
#   由 platform/src/lib/exec-env/__tests__/seed-demo-memberships-harness.test.ts 在 vitest 里真跑(「写了」≠「接上了」)。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SCRIPT="$ROOT/scripts/11-seed-demo-memberships.sh"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
export FAKE_CURL_LOG="$WORK/curl.log" FAKE_AWS_LOG="$WORK/aws.log"

cat > "$WORK/aws" <<'SH'
#!/usr/bin/env bash
args="$*"
echo "aws $args" >> "$FAKE_AWS_LOG"
case "$args" in
  *"ssm get-parameter"*)
    [ -z "${FAKE_SSM_MODE:-}" ] && { echo "An error occurred (ParameterNotFound) when calling the GetParameter operation" >&2; exit 254; }
    echo "$FAKE_SSM_MODE"; exit 0;;
  *"cloudformation describe-stacks"*)
    case "$args" in
      *PlatformUrl*) echo "https://demo.example.test/";;
      *ClientId*)    echo "client0a1b2c";;
      *)             echo "None";;
    esac; exit 0;;
  *"cognito-idp initiate-auth"*)
    [ -n "${FAKE_AUTH_FAIL:-}" ] && { echo "An error occurred (NotAuthorizedException): Incorrect username or password." >&2; exit 254; }
    case "$args" in *"--auth-parameters file://"*) ;; *) echo "fake aws: 口令必须经 file:// 传,不许进命令行" >&2; exit 96;; esac
    echo "fake.id.token.0a1b2c3d"; exit 0;;
  *"dynamodb get-item"*)
    [ -n "${FAKE_DDB_FAIL:-}" ] && { echo "An error occurred (AccessDeniedException) when calling the GetItem operation" >&2; exit 254; }
    u=$(sed -E 's/.*"username":\{"S":"([^"]+)".*/\1/' <<<"$args")
    IFS=, read -ra pres <<<"${FAKE_PRESENT:-}"
    for p in "${pres[@]}"; do [ -n "$p" ] && [ "${p%%=*}" = "$u" ] && { echo "${p##*=}"; exit 0; }; done
    echo "None"; exit 0;;
esac
echo "fake aws: 未预期的调用 $args" >&2; exit 99
SH
cat > "$WORK/curl" <<'SH'
#!/usr/bin/env bash
method=GET; url=""; body=""; hdrfile=""
while [ $# -gt 0 ]; do
  case "$1" in
    -X) method="$2"; shift 2;;
    -d|--data) body="$2"; shift 2;;
    -H) case "$2" in @*) hdrfile="${2#@}";; esac; shift 2;;
    --max-time) shift 2;;
    http*) url="$1"; shift;;
    *) shift;;
  esac
done
grep -q '^Authorization: Bearer ' "$hdrfile" 2>/dev/null || { echo "fake curl: 令牌必须经头文件(-H @file)传,不许进命令行" >&2; exit 98; }
printf '%s %s %s\n' "$method" "${url#https://demo.example.test}" "$body" >> "$FAKE_CURL_LOG"
case "$method ${url#https://demo.example.test}" in
  "GET /api/projects")
    [ -n "${FAKE_PROJECTS_FAIL:-}" ] && { echo '{"success":false,"error":{"message":"warming"}}'; exit 0; }
    echo '{"success":true,"data":[{"projectId":"proj-default"}]}'; exit 0;;
  "GET /api/projects/proj-default/members")
    python3 - "$FAKE_CURL_LOG" "${FAKE_PRESENT:-}" "${FAKE_POST_FAIL_USER:-}" <<'PY'
import json, sys
log, present, failu = sys.argv[1], sys.argv[2], sys.argv[3]
mem = {}
for p in filter(None, present.split(",")):
    u, r = p.split("=", 1); mem[u] = r
for line in open(log):
    parts = line.rstrip("\n").split(" ", 2)
    if len(parts) == 3 and parts[0] == "POST" and parts[1].endswith("/members"):
        try:
            b = json.loads(parts[2])
        except Exception:
            continue
        if b.get("username") and b["username"] != failu:
            mem[b["username"]] = b.get("role")
print(json.dumps({"success": True, "data": [{"username": u, "role": r} for u, r in mem.items()]}))
PY
    exit 0;;
  "POST /api/projects/proj-default/members")
    u=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("username",""))' "$body")
    if [ -n "${FAKE_POST_FAIL_USER:-}" ] && [ "$u" = "$FAKE_POST_FAIL_USER" ]; then printf '{"success":false,"error":{"message":"simulated 500 for %s"}}\n' "$u"; exit 0; fi
    printf '{"success":true,"data":{"username":"%s"}}\n' "$u"; exit 0;;
esac
echo "fake curl: 未预期的调用 $method $url" >&2; exit 97
SH
chmod +x "$WORK/aws" "$WORK/curl"

fails=0; cases=0
strip() { sed 's/\x1b\[[0-9;]*m//g'; }
expect_rc()      { cases=$((cases+1)); if [ "$2" = "$3" ]; then echo "  ok  $1(rc=$2)"; else echo "  ❌  $1:期望 rc=$3 实得 rc=$2"; fails=$((fails+1)); fi; }
expect_has()     { cases=$((cases+1)); if grep -qF -- "$3" "$2"; then echo "  ok  $1"; else echo "  ❌  $1:输出里没有「$3」"; sed 's/^/        /' "$2" | head -n 14; fails=$((fails+1)); fi; }
expect_not_has() { cases=$((cases+1)); if grep -qF -- "$3" "$2"; then echo "  ❌  $1:输出里不该出现「$3」"; fails=$((fails+1)); else echo "  ok  $1"; fi; }
expect_eq()      { cases=$((cases+1)); if [ "$2" = "$3" ]; then echo "  ok  $1(=$2)"; else echo "  ❌  $1:期望 $3 实得 $2"; fails=$((fails+1)); fi; }
run() { # run <输出文件> <脚本参数…>(环境变量由调用方放在前面);每次清空 curl / aws 日志
  local out="$1"; shift
  local rc=0
  : > "$FAKE_CURL_LOG"; : > "$FAKE_AWS_LOG"
  PATH="$WORK:$PATH" bash "$SCRIPT" "$@" 2>&1 | strip > "$out" || rc=${PIPESTATUS[0]}
  echo "$rc"
}
PW='Secret#Pw1-not-for-output'
posts() { grep -c '^POST ' "$FAKE_CURL_LOG" || true; }
auths() { grep -c 'initiate-auth' "$FAKE_AWS_LOG" || true; }

echo "C1 参数校验"
rc=$(run "$WORK/c1" p);                                  expect_rc "C1 只给 profile ⇒ exit 2(不给静默缺省)" "$rc" 2; expect_has "C1 报「用法错误」" "$WORK/c1" "用法错误"
rc=$(run "$WORK/c1b" --check p us-east-1);               expect_rc "C1b 旗标当首参 ⇒ exit 2" "$rc" 2
rc=$(run "$WORK/c1c" p us-east-1 --bogus);               expect_rc "C1c 未知参数 ⇒ exit 2" "$rc" 2

echo "C2 production ⇒ 零写入"
rc=$(FAKE_SSM_MODE=production BGP_ADMIN_PASSWORD="$PW" run "$WORK/c2" p us-east-1)
expect_rc "C2 production ⇒ exit 0" "$rc" 0; expect_has "C2 说「不造演示成员」" "$WORK/c2" "不造演示成员"; expect_has "C2 指路「管理员」" "$WORK/c2" "管理员"
expect_eq "C2 一次 curl 都没发" "$(wc -l < "$FAKE_CURL_LOG" | tr -d ' ')" 0; expect_eq "C2 没去取令牌" "$(auths)" 0

echo "C3 模式冲突"
rc=$(FAKE_SSM_MODE=production BGP_DEPLOY_MODE=demo BGP_ADMIN_PASSWORD="$PW" run "$WORK/c3" p us-east-1)
expect_rc "C3 SSM=production · env=demo ⇒ exit 2" "$rc" 2; expect_has "C3 报「拒绝」" "$WORK/c3" "拒绝"; expect_eq "C3 零 curl" "$(wc -l < "$FAKE_CURL_LOG" | tr -d ' ')" 0

echo "C4 demo · 一个成员都没有 ⇒ 四个都 POST"
rc=$(FAKE_SSM_MODE=demo BGP_ADMIN_PASSWORD="$PW" run "$WORK/c4" p us-east-1)
expect_rc "C4 ⇒ exit 0" "$rc" 0
expect_eq "C4 POST 恰 4 次" "$(posts)" 4
for pair in "pm-tester:owner" "rbac-tester:editor" "ops-analyst:viewer" "biz-tester:viewer"; do
  u="${pair%%:*}"; r="${pair##*:}"
  expect_has "C4 请求体 $u=$r 逐字" "$FAKE_CURL_LOG" "POST /api/projects/proj-default/members {\"username\":\"$u\",\"role\":\"$r\"}"
done
expect_has "C4 先读 /api/projects(让默认空间就位)" "$FAKE_CURL_LOG" "GET /api/projects "
expect_eq "C4 成员清单读两遍(改前 + 收口核对)" "$(grep -c '^GET /api/projects/proj-default/members' "$FAKE_CURL_LOG")" 2
expect_has "C4 结论行:新加入 4" "$WORK/c4" "新加入 4 · 原有不动 0 · 四个演示账号都在"
expect_not_has "C4 口令不进输出" "$WORK/c4" "$PW"; expect_not_has "C4 令牌不进输出" "$WORK/c4" "fake.id.token"
expect_not_has "C4 口令不进 aws 命令行" "$FAKE_AWS_LOG" "$PW"

echo "C5 demo · 两个已是成员(其一角色被管理员改过)⇒ 只补缺的两个,已有的不动"
rc=$(FAKE_SSM_MODE=demo FAKE_PRESENT="pm-tester=owner,ops-analyst=editor" BGP_ADMIN_PASSWORD="$PW" run "$WORK/c5" p us-east-1)
expect_rc "C5 ⇒ exit 0" "$rc" 0; expect_eq "C5 POST 恰 2 次" "$(posts)" 2
expect_not_has "C5 不碰 ops-analyst(角色 editor 不被盖回 viewer)" "$FAKE_CURL_LOG" '"username":"ops-analyst"'
expect_has "C5 说 ops-analyst 已是成员(角色 editor)不动" "$WORK/c5" "ops-analyst:已是成员(角色 editor)"
expect_has "C5 结论行:新加入 2 · 原有不动 2" "$WORK/c5" "新加入 2 · 原有不动 2"

echo "C6 口令来源"
rc=$(FAKE_SSM_MODE=demo BGP_PW_FILE="$WORK/nonexistent.json" run "$WORK/c6" p us-east-1)
expect_rc "C6 env 未设且落盘文件没有 ⇒ exit 1" "$rc" 1; expect_has "C6 报「拿不到 admin 口令」+ 补跑法" "$WORK/c6" "拿不到 admin 口令"; expect_eq "C6 零 curl" "$(wc -l < "$FAKE_CURL_LOG" | tr -d ' ')" 0
printf '{"admin":"%s","pm-tester":"x"}' "$PW" > "$WORK/pw.json"; chmod 600 "$WORK/pw.json"
rc=$(FAKE_SSM_MODE=demo BGP_PW_FILE="$WORK/pw.json" run "$WORK/c6b" p us-east-1)
expect_rc "C6b 口令取自落盘文件 ⇒ exit 0" "$rc" 0; expect_has "C6b 说口令取自文件" "$WORK/c6b" "口令取自"; expect_not_has "C6b 口令不进输出" "$WORK/c6b" "$PW"
rc=$(FAKE_SSM_MODE=demo FAKE_AUTH_FAIL=1 BGP_ADMIN_PASSWORD="$PW" run "$WORK/c6c" p us-east-1)
expect_rc "C6c 取令牌失败 ⇒ exit 1" "$rc" 1; expect_has "C6c 报「IdToken 失败」并指路改口令" "$WORK/c6c" "IdToken 失败"; expect_eq "C6c 零 curl" "$(wc -l < "$FAKE_CURL_LOG" | tr -d ' ')" 0

echo "C7 --check 三态(只读,不要口令)"
rc=$(FAKE_SSM_MODE=demo FAKE_PRESENT="pm-tester=owner,rbac-tester=editor,ops-analyst=viewer,biz-tester=viewer" run "$WORK/c7a" p us-east-1 --check)
expect_rc "C7a 四个都在 ⇒ exit 0" "$rc" 0; expect_has "C7a 说四个都在" "$WORK/c7a" "四个演示账号都在默认空间"
rc=$(FAKE_SSM_MODE=demo FAKE_PRESENT="pm-tester=owner,rbac-tester=editor,ops-analyst=viewer" run "$WORK/c7b" p us-east-1 --check)
expect_rc "C7b 缺一个 ⇒ exit 1" "$rc" 1; expect_has "C7b 点名「缺:biz-tester」" "$WORK/c7b" "缺:biz-tester"
rc=$(FAKE_SSM_MODE=demo FAKE_DDB_FAIL=1 run "$WORK/c7c" p us-east-1 --check)
expect_rc "C7c 读不到表 ⇒ exit 2(读不到 ≠ 齐)" "$rc" 2; expect_has "C7c 说「读不到成员表」" "$WORK/c7c" "读不到成员表"
rc=$(FAKE_SSM_MODE=production run "$WORK/c7d" p us-east-1 --check)
expect_rc "C7d production --check ⇒ exit 0 不适用" "$rc" 0; expect_has "C7d 说「不适用」" "$WORK/c7d" "不适用"
expect_eq "C7 --check 一次 curl 都没发" "$(wc -l < "$FAKE_CURL_LOG" | tr -d ' ')" 0; expect_eq "C7 --check 没去取令牌" "$(auths)" 0

echo "C8 POST 失败 ⇒ 收口核对红,点名用户"
rc=$(FAKE_SSM_MODE=demo FAKE_POST_FAIL_USER=rbac-tester BGP_ADMIN_PASSWORD="$PW" run "$WORK/c8" p us-east-1)
expect_rc "C8 ⇒ exit 1" "$rc" 1; expect_has "C8 点名 rbac-tester 加入失败" "$WORK/c8" "rbac-tester:加入失败"; expect_has "C8 结论说未补齐" "$WORK/c8" "演示账号成员资格未补齐"
expect_has "C8 表里 rbac-tester 标(缺)" "$WORK/c8" "rbac-tester  (缺)"
rc=$(FAKE_SSM_MODE=demo FAKE_PROJECTS_FAIL=1 DEMO_MEMBERS_RETRY_SLEEP=0 BGP_ADMIN_PASSWORD="$PW" run "$WORK/c8b" p us-east-1)
expect_rc "C8b /api/projects 六次都不成功 ⇒ exit 1(不往下写成员)" "$rc" 1; expect_has "C8b 报「六次都不成功」" "$WORK/c8b" "六次都不成功"
expect_eq "C8b 重试了 6 次" "$(grep -c '^GET /api/projects $' "$FAKE_CURL_LOG")" 6; expect_eq "C8b 零 POST" "$(posts)" 0

echo "C9 名册 / 常量三处一致"
cases=$((cases+1))
users_line=$(grep -E '^USERS=\(' "$ROOT/scripts/10-bootstrap-cognito.sh" | head -1)
roster_line=$(grep -E '^ROSTER=\(' "$SCRIPT" | head -1)
bad9=0
for entry in $(sed -E 's/^ROSTER=\((.*)\)$/\1/' <<<"$roster_line"); do
  u="${entry%%:*}"; r="${entry##*:}"
  grep -qw -- "$u" <<<"$users_line" || { echo "  ❌  C9 名册 $u 不在 10-bootstrap-cognito.sh 的 USERS 里"; bad9=1; }
  case "$r" in owner|editor|viewer) ;; *) echo "  ❌  C9 角色 $r 不在 owner / editor / viewer 里"; bad9=1;; esac
done
[ "$bad9" = 0 ] && echo "  ok  C9 名册 ⊆ 10-bootstrap USERS 且角色闭合" || fails=$((fails+1))
pid=$(grep -E 'export const DEFAULT_PROJECT_ID = ' "$ROOT/platform/src/lib/projects/constants.ts" | sed -E 's/.*= "([^"]+)".*/\1/')
expect_eq "C9 默认空间 id 与 constants.ts 同字面" "$(grep -E '^PROJECT_ID=' "$SCRIPT" | sed -E 's/^PROJECT_ID="([^"]+)".*/\1/')" "$pid"
tbl=$(grep -E 'PROJECT_MEMBERS: "' "$ROOT/platform/src/lib/aws/dynamodb.ts" | sed -E 's/.*"([^"]+)".*/\1/')
expect_eq "C9 成员表名与 dynamodb.ts 同字面" "$(grep -E '^MEMBERS_TABLE=' "$SCRIPT" | sed -E 's/^MEMBERS_TABLE="([^"]+)".*/\1/')" "$tbl"

echo "C10 接线:deploy-all 11.6 · redeploy-platform 3d · 02-postdeploy-truth 第 12 条都真的调它(「写了」≠「接上了」)"
expect_has "C10 deploy-all 调用" "$ROOT/scripts/deploy-all.sh" 'run_step "11.6) 演示账号项目成员资格(默认空间)" "$HERE/11-seed-demo-memberships.sh" "$PROFILE" "$REGION"'
expect_has "C10 deploy-all 只在 demo 分支" "$ROOT/scripts/deploy-all.sh" 'if [ "$BGP_DEPLOY_MODE" = "demo" ]; then'
expect_has "C10 redeploy-platform 调用" "$ROOT/scripts/redeploy-platform.sh" 'bash "$HERE/11-seed-demo-memberships.sh" "$PROFILE" "$REGION"'
expect_has "C10 真就位第 12 条 --check" "$ROOT/scripts/02-postdeploy-truth.sh" '"$HERE/11-seed-demo-memberships.sh" "$PROFILE" "$REGION" --check'

echo
if [ "$fails" -gt 0 ]; then echo "❌ demo-memberships 离线判据 $fails / $cases 项失败"; exit 1; fi
echo "✅ demo-memberships 离线判据全过($cases 项)"
