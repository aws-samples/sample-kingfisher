#!/usr/bin/env bash
###############################################################################
# 11-seed-demo-memberships.sh —— demo 模式:给四个演示角色账号默认空间的项目成员资格(幂等)。
#
#   ./scripts/11-seed-demo-memberships.sh <aws-profile> <主控区>            # 补齐(deploy-all 11.6 / redeploy-platform 3d 调它)
#   ./scripts/11-seed-demo-memberships.sh <aws-profile> <主控区> --check    # 只读核对(02-postdeploy-truth.sh 第 12 条调它)
#
# 🔴 为什么要这一步(2026-11-10 测试账号页面驱动段真撞):10-bootstrap-cognito.sh 在 demo 模式建出 pm-tester / rbac-tester /
#   ops-analyst / biz-tester 四个演示账号,却从不给任何项目成员资格;服务端的项目准入**没有隐式成员**(平台管理员或成员行,
#   lib/projects/project-service.ts 的 resolveRole)⇒ 四个账号登得进去,但执行范围清单 / 问数 / 同步列表等一切项目级读接口
#   全部 403「无权访问该项目空间」,演示 / 验收环境在用户眼里就是「账号都没用」。
#   production 环境成员由管理员在「项目空间」页添加(手册 §4 第 3 条),本脚本按 SSM /bgp/deploy-mode 判定后直接跳过、零写入。
#
# 怎么做(走产品自己的路,不直写表):admin IdToken ⇒ GET /api/projects(顺带让默认空间就位)⇒ GET 成员清单 ⇒ 只对**没有成员行**的
#   账号 POST /api/projects/<默认空间>/members(与页面「添加/更新」同一条路由:解析 Cognito sub / email、写审计 project.member.put)。
#   已有成员行的一律不动 —— 管理员改过的角色不被造数盖回。最后再读一遍成员清单核对四个都在。
# 角色:pm-tester(bgp-manager)= owner · rbac-tester(bgp-developer)= editor · ops-analyst(bgp-analyst)= viewer · biz-tester(无组)= viewer。
#   🔴 用户名必须是 10-bootstrap-cognito.sh 名册的子集;默认空间 id 与成员表名分别与 platform/src/lib/projects/constants.ts 的
#   DEFAULT_PROJECT_ID、platform/src/lib/aws/dynamodb.ts 的 TABLES.PROJECT_MEMBERS 同字面(离线判据钉死三处一致)。
# 口令来源:env BGP_ADMIN_PASSWORD → 第 11 步落盘的 ${BGP_PW_FILE:-/tmp/bgp-cognito-pw-<profile>.json}(键 admin)。口令 / 令牌绝不打印。
# 离线判据(假 aws / curl 真跑本脚本):infra/test/demo-memberships/test_seed_demo_memberships.sh。
###############################################################################
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() { echo "用法错误:$*" >&2; echo "用法:$0 <aws-profile> <主控区> [--check]" >&2; exit 2; }
[ $# -ge 2 ] || usage "必须显式给 <aws-profile> 与 <主控区> 两个参数(不给静默缺省)"
case "$1" in --*) usage "第一个参数应是 profile,不是旗标 $1";; esac
case "$2" in --*) usage "第二个参数应是主控区,不是旗标 $2";; esac
PROFILE="$1"; REGION="$2"; CHECK_ONLY=0
if [ $# -ge 3 ]; then [ "$3" = "--check" ] || usage "未知参数 $3"; CHECK_ONLY=1; fi

DEPLOY_MODE_LOG_PREFIX="[demo-members]"
# shellcheck source=lib/deploy-mode.sh
source "$HERE/lib/deploy-mode.sh"
DEPLOY_MODE="$(resolve_deploy_mode)" || exit 2

PROJECT_ID="proj-default"                 # == platform/src/lib/projects/constants.ts DEFAULT_PROJECT_ID
MEMBERS_TABLE="bgp-project-members"       # == platform/src/lib/aws/dynamodb.ts TABLES.PROJECT_MEMBERS
ROSTER=(pm-tester:owner rbac-tester:editor ops-analyst:viewer biz-tester:viewer)

info() { printf '   %s\n' "$*"; }
die()  { printf '\033[1;31m[demo-members] ERROR: %s\033[0m\n' "$*" >&2; exit 1; }

if [ "$DEPLOY_MODE" != "demo" ]; then
  echo "production 模式:不造演示成员 —— 项目成员由管理员在「项目空间」页添加(手册 §4),本步不适用"
  exit 0
fi

# ── --check:只读核对成员表(真值查询,不需要口令)────────────────────────────────────────────────
if [ "$CHECK_ONLY" = "1" ]; then
  missing=0; have=()
  for entry in "${ROSTER[@]}"; do
    u="${entry%%:*}"; want="${entry##*:}"
    role=$(aws dynamodb get-item --profile "$PROFILE" --region "$REGION" --table-name "$MEMBERS_TABLE" \
             --key "{\"projectId\":{\"S\":\"$PROJECT_ID\"},\"username\":{\"S\":\"$u\"}}" \
             --query 'Item.role.S' --output text 2>/dev/null) || { echo "读不到成员表 $MEMBERS_TABLE(凭证 / 权限 / 表不存在)" >&2; exit 2; }
    if [ -z "$role" ] || [ "$role" = "None" ]; then echo "缺:$u(应为 $want)"; missing=$((missing+1)); else have+=("$u=$role"); fi
  done
  if [ "$missing" -gt 0 ]; then echo "演示账号缺 $missing 个成员行 ⇒ 跑 scripts/11-seed-demo-memberships.sh $PROFILE $REGION"; exit 1; fi
  echo "四个演示账号都在默认空间 $PROJECT_ID(${have[*]})"
  exit 0
fi

# ── 补齐:走产品的成员路由 ────────────────────────────────────────────────────────────────────────
out() { aws cloudformation describe-stacks --stack-name "$1" --profile "$PROFILE" --region "$REGION" \
          --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text 2>/dev/null || true; }
URL=$(out BgpPlatformStack PlatformUrl);  { [ -n "$URL" ] && [ "$URL" != "None" ]; } || die "读不到 BgpPlatformStack.PlatformUrl(平台栈没部署?)"
CLIENT=$(out BgpAuthStack ClientId);      { [ -n "$CLIENT" ] && [ "$CLIENT" != "None" ]; } || die "读不到 BgpAuthStack.ClientId"
URL="${URL%/}"

PW_FILE="${BGP_PW_FILE:-/tmp/bgp-cognito-pw-${PROFILE}.json}"
ADMIN_PW="${BGP_ADMIN_PASSWORD:-}"
if [ -z "$ADMIN_PW" ] && [ -r "$PW_FILE" ]; then
  ADMIN_PW="$(python3 -c 'import json,sys
try:
    print(json.load(open(sys.argv[1]))["admin"])
except Exception:
    pass' "$PW_FILE")"
  [ -n "$ADMIN_PW" ] && info "admin 口令取自 $PW_FILE(第 11 步落盘)"
fi
[ -n "$ADMIN_PW" ] || die "拿不到 admin 口令:env BGP_ADMIN_PASSWORD 未设,且 $PW_FILE 里也没有 —— 补跑:export BGP_ADMIN_PASSWORD=… 后重跑本脚本"

# 口令经 600 权限的临时文件交给 CLI(file://),不进命令行 / ps;用完即删
AUTHF="$(mktemp)"; chmod 600 "$AUTHF"
printf '%s' "$ADMIN_PW" | python3 -c 'import json,sys; json.dump({"USERNAME": "admin", "PASSWORD": sys.stdin.read()}, open(sys.argv[1], "w"))' "$AUTHF"
unset ADMIN_PW
TOKEN=$(aws cognito-idp initiate-auth --profile "$PROFILE" --region "$REGION" --auth-flow USER_PASSWORD_AUTH \
          --client-id "$CLIENT" --auth-parameters "file://$AUTHF" \
          --query 'AuthenticationResult.IdToken' --output text 2>/dev/null) || TOKEN=""
rm -f "$AUTHF"
{ [ -n "$TOKEN" ] && [ "$TOKEN" != "None" ]; } || die "admin 取 IdToken 失败(口令不对或用户池不可达)—— 管理员已改口令时 export BGP_ADMIN_PASSWORD=… 再跑"
# 令牌经头文件传给 curl(不进命令行 / ps);600 权限,退出即删
HDR="$(mktemp)"; chmod 600 "$HDR"; printf 'Authorization: Bearer %s\n' "$TOKEN" > "$HDR"; unset TOKEN
trap 'rm -f "$HDR"' EXIT
api() { curl -sS --max-time 60 -H @"$HDR" -H "Content-Type: application/json" "$@" 2>/dev/null || true; }
# JSON 读取器:stdin = 响应;参数 1 = 要取什么(ok / members)
jread() { python3 -c '
import json, sys
what = sys.argv[1]
try:
    d = json.load(sys.stdin)
except Exception:
    d = {}
if what == "ok":
    print("yes" if d.get("success") is True else "no")
elif what == "members":
    for m in (d.get("data") or []) if d.get("success") is True else []:
        if isinstance(m, dict) and m.get("username"):
            print(str(m["username"]) + "\t" + str(m.get("role") or ""))
elif what == "err":
    e = d.get("error") or {}
    print((e.get("message") if isinstance(e, dict) else str(e)) or "(无错误信息)")
' "$1"; }

# 平台刚滚动完可能还在预热:最多等 6 × 20 秒;这一读同时让默认空间就位(服务端 listVisibleProjects 先 ensureDefaultProject)
RETRY_SLEEP="${DEMO_MEMBERS_RETRY_SLEEP:-20}"   # 只有离线判据会改它(缩短等待);生产 / 演示部署用缺省 20 秒
ready=0
for i in 1 2 3 4 5 6; do
  if [ "$(api "$URL/api/projects" | jread ok)" = "yes" ]; then ready=1; break; fi
  info "(第 $i 次)平台 /api/projects 未就绪,$RETRY_SLEEP 秒后再试"; sleep "$RETRY_SLEEP"
done
[ "$ready" = "1" ] || die "平台 $URL 的 /api/projects 六次都不成功(平台还在滚动?或 admin 令牌被拒)—— 稍后重跑本脚本"

read_members() { api "$URL/api/projects/$PROJECT_ID/members" | jread members; }
declare -A HAVE=()
while IFS=$'\t' read -r u r; do [ -n "$u" ] && HAVE["$u"]="$r"; done < <(read_members)

added=0; kept=0; failed=()
for entry in "${ROSTER[@]}"; do
  u="${entry%%:*}"; role="${entry##*:}"
  if [ -n "${HAVE[$u]+x}" ]; then
    info "$u:已是成员(角色 ${HAVE[$u]})—— 不动(管理员改过的角色不被造数盖回)"; kept=$((kept+1)); continue
  fi
  resp=$(api -X POST "$URL/api/projects/$PROJECT_ID/members" -d "{\"username\":\"$u\",\"role\":\"$role\"}")
  if [ "$(printf '%s' "$resp" | jread ok)" = "yes" ]; then
    info "$u:已加入默认空间,角色 $role"; added=$((added+1))
  else
    printf '   \033[1;31m✗ %s:加入失败 —— %s\033[0m\n' "$u" "$(printf '%s' "$resp" | jread err)"; failed+=("$u")
  fi
done

# 收口核对:再读一遍成员清单,四个都得在(「写了」≠「写进去了」)
declare -A NOW=()
while IFS=$'\t' read -r u r; do [ -n "$u" ] && NOW["$u"]="$r"; done < <(read_members)
missing=()
for entry in "${ROSTER[@]}"; do u="${entry%%:*}"; [ -n "${NOW[$u]+x}" ] || missing+=("$u"); done
printf '   %-12s %-8s\n' 用户名 角色
for entry in "${ROSTER[@]}"; do u="${entry%%:*}"; printf '   %-12s %-8s\n' "$u" "${NOW[$u]:-(缺)}"; done
if [ ${#failed[@]} -gt 0 ] || [ ${#missing[@]} -gt 0 ]; then
  die "演示账号成员资格未补齐:失败 ${failed[*]:-无} · 核对缺 ${missing[*]:-无} —— 修好后重跑本脚本(幂等)"
fi
echo "[demo-members] 默认空间 $PROJECT_ID:新加入 $added · 原有不动 $kept · 四个演示账号都在 ✅"
