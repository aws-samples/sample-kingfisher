#!/usr/bin/env bash
# 序 48 —— scripts/lib/execution-regions.sh(放行清单唯一作者)的离线真跑判据:用**假 aws** 驱动每个分支。
#
#     bash infra/test/execution-regions/test_lib.sh      # 退出码 0 = 全过
#
# 🔴 为什么必须有它:放行清单直接变成 IAM `aws:RequestedRegion` 条件。算错一个区 = 平台对那个区的调用静默被拒(症状在很远的下游);
#   算多一个区 = 授了未用之权。并集 / 去重 / 排除 deleted / 候选区校验 / all-enabled / none 每条分支都要真跑过,不许只靠读源码。
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
LIB="$ROOT/scripts/lib/execution-regions.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fails=0; n=0
ok()  { n=$((n+1)); printf '  ✅ %s\n' "$1"; }
bad() { n=$((n+1)); printf '  ❌ %s\n' "$1"; fails=$((fails+1)); }
chk() { # $1=说明 $2=期望 $3=实际
  if [ "$2" = "$3" ]; then ok "$1($3)"; else bad "$1:期望 [$2],实际 [$3]"; fi
}

# ── 假 aws:行为由环境变量驱动;每次调用记进 FAKE_CALLS ──────────────────────────
cat > "$TMP/aws" <<'FAKE'
#!/usr/bin/env bash
svc="$1"; act="${2:-}"
echo "$svc $act $*" >> "${FAKE_CALLS:-/dev/null}"
deny() { echo "An error occurred (AccessDeniedException): not authorized to perform: $svc:$act" >&2; exit 254; }
case "$svc:$act" in
  dynamodb:describe-table) [ "${FAKE_TABLE:-yes}" = "yes" ] && exit 0; echo "ResourceNotFoundException" >&2; exit 254;;
  dynamodb:scan)           [ "${FAKE_SCAN:-ok}" = "deny" ] && deny; printf '%s\n' "${FAKE_SCAN_OUT:-}";;
  ssm:get-parameter)
      case "${FAKE_SSM:-missing}" in
        missing) echo "An error occurred (ParameterNotFound) when calling the GetParameter operation:" >&2; exit 254;;
        deny)    deny;;
        *)       printf '%s\n' "$FAKE_SSM";;
      esac;;
  ssm:put-parameter)       [ "${FAKE_SSM_PUT:-ok}" = "deny" ] && deny; echo '{"Version": 1}';;
  ssm:delete-parameter)    exit 0;;
  ec2:describe-regions)
      # B-114:带 --all-regions 的那条查「未 opt-in」清单(FAKE_EC2_ALL=deny 拒;FAKE_NOT_OPTED_IN 给清单,可为空);不带的仍是「已启用」清单
      case " $* " in
        *" --all-regions "*) [ "${FAKE_EC2_ALL:-ok}" = "deny" ] && deny; printf '%s\n' "${FAKE_NOT_OPTED_IN-af-south-1	me-south-1	eu-south-1}";;
        *)                   [ "${FAKE_EC2:-ok}" = "deny" ] && deny; printf '%s\n' "${FAKE_ENABLED:-ap-southeast-1	eu-central-1	us-east-1	us-west-2}";;
      esac;;
  *) echo "fake aws: 未预期的调用 $svc $act" >&2; exit 99;;
esac
FAKE
chmod +x "$TMP/aws"
export PATH="$TMP:$PATH"
export FAKE_CALLS="$TMP/calls.log"

# 被 source 的 lib 依赖的外壳(与真脚本同名同义)
PROFILE=fake REGION=ap-southeast-1
info() { printf '%s\n' "$*"; }
die()  { printf 'DIE: %s\n' "$*" >&2; exit 1; }   # 与真脚本同形:stderr + exit 1
# shellcheck source=../../../scripts/lib/execution-regions.sh
. "$LIB"

# 子 shell 里跑一例:stdout+stderr 合并捕获,再补一行 rc(die 的 exit 只结束内层 $(),不吞掉 rc 行)
run() { ( set +e; out=$("$@" 2>&1); rc=$?; printf '%s\nrc=%s\n' "$out" "$rc" ); }

echo "== resolve:并集 / 去重 / 排除 deleted / 候选区 =="
r=$(FAKE_TABLE=no FAKE_SSM=missing run exec_regions_resolve)
chk "① 没有注册表、没有候选区 ⇒ 只 home" "ap-southeast-1
rc=0" "$r"
r=$(FAKE_SCAN_OUT=$'eu-central-1\tap-southeast-1\teu-central-1' FAKE_SSM=missing run exec_regions_resolve)
chk "② 注册表两条(含重复、含 home)⇒ 去重排序、home 恒在" "ap-southeast-1,eu-central-1
rc=0" "$r"
r=$(FAKE_SCAN_OUT=$'eu-central-1' FAKE_SSM='ap-northeast-1,us-west-2' run exec_regions_resolve)
chk "③ 注册表 ∪ 候选区 ⇒ 三方并集(home / 在用 / 候选)" "ap-northeast-1,ap-southeast-1,eu-central-1,us-west-2
rc=0" "$r"
r=$(FAKE_SCAN_OUT=$'eu-central-1' FAKE_SSM='ap-northeast-1,us-west-2' run exec_regions_actual)
chk "④ actual 不含候选区(联邦目录只对真有执行环境的区开通)" "ap-southeast-1,eu-central-1
rc=0" "$r"
r=$(FAKE_SCAN_OUT=$'usw2\tbogus\teu-central-1' FAKE_SSM='not-a-region, eu-west-1 ' run exec_regions_resolve)
chk "⑤ 非法形态的区名一律丢弃(注册表脏值 / SSM 手改)、SSM 值两侧空白容忍" "ap-southeast-1,eu-central-1,eu-west-1
rc=0" "$r"
# 🔴 scan 的 --filter-expression 必须排除 deleted(由调用参数断,不信 fake 的输出)
: > "$FAKE_CALLS"; FAKE_SCAN_OUT='' FAKE_SSM=missing exec_regions_resolve >/dev/null 2>&1
if grep -q 'attribute_not_exists(#s) OR #s <> :deleted' "$FAKE_CALLS"; then ok "⑥ 注册表扫描带「排除 status=deleted」过滤(已删除的区不再保留权限)"; else bad "⑥ 注册表扫描没排除 deleted"; fi

echo "== 读失败三态分开:参数不存在 = 空;权限被拒 = die(不许把「读不到」当「没有」)=="
r=$(FAKE_TABLE=no FAKE_SSM=deny run exec_regions_resolve)
case "$r" in *"DIE: 读 SSM"*"rc=1"*) ok "⑦ SSM 读被拒 ⇒ die 而不是当成空";; *) bad "⑦ SSM 读被拒应 die,实得 [$r]";; esac
case "$r" in *"ap-southeast-1"*) bad "⑦b SSM 读被拒却还产出了一份「只有 home」的清单(读不到被当成没有)";; *) ok "⑦b 读被拒时不产出清单";; esac
r=$(FAKE_SCAN=deny FAKE_SSM=missing run exec_regions_resolve)
case "$r" in *"DIE: 读注册表"*"rc=1"*) ok "⑧ 注册表 scan 被拒 ⇒ die";; *) bad "⑧ scan 被拒应 die,实得 [$r]";; esac

echo "== declare:校验 + 持久化 =="
: > "$FAKE_CALLS"
r=$(run exec_regions_candidates_declare "eu-central-1, us-west-2")
case "$r" in *"候选区 = eu-central-1,us-west-2"*"rc=0"*) ok "⑨ 显式清单 ⇒ 校验过、排序去空白、写 SSM";; *) bad "⑨ 显式清单失败:[$r]";; esac
if grep -q 'ssm put-parameter.*--value eu-central-1,us-west-2' "$FAKE_CALLS"; then ok "⑨b put-parameter 的值 = 规范化后的清单"; else bad "⑨b 没写 SSM 或值不对:$(grep ssm "$FAKE_CALLS")"; fi
r=$(run exec_regions_candidates_declare "eu-central-1,ap-south-1")
case "$r" in *"DIE: 候选区 ap-south-1 不在本账号已启用"*"rc=1"*) ok "⑩ 账号未启用的区 ⇒ die 并点名(一个区都不写)";; *) bad "⑩ 未启用区应 die,实得 [$r]";; esac
: > "$FAKE_CALLS"; run exec_regions_candidates_declare "eu-central-1,ap-south-1" >/dev/null
if grep -q 'ssm put-parameter' "$FAKE_CALLS"; then bad "⑩b 校验失败却写了 SSM(应一个区都不写)"; else ok "⑩b 校验失败 ⇒ 未写 SSM"; fi
r=$(run exec_regions_candidates_declare "usw2")
case "$r" in *"DIE: 候选区 \`usw2\` 不是 region 全名"*"rc=1"*) ok "⑪ 缩写 ⇒ die(不收缩写)";; *) bad "⑪ 缩写应 die,实得 [$r]";; esac
r=$(run exec_regions_candidates_declare "*")
case "$r" in *"DIE: 候选区不接受"*"rc=1"*) ok "⑫ * ⇒ die(§12.1 不放宽)";; *) bad "⑫ * 应 die,实得 [$r]";; esac
r=$(run exec_regions_candidates_declare "all-enabled")
case "$r" in *"候选区 = eu-central-1,us-east-1,us-west-2"*"rc=0"*) ok "⑬ all-enabled ⇒ 账号已启用全部区减 home,写成具体清单";; *) bad "⑬ all-enabled 失败:[$r]";; esac
: > "$FAKE_CALLS"
r=$(run exec_regions_candidates_declare "none")
case "$r" in *"已撤销"*"rc=0"*) ok "⑭ none ⇒ 撤销";; *) bad "⑭ none 失败:[$r]";; esac
if grep -q 'ssm delete-parameter' "$FAKE_CALLS"; then ok "⑭b none 真删了 SSM 参数"; else bad "⑭b none 没删 SSM 参数"; fi
r=$(run exec_regions_candidates_declare "ap-southeast-1")
case "$r" in *"只有主控区自己"*"rc=0"*) ok "⑮ 只给 home ⇒ 等同未声明(删参数)";; *) bad "⑮ 只给 home 失败:[$r]";; esac
: > "$FAKE_CALLS"
r=$(FAKE_EC2=deny run exec_regions_candidates_declare "eu-central-1")
case "$r" in *"DIE: 读账号启用的 region 清单失败"*"rc=1"*) ok "⑯ describe-regions 被拒 ⇒ die(不盲写)";; *) bad "⑯ describe-regions 被拒应 die,实得 [$r]";; esac
case "$r" in *"不在本账号已启用"*) bad "⑯b describe-regions 被拒后把错误文本当成了「已启用清单」继续校验";; *) ok "⑯b 读失败即停,不拿错误文本当清单";; esac
if grep -q 'ssm put-parameter' "$FAKE_CALLS"; then bad "⑯c describe-regions 被拒却写了 SSM"; else ok "⑯c describe-regions 被拒 ⇒ 未写 SSM"; fi

echo "== IAM 门探测区:必须不在放行清单里(B-114:账号未 opt-in 区优先、固定备选兜底、都挑不出 ⇒ 空串但调用方不 die)=="
# 🔴 B-114(2026-10-22 测试账号 all-enabled 升级真撞):原来只有 7 个固定备选,all-enabled 把它们全放进清单 ⇒ 空串 ⇒ redeploy die exit 1,
#   而平台栈已经部署完。未 opt-in 的区按定义进不了放行清单(候选区必须已启用、注册表在用区都真部署过),IAM 模拟只拿区名当条件值 ⇒ 首选。
ALL_FIXED='eu-central-1,eu-west-3,sa-east-1,ca-central-1,ap-south-1,eu-north-1,ap-northeast-3'
# 假 aws 缺省给三个未 opt-in 区(af-south-1 / me-south-1 / eu-south-1,排序后 af-south-1 最前)
chk "⑰ 账号有未 opt-in 区 ⇒ 优先挑它(固定备选有空的也不用)" "af-south-1" "$(exec_regions_pick_probe 'ap-southeast-1,us-west-2' 2>/dev/null)"
chk "⑰b B-114 真撞复现:all-enabled 把 7 个固定备选全放进清单 ⇒ 仍挑出未 opt-in 区(修前回空)" "af-south-1" "$(exec_regions_pick_probe "ap-southeast-1,us-west-2,$ALL_FIXED" 2>/dev/null)"
chk "⑰c 未 opt-in 区碰巧在清单里(注册表脏值)⇒ 跳过它挑下一个" "eu-south-1" "$(exec_regions_pick_probe 'ap-southeast-1,af-south-1,me-south-1' 2>/dev/null)"
chk "⑱ 账号没有未 opt-in 区(全开了)⇒ 退回固定备选:清单不含 eu-central-1 ⇒ 挑 eu-central-1" "eu-central-1" "$(FAKE_NOT_OPTED_IN='' exec_regions_pick_probe 'ap-southeast-1,us-west-2' 2>/dev/null)"
chk "⑱b 固定备选顺序:清单含 eu-central-1 ⇒ 挑 eu-west-3" "eu-west-3" "$(FAKE_NOT_OPTED_IN='' exec_regions_pick_probe 'ap-southeast-1,eu-central-1' 2>/dev/null)"
r=$(FAKE_EC2_ALL=deny exec_regions_pick_probe 'ap-southeast-1,us-west-2' 2>"$TMP/probe.err")
chk "⑱c describe-regions --all-regions 被拒 ⇒ 不 die、退回固定备选" "eu-central-1" "$r"
if grep -q '读账号未 opt-in 的 region 清单失败' "$TMP/probe.err" && grep -q 'AccessDeniedException' "$TMP/probe.err"; then ok "⑱d 读失败如实说在 stderr(带 aws 原话),不静默也不污染 stdout"; else bad "⑱d 读失败没说 / 没带原话:$(cat "$TMP/probe.err")"; fi
chk "⑲ 未 opt-in 为空且固定备选全被占 ⇒ 空串(调用方把 none 交给门,不 die)" "" "$(FAKE_NOT_OPTED_IN='' exec_regions_pick_probe "$ALL_FIXED" 2>/dev/null)"

echo "== 接线:三个部署脚本都 source 同一作者,并把并集交给 cdk =="
for s in deploy-all.sh redeploy-platform.sh redeploy-agents.sh; do
  if grep -q 'source "$HERE/lib/execution-regions.sh"' "$ROOT/scripts/$s"; then ok "⑳ $s source 了 lib"; else bad "⑳ $s 没 source lib(第二作者会长回来)"; fi
  if grep -q 'export BGP_EXECUTION_REGIONS="$EXEC_REGIONS"' "$ROOT/scripts/$s"; then ok "㉑ $s 导出 BGP_EXECUTION_REGIONS"; else bad "㉑ $s 没把并集交给 cdk(智能体 / EMR 栈拿不到清单)"; fi
done
if grep -q 'exec_regions_candidates_declare "$EXEC_REGION_CANDIDATES"' "$ROOT/scripts/deploy-all.sh" && grep -q 'exec_regions_candidates_declare "$EXEC_REGION_CANDIDATES"' "$ROOT/scripts/redeploy-platform.sh"; then
  ok "㉒ 安装与放行两条路都收 EXEC_REGION_CANDIDATES"
else bad "㉒ 安装 / 放行缺 EXEC_REGION_CANDIDATES 入口"; fi
if grep -q 'ensure_s3tables_catalog' "$ROOT/scripts/redeploy-platform.sh" && grep -q 'EXEC_REGIONS_ACTUAL//,/ }; do ensure_s3tables_catalog' "$ROOT/scripts/redeploy-platform.sh"; then
  ok "㉓ 3c 联邦目录只对 actual(home ∪ 在用区)开通,不含候选区"
else bad "㉓ 3c 联邦目录循环的清单不是 actual"; fi
if grep -q -- '--probe-region "$IAM_PROBE_REGION"' "$ROOT/scripts/redeploy-platform.sh"; then ok "㉔ IAM 门探测区由 pick_probe 挑(候选区多了不会撞进清单)"; else bad "㉔ IAM 门仍用写死的探测区"; fi
# B-114 接线:挑不出探测区 ⇒ 交 none 给门(不 die);门认 none(any-region 轴只验 home、记未验、退 4)
if grep -q '^  IAM_PROBE_REGION=none$' "$ROOT/scripts/redeploy-platform.sh" && ! grep -q 'die "放行清单覆盖' "$ROOT/scripts/redeploy-platform.sh"; then
  ok "㉔b B-114:redeploy 挑不出探测区 ⇒ 把 none 交给门而不是 die(平台已部署完,不许报成升级失败)"
else bad "㉔b redeploy-platform 挑不出探测区仍 die / 没有 none 兜底"; fi
if grep -q 'PROBE_NONE = "none"' "$ROOT/scripts/iam-simulate-gate.py" && grep -q 'sim_regions_for(axis, a.probe_region, a.home_region, regions)' "$ROOT/scripts/iam-simulate-gate.py" \
   && grep -q 'return verdict_code(bool(bad), bool(blocked), bool(any_region_unverified))' "$ROOT/scripts/iam-simulate-gate.py"; then
  ok "㉔c 门认 --probe-region none,且退出码经 verdict_code(any-region 轴未验 ⇒ 4,不许退 0)"
else bad "㉔c 门不认 none / 退出码没经 verdict_code ⇒ redeploy 的兜底接不上或少验被当成绿"; fi
if grep -q 'process.env.BGP_EXECUTION_REGIONS' "$ROOT/infra/lib/shared/execution-regions.ts"; then ok "㉕ requestedRegionCondition 读第二条通道"; else bad "㉕ infra 侧没读 BGP_EXECUTION_REGIONS"; fi

printf '\n%s\n' "execution-regions lib:$n 条判据,$fails 条失败"
[ "$fails" -eq 0 ]
