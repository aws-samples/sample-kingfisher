#!/usr/bin/env bash
# scripts/lib/deploy-mode.sh 里 `resolve_deploy_mode` 的离线真跑判据(假 aws 驱动每条分支;10-bootstrap-cognito.sh 与
# 11-seed-demo-memberships.sh 都 source 这一份 —— 函数单一作者,调用点在这里一并钉住)。
#
# 🔴 为什么:单独重跑建号脚本时,原来只看 env BGP_DEPLOY_MODE ⇒ 在已按 production 部署的环境上手敲 demo 重跑,
#   就会冒出四个测试账号。护栏 = SSM /bgp/deploy-mode 有值即以它为准、env 给别的值就拒绝;SSM 读不到才按 env(缺省 production)。
#     bash infra/test/cognito-mode-guard/test_mode_guard.sh      # 退出码 0 = 全过
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
SRC="$ROOT/scripts/10-bootstrap-cognito.sh"
LIB="$ROOT/scripts/lib/deploy-mode.sh"
SEED="$ROOT/scripts/11-seed-demo-memberships.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fails=0
ok()  { printf '  ✅ %s\n' "$1"; }
bad() { printf '  ❌ %s\n' "$1"; fails=$((fails+1)); }

# 抽函数(名字写死 = 抽错就报,不静默)
awk 'BEGIN{p=0} /^resolve_deploy_mode\(\) \{/ {p=1} p{print} p && /^}$/{exit}' "$LIB" > "$TMP/fn.sh"
[ -s "$TMP/fn.sh" ] || { bad "抽不出 resolve_deploy_mode(scripts/lib/deploy-mode.sh 改名了?)"; exit 1; }
grep -q '^resolve_deploy_mode()' "$SRC" && bad "10-bootstrap-cognito.sh 里又长出第二份 resolve_deploy_mode(单一作者是 scripts/lib/deploy-mode.sh)"
grep -q 'source "$HERE/lib/deploy-mode.sh"' "$SRC" || bad "10-bootstrap-cognito.sh 没有 source scripts/lib/deploy-mode.sh"
grep -q 'source "$HERE/lib/deploy-mode.sh"' "$SEED" || bad "11-seed-demo-memberships.sh 没有 source scripts/lib/deploy-mode.sh"
grep -q 'DEPLOY_MODE="$(resolve_deploy_mode)" || exit 2' "$SRC" || bad "建号脚本没有在名册裁剪前调用 resolve_deploy_mode(写了 ≠ 接上了)"
grep -q 'DEPLOY_MODE="$(resolve_deploy_mode)" || exit 2' "$SEED" || bad "演示成员脚本没有在写之前调用 resolve_deploy_mode(写了 ≠ 接上了)"
grep -q 'if \[ "$DEPLOY_MODE" != "demo" \]; then USERS=(admin); fi' "$SRC" || bad "名册裁剪没有改读 resolve_deploy_mode 的结果"

# 假 aws:FAKE_SSM=deny ⇒ 被拒;FAKE_SSM=none ⇒ 回字面 None;其它 ⇒ 回该值
cat > "$TMP/aws" <<'FAKE'
#!/usr/bin/env bash
case "${FAKE_SSM:-}" in
  deny) echo "An error occurred (AccessDeniedException) when calling the GetParameter operation" >&2; exit 254;;
  none) echo "None";;
  "")   echo "An error occurred (ParameterNotFound) when calling the GetParameter operation" >&2; exit 254;;
  *)    echo "$FAKE_SSM";;
esac
FAKE
chmod +x "$TMP/aws"

run_case() {  # $1=FAKE_SSM $2=env BGP_DEPLOY_MODE(空串 = 不设)⇒ 打印 "rc:<rc> out:<stdout> err:<stderr 一行>"
  local out err rc
  out="$(cd "$TMP" && PATH="$TMP:$PATH" FAKE_SSM="$1" PROFILE=p REGION=us-east-1 bash -c '
    set -uo pipefail
    source ./fn.sh
    if [ -n "'"$2"'" ]; then export BGP_DEPLOY_MODE="'"$2"'"; else unset BGP_DEPLOY_MODE; fi
    resolve_deploy_mode' 2>"$TMP/err")"; rc=$?
  err="$(tr '\n' ' ' < "$TMP/err")"
  printf 'rc:%s out:%s err:%s' "$rc" "$out" "$err"
}

r="$(run_case production "")";      [[ "$r" == rc:0\ out:production* && "$r" == *"SSM /bgp/deploy-mode"* ]] && ok "SSM=production · env 未设 ⇒ production(依据 SSM)" || bad "SSM=production · env 未设:$r"
r="$(run_case production demo)";    [[ "$r" == rc:2* && "$r" == *拒绝* ]] && ok "SSM=production · env=demo ⇒ 拒绝 exit 2(生产里不许冒出测试账号)" || bad "SSM=production · env=demo:$r"
r="$(run_case demo demo)";          [[ "$r" == rc:0\ out:demo* ]] && ok "SSM=demo · env=demo ⇒ demo" || bad "SSM=demo · env=demo:$r"
r="$(run_case demo "")";            [[ "$r" == rc:0\ out:demo* ]] && ok "SSM=demo · env 未设 ⇒ demo(依据 SSM)" || bad "SSM=demo · env 未设:$r"
r="$(run_case demo production)";    [[ "$r" == rc:2* ]] && ok "SSM=demo · env=production ⇒ 同样拒绝(模式定下后不许换,双向)" || bad "SSM=demo · env=production:$r"
r="$(run_case deny "")";            [[ "$r" == rc:0\ out:production* && "$r" == *读不到* ]] && ok "SSM 被拒 · env 未设 ⇒ 缺省 production 并说明依据" || bad "SSM 被拒 · env 未设:$r"
r="$(run_case deny demo)";          [[ "$r" == rc:0\ out:demo* ]] && ok "SSM 被拒 · env=demo ⇒ demo(deploy-all 自己已核过 SSM)" || bad "SSM 被拒 · env=demo:$r"
r="$(run_case "" production)";      [[ "$r" == rc:0\ out:production* ]] && ok "SSM 未写 · env=production ⇒ production" || bad "SSM 未写 · env=production:$r"
r="$(run_case none demo)";          [[ "$r" == rc:0\ out:demo* && "$r" == *读不到* ]] && ok "SSM 回字面 None ⇒ 视作读不到,按 env" || bad "SSM 回 None · env=demo:$r"

if [ "$fails" -gt 0 ]; then printf '❌ cognito 模式护栏判据 %s 项失败\n' "$fails"; exit 1; fi
echo "cognito 模式护栏判据全过"
