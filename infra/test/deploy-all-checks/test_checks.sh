#!/usr/bin/env bash
# deploy-all.sh 里两个**体检函数**的离线真跑替身(prod-only-layers 的 harness)。
#
# 🔴 为什么必须有它(2026-09-17 抓到的两个真缺陷):
#   ① `wiring_check` 曾经 **fail-open**:`2>/dev/null` + 「查不到就 return 0」把三件事压成一件
#      —— 接线正常 / 真没有 TaskDef / **我没权限看**。受限账号里它印一句「跳过体检」然后报全绿。
#   ② `mechanism_check` 曾把「权限被拒」**误诊**成「对象不存在」⇒ 白补发一次栈 + 记一笔假失败。
# 这两种坏法都只在真部署里出现,所以这里把函数抽出来、用**假 aws** 驱动每条分支真跑一遍。
#
# 跑法:bash infra/test/deploy-all-checks/test_checks.sh
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
SRC="$ROOT/scripts/deploy-all.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fails=0
ok()   { printf '  ✅ %s\n' "$1"; }
bad()  { printf '  ❌ %s\n' "$1"; fails=$((fails+1)); }

# ── 把三个函数从 deploy-all.sh 里抽出来(名字写死 = 抽错就报,不静默)────────────
extract() {  # $1=函数名
  awk -v fn="$1" 'BEGIN{p=0} $0 ~ "^"fn"\\(\\) \\{" {p=1} p{print} p && /^}$/{exit}' "$SRC"
}
for fn in cfn_has_resource wiring_check mechanism_check heal_cdk_empty_assets; do
  extract "$fn" > "$TMP/$fn.sh"
  [ -s "$TMP/$fn.sh" ] || { bad "抽不出函数 $fn(deploy-all.sh 改名了?)"; }
done

# ── 假 aws:行为由环境变量驱动 ────────────────────────────────────────────────
cat > "$TMP/aws" <<'FAKE'
#!/usr/bin/env bash
svc="$1"; act="${2:-}"
deny() { echo "An error occurred (AccessDeniedException): not authorized to perform: $svc:$act with an explicit deny in a service control policy" >&2; exit 254; }
case "$svc:$act" in
  ecs:list-task-definitions)   [ "${FAKE_ECS:-ok}" = "deny" ] && deny; [ "${FAKE_ECS:-ok}" = "empty" ] && { echo ""; exit 0; }; echo "arn:aws:ecs:x:1:task-definition/BgpPlatformStackBgpServiceTaskDef123:7";;
  ecs:describe-task-definition)
      [ "${FAKE_ECS:-ok}" = "deny" ] && deny
      # 按被问的那个 env 名回**对应**的值(一律回同一个值 = 假环境自己造出 4 条假红)
      if [ -n "${FAKE_ENV_VALUE:-}" ]; then echo "$FAKE_ENV_VALUE"; exit 0; fi
      case "$*" in
        *OPENMETADATA_URL*)     echo "https://om.example";;
        *GENBI_BACKEND*)        echo "agentcore";;
        *GENBI_RUNTIME_ARN*)    echo "arn:aws:bedrock-agentcore:x:1:runtime/genbi-abc";;
        *NETADVISOR_RUNTIME_ARN*) echo "arn:aws:bedrock-agentcore:x:1:runtime/net-abc";;
        *PARAMADVISOR_RUNTIME_ARN*) echo "arn:aws:bedrock-agentcore:x:1:runtime/param-abc";;
        *) echo "";;
      esac;;
  lambda:get-function-configuration) [ "${FAKE_LAMBDA:-ok}" = "deny" ] && deny; echo "{}";;
  codebuild:batch-get-projects) [ "${FAKE_CB:-ok}" = "deny" ] && deny; echo "bgp-exec-env-deploy";;
  cloudformation:describe-stack-resources)
      [ "${FAKE_CFN:-ok}" = "deny" ] && deny
      case "$*" in
        *AWS::Lambda::Function*)   [ "${FAKE_CFN_LAMBDA:-yes}" = "yes" ] && echo "bgp-exec-env-broker" || echo "";;
        *AWS::CodeBuild::Project*) [ "${FAKE_CFN_CB:-yes}" = "yes" ] && echo "bgp-exec-env-deploy" || echo "";;
        *) echo "";;
      esac;;
  s3api:head-object)
      echo "head $*" >> "${FAKE_CALLS:-/dev/null}"
      [ "${FAKE_HEAD:-missing}" = "missing" ] && { echo "An error occurred (404) when calling the HeadObject operation: Not Found" >&2; exit 254; }
      echo "4096";;
  s3:cp) echo "cp $*" >> "${FAKE_CALLS:-/dev/null}";;
  *) echo "";;
esac
exit 0
FAKE
chmod +x "$TMP/aws"
export PATH="$TMP:$PATH"

# 被抽出来的函数依赖的外壳
PROFILE=fake REGION=us-east-1
info() { printf '   %s\n' "$*"; }

run_wiring() { ( set +e; WIRING_BLIND=0; . "$TMP/cfn_has_resource.sh"; . "$TMP/wiring_check.sh"; wiring_check quiet >/dev/null 2>&1; rc=$?; echo "$rc:$WIRING_BLIND" ); }
run_mech()   { ( set +e; . "$TMP/cfn_has_resource.sh"; . "$TMP/mechanism_check.sh"; mechanism_check quiet >/dev/null 2>&1; echo "$?" ); }

echo "== wiring_check 三态 =="
r=$(FAKE_ECS=ok run_wiring);    [ "$r" = "0:0" ] && ok "接线正常 ⇒ rc=0 且 BLIND=0($r)"                 || bad "接线正常应 0:0,实得 $r"
r=$(FAKE_ECS=deny run_wiring);  [ "$r" = "0:1" ] && ok "🔴 权限被拒 ⇒ **BLIND=1**(不许冒充过关)($r)"    || bad "权限被拒应 0:1,实得 $r"
r=$(FAKE_ECS=empty run_wiring); [ "$r" = "0:0" ] && ok "真没有 TaskDef ⇒ rc=0 且 BLIND=0($r)"           || bad "空清单应 0:0,实得 $r"
r=$(FAKE_ECS=ok FAKE_ENV_VALUE=inprocess run_wiring); [ "${r%%:*}" != "0" ] && ok "接线被冲回 ⇒ rc>0($r)" || bad "接线异常应 rc>0,实得 $r"

echo "== mechanism_check:权限被拒不许误诊成「对象不存在」 =="
r=$(FAKE_LAMBDA=ok FAKE_CB=ok run_mech);                            [ "$r" = "0" ] && ok "直连都能读 ⇒ 0"                       || bad "应 0,实得 $r"
r=$(FAKE_LAMBDA=deny FAKE_CB=deny FAKE_CFN_LAMBDA=yes FAKE_CFN_CB=yes run_mech); [ "$r" = "0" ] && ok "🔴 直连被拒但栈资源清单坐实 ⇒ 0" || bad "有 CFN 兜底应 0,实得 $r"
r=$(FAKE_LAMBDA=deny FAKE_CB=deny FAKE_CFN_LAMBDA=no FAKE_CFN_CB=no run_mech);   [ "$r" = "2" ] && ok "真的两样都没有 ⇒ 2(仍要报)" || bad "都缺应 2,实得 $r"
r=$(FAKE_LAMBDA=deny FAKE_CB=ok FAKE_CFN_LAMBDA=no run_mech);       [ "$r" = "1" ] && ok "只缺 broker ⇒ 1"                      || bad "只缺 broker 应 1,实得 $r"

echo "== iam_gate_verdict 三态(redeploy-platform.sh)=="
RPSRC="$ROOT/scripts/redeploy-platform.sh"
awk 'BEGIN{p=0} /^iam_gate_verdict\(\) \{/ {p=1} p{print} p && /^}$/{exit}' "$RPSRC" > "$TMP/iam_gate_verdict.sh"
[ -s "$TMP/iam_gate_verdict.sh" ] || bad "抽不出 iam_gate_verdict(redeploy-platform.sh 改名了?)"
verdict() { ( set +e; . "$TMP/iam_gate_verdict.sh"; iam_gate_verdict "$1"; echo "$?" ); }
r=$(verdict 0); [ "$r" = "0" ] && ok "门全 allowed(0)⇒ 绿(0)"                            || bad "0 应判 0,实得 $r"
r=$(verdict 1); [ "$r" = "1" ] && ok "🔴 真有 deny(1)⇒ 产品红(1)"                        || bad "1 应判 1,实得 $r"
r=$(verdict 2); [ "$r" = "3" ] && ok "🔴 环境/权限错误(2)⇒ **门未执行**(3),不许当成产品红" || bad "2 应判 3,实得 $r"

echo "== heal_cdk_empty_assets:资产按**目的地自己的区**校验与读写(主控区 ≠ us-east-1 时 WAF 资产在 us-east-1)=="
# 🔴 2026-10-10 第二账号 production 彩排(主控区 us-west-2)实撞:BgpWafStack 的 7 个合法资产在 us-east-1 的
#   bootstrap 桶,自愈却按「桶必须以 -<账号>-<主控区> 结尾」把它们全拒 ⇒ 部署第 3 分钟停下。
FR="$TMP/fakeroot"; mkdir -p "$FR/infra/cdk.out/asset.aaa" "$FR/infra/cdk.out/asset.bbb" "$FR/infra/cdk.out/asset.ccc"
for d in aaa bbb ccc; do echo "x" > "$FR/infra/cdk.out/asset.$d/index.js"; done
mk_assets() {  # $1 = 第三个资产的桶(用来造「外部账号」负向)
  cat > "$FR/infra/cdk.out/BgpPlatformStack.assets.json" <<JSON
{"files":{
 "a":{"source":{"path":"asset.aaa","packaging":"zip"},"destinations":{"d":{"bucketName":"cdk-hnb659fds-assets-\${AWS::AccountId}-us-west-2","objectKey":"aaa.zip","region":"us-west-2"}}}}}
JSON
  cat > "$FR/infra/cdk.out/BgpWafStack.assets.json" <<JSON
{"files":{
 "b":{"source":{"path":"asset.bbb","packaging":"zip"},"destinations":{"d":{"bucketName":"cdk-hnb659fds-assets-\${AWS::AccountId}-us-east-1","objectKey":"bbb.zip","region":"us-east-1"}}},
 "c":{"source":{"path":"asset.ccc","packaging":"zip"},"destinations":{"d":{"bucketName":"$1","objectKey":"ccc.zip","region":"us-east-1"}}}}}
JSON
}
run_heal() {  # $1 = BOOTSTRAP_REGIONS;回 rc
  ( set +e; ROOT="$FR" ACCOUNT=111111111111 REGION=us-west-2 BOOTSTRAP_REGIONS="$1" FAKE_CALLS="$TMP/calls"
    export FAKE_CALLS; . "$TMP/heal_cdk_empty_assets.sh"; heal_cdk_empty_assets --no-synth >"$TMP/heal.out" 2>&1; echo "$?" )
}
OWN_E1='cdk-hnb659fds-assets-${AWS::AccountId}-us-east-1'
mk_assets "$OWN_E1"; : > "$TMP/calls"
r=$(run_heal "us-west-2 us-east-1")
if [ "$r" = "0" ] \
   && grep -q 'cp .*s3://cdk-hnb659fds-assets-111111111111-us-east-1/bbb.zip .*--region us-east-1' "$TMP/calls" \
   && grep -q 'cp .*s3://cdk-hnb659fds-assets-111111111111-us-west-2/aaa.zip .*--region us-west-2' "$TMP/calls" \
   && grep -q 'head .*--bucket cdk-hnb659fds-assets-111111111111-us-east-1 .*--region us-east-1' "$TMP/calls"; then
  ok "主控区 us-west-2 + WAF 区 us-east-1 ⇒ 两个区的资产都预置,且各自用**自己的区**读写(rc=$r)"
else bad "两区资产应各按自己的区预置 rc=0,实得 rc=$r;调用=$(tr '\n' '|' < "$TMP/calls")"; fi
: > "$TMP/calls"
r=$(run_heal "us-west-2")
[ "$r" = "1" ] && grep -q "不在本次 bootstrap 的区里" "$TMP/heal.out" && ! grep -q "us-east-1" "$TMP/calls" \
  && ok "🔴 us-east-1 不在 bootstrap 清单里 ⇒ 拒绝且**一个请求都不往那个区发**(rc=$r)" \
  || bad "清单外的区应拒绝且零请求,实得 rc=$r;调用=$(tr '\n' '|' < "$TMP/calls")"
mk_assets "cdk-hnb659fds-assets-999999999999-us-east-1"; : > "$TMP/calls"
r=$(run_heal "us-west-2 us-east-1")
[ "$r" = "1" ] && grep -q "不属于本账号" "$TMP/heal.out" && ! grep -q "999999999999" "$TMP/calls" \
  && ok "🔴 别的账号的桶 ⇒ 拒绝且**零请求打到别人账号**(账号护栏不因按区放行而变松)(rc=$r)" \
  || bad "外部账号桶应拒绝且零请求,实得 rc=$r;调用=$(tr '\n' '|' < "$TMP/calls")"
SH_WAF=$(sed -n 's/^CLOUDFRONT_WAF_REGION="\([a-z0-9-]*\)"$/\1/p' "$SRC")
TS_WAF=$(sed -n 's/^export const CLOUDFRONT_WAF_REGION = "\([a-z0-9-]*\)";$/\1/p' "$ROOT/infra/lib/waf-stack.ts")
[ -n "$SH_WAF" ] && [ "$SH_WAF" = "$TS_WAF" ] && grep -q 'for _r in $BOOTSTRAP_REGIONS' "$SRC" \
  && ok "WAF 区单一真值:deploy-all.sh($SH_WAF)== waf-stack.ts($TS_WAF),bootstrap 走同一张清单" \
  || bad "WAF 区两处不一致或 bootstrap 没走清单:sh='$SH_WAF' ts='$TS_WAF'"

echo "== 主控区对齐:部署机环境里残留 AWS_REGION 不许把控制面带进别的区 =="
# 🔴 2026-10-10 第二账号 production 彩排实撞:shell 里 AWS_REGION=us-east-1,deploy-all 要 us-west-2,
#   CDK CLI 让 AWS_REGION 覆盖了 CDK_DEFAULT_REGION ⇒ 11 个控制面栈全建进 us-east-1。
for f in deploy-all.sh redeploy-platform.sh 10-bootstrap-cognito.sh; do
  line=$(grep -E '^export AWS_REGION="\$REGION" AWS_DEFAULT_REGION="\$REGION"' "$ROOT/scripts/$f" | head -1)
  got=$( env AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1 REGION=us-west-2 bash -c "$line; echo \$AWS_REGION/\$AWS_DEFAULT_REGION/\$KF_HOME_REGION" 2>/dev/null )
  [ -n "$line" ] && [ "$got" = "us-west-2/us-west-2/us-west-2" ] \
    && ok "$f:环境里残留 us-east-1 ⇒ 对齐成主控区 us-west-2(AWS_REGION / AWS_DEFAULT_REGION / KF_HOME_REGION)" \
    || bad "$f 没把区对齐到主控区:line='$line' got='$got'"
done
APP="$ROOT/infra/bin/app.ts"
g=$(grep -n 'homeRegionMismatch(env.region, process.env.KF_HOME_REGION)' "$APP" | head -1 | cut -d: -f1)
n=$(grep -nE '^\s*(new [A-Z][A-Za-z]*Stack\(|createExecEnvStackGroup\()' "$APP" | head -1 | cut -d: -f1)
[ -n "$g" ] && [ -n "$n" ] && [ "$g" -lt "$n" ] \
  && ok "app.ts 在实例化第一个栈(第 $n 行)之前做主控区比对(第 $g 行)" \
  || bad "app.ts 主控区比对缺失或晚于第一个栈:guard=$g first-stack=$n"
r=$(cd "$ROOT/infra" && env -u AWS_PROFILE npx ts-node --prefer-ts-exts -e '
const { homeRegionMismatch: f } = require("./lib/shared/home-region");
const cases = [[f("us-east-1","us-west-2") !== null, "错区⇒拒"], [f("us-west-2","us-west-2") === null, "同区⇒放"],
  [f("us-east-1", undefined) === null, "没声明⇒不判"], [f(undefined,"us-west-2") !== null, "没解析出⇒拒"]];
const bad = cases.filter(c => !c[0]).map(c => c[1]); console.log(bad.length ? "BAD:" + bad.join(",") : "OK");' 2>&1 | tail -1)
[ "$r" = "OK" ] && ok "homeRegionMismatch 四态:错区拒 / 同区放 / 没声明不判 / 没解析出拒" || bad "homeRegionMismatch 判错:$r"

echo
if [ "$fails" = "0" ]; then echo "全部通过(20 例)"; else echo "有 $fails 例失败"; fi
exit "$fails"
