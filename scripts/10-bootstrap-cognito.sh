#!/usr/bin/env bash
# 在 BgpAuthStack 部署后，幂等创建平台所需的 Cognito 组与初始用户。
#
# 背景：AuthStack 只创建 user pool + client，不创建组/用户（用户口令不应进 IaC）。
# 全新账号若不跑本脚本则无任何用户 → 无法登录。RBAC 依赖以下 4 个组。
#
# 安全：口令【绝不硬编码】。优先读环境变量；未提供则随机生成并仅打印一次。
#   export BGP_ADMIN_PASSWORD=...      # admin       (bgp-admin    超管)
#   export BGP_PM_PASSWORD=...         # pm-tester   (bgp-manager  经理)
#   export BGP_DEV_PASSWORD=...        # rbac-tester (bgp-developer 研发)
#   export BGP_ANALYST_PASSWORD=...    # ops-analyst (bgp-analyst  运营)
#   export BGP_BIZ_PASSWORD=...        # biz-tester  (无组 业务 viewer)
#
# ── 🔴 三路径(2026-08-31 根治「平台在受限账号里装不上」)──────────────────────────
#
# 根因不是"某个 API 报错",而是:**平台把"建组建号"压在【调用者的 IAM 权限】上,而不是压在
# 【部署角色 / 由 AWS 服务代跑】上。** 临时/共用账号(WSParticipantRole、Event Engine 之类)
# 常把 `cognito-idp:Admin*` 整片裁掉 ⇒ 基础设施装得上、**一个能登录的用户都没有**
# (2026-08-29 在一个 workshop 账号实测栽在这里)。
#
# 本脚本因此走三条路,顺序固定(每条都比上一条少依赖一点操作者的权限):
#   路径A **直连**(默认、快、无额外依赖)—— 有权限的账号行为与从前**完全一致**,零回归;
#   路径B **回落 invoke `bgp-cognito-bootstrap`**(由 BgpAuthStack 创建、自带 Cognito 写权限)
#          —— 仅当路径A 撞到 AccessDenied 时启用。口令**只经临时文件 → invoke payload**,
#          不进命令行(免落 shell history / ps)、不落 CFN 模板、不进 CloudWatch。
#   路径C **部署期自愈**(2026-09-17 新增)—— 连 `lambda:InvokeFunction` 都被裁掉的账号
#          (实测某空账号:cognito-idp / lambda / secretsmanager / codebuild / ecs 全拒,
#           只剩 cloudformation / s3 / dynamodb / ssm)⇒ 路径A、B 双断,平台**装得上但没有用户**。
#          做法:口令写进 SSM SecureString → `cdk deploy BgpAuthStack -c bootstrapUsers=1`
#          ⇒ 由 **CloudFormation**(部署角色 ≈ 管理员)在部署期调引导函数,函数读完**自己删掉**那个参数。
#          ⇒ 建组建号从此**完全不依赖操作者的 IAM 权限**,这才是上面那句根因的终点。
#          验证只用 `cloudformation:DescribeStacks`(受限身份也有):输出 CognitoBootstrapRunUsers
#          必须每人 ready、CognitoBootstrapPwParamDeleted 必须 yes。
#
# 🔴 另修一个既有吞错:原来 `admin-create-user ... || true` 把「用户已存在」和「权限被拒」
#    一起吞了,于是权限被裁时错误只在下一行 `admin-set-user-password` 才爆出来,
#    读日志的人会误判成"设口令这个 API 有问题"。现在按错误类型分流。
#
# 用法: ./scripts/10-bootstrap-cognito.sh <aws-profile> [region]
set -euo pipefail
PROFILE="${1:-temp-account}"
REGION="${2:-us-east-1}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
# 🔴 本脚本也会 `cdk deploy BgpAuthStack`:目标区必须与主控区对齐(理由见 infra/lib/shared/home-region.ts)
export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION" CDK_DEFAULT_REGION="$REGION" KF_HOME_REGION="$REGION"
# 路径C 用的 SSM 参数名(口令的**临时**载体;引导函数读完自己删)。默认值与 auth-stack.ts 同源。
PW_PARAM="${BGP_BOOTSTRAP_PW_PARAM:-/bgp/bootstrap-passwords}"

stack_out() {  # $1=OutputKey；缺失则回空串（而非字面量 None）
  local v
  v=$(aws cloudformation describe-stacks --stack-name BgpAuthStack --profile "$PROFILE" --region "$REGION" \
      --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text 2>/dev/null || echo "")
  [ "$v" = "None" ] && v=""
  printf '%s' "$v"
}

POOL="$(stack_out UserPoolId)"
[ -n "$POOL" ] || { echo "[cognito] ERROR: 取不到 BgpAuthStack 的 UserPoolId(栈没部署?)" >&2; exit 1; }
BOOTSTRAP_FN="$(stack_out CognitoBootstrapFnName)"   # -c cognitoBootstrapFn=0 部署时为空
echo "[cognito] user pool: $POOL"

# 🔴 名册必须与 infra/lib/auth-stack.ts 的 BOOTSTRAP_ROSTER 完全一致(同一份合同的两侧)。
USERS=(admin pm-tester rbac-tester ops-analyst biz-tester)
# 🔴 生产上线批次 A:生产模式只建 admin(其余四个是测试账号)—— 与 infra/lib/shared/deploy-mode.ts 的
#   rosterForMode 同一条规则;缺省同样按 production(忘了传参 = 少建测试账号,而不是生产里冒出测试账号)。
# 🔴 序 39 第二刀护栏:**单独重跑**本脚本时核 SSM /bgp/deploy-mode(deploy-all 定下模式后不许换)—— 否则在生产环境上
#   手敲 BGP_DEPLOY_MODE=demo 重跑本脚本就会冒出四个测试账号。规则:SSM 有值 ⇒ 以它为准,env 给了**别的**值 ⇒ 拒绝(exit 2);
#   SSM 读不到(没写 / 无权)⇒ 按 env,缺省 production,并把依据打到 stderr。离线判据 infra/test/cognito-mode-guard/test_mode_guard.sh。
resolve_deploy_mode() {  # stdout = 生效模式;冲突时 exit 2(stderr 已说明)
  local ssm_mode env_mode="${BGP_DEPLOY_MODE:-}"
  ssm_mode="$(aws ssm get-parameter --name /bgp/deploy-mode --query Parameter.Value --output text \
                --profile "$PROFILE" --region "$REGION" 2>/dev/null || true)"
  [ "$ssm_mode" = "None" ] && ssm_mode=""
  if [ -n "$ssm_mode" ]; then
    if [ -n "$env_mode" ] && [ "$env_mode" != "$ssm_mode" ]; then
      echo "[cognito] ❌ 本环境已按 $ssm_mode 模式部署(SSM /bgp/deploy-mode),这次给的是 BGP_DEPLOY_MODE=$env_mode —— 拒绝按别的模式建用户" >&2
      exit 2
    fi
    echo "[cognito] 部署模式 = $ssm_mode(SSM /bgp/deploy-mode)" >&2
    printf '%s' "$ssm_mode"
    return 0
  fi
  echo "[cognito] SSM /bgp/deploy-mode 读不到(未写或无权)⇒ 按 BGP_DEPLOY_MODE=${env_mode:-production}(缺省 production)" >&2
  printf '%s' "${env_mode:-production}"
}
DEPLOY_MODE="$(resolve_deploy_mode)" || exit 2
if [ "$DEPLOY_MODE" != "demo" ]; then USERS=(admin); fi
declare -A GROUP=(  [admin]=bgp-admin           [pm-tester]=bgp-manager      [rbac-tester]=bgp-developer   [ops-analyst]=bgp-analyst      [biz-tester]="" )
declare -A PWVAR=( [admin]=BGP_ADMIN_PASSWORD  [pm-tester]=BGP_PM_PASSWORD  [rbac-tester]=BGP_DEV_PASSWORD [ops-analyst]=BGP_ANALYST_PASSWORD [biz-tester]=BGP_BIZ_PASSWORD )
# 🔴🔴 数组名**绝不能叫 `GROUPS`** —— 它是 bash 的**特殊只读数组**(当前用户的数字 GID 列表),
# 对它赋值会被**静默忽略**、不报错。2026-08-31 实测代价:`"${GROUPS[@]}"` 展开成 `1000 10 190 992 4`
# ⇒ 在真实 user pool 里建出 5 个名叫数字的垃圾组、4 个真 RBAC 组一个没建 ⇒ 4 个用户
# add-to-group 全 `Group not found` ⇒ **admin 能登录但没有 bgp-admin 组 = 没有管理员权限**。
RBAC_GROUPS=(bgp-admin bgp-manager bgp-developer bgp-analyst)
# 自检:万一将来又撞上某个 bash 特殊变量名,在这里当场失败,而不是去线上建出名叫 "1000" 的组。
if [ "${#RBAC_GROUPS[@]}" -ne 4 ] || [ "${RBAC_GROUPS[0]}" != "bgp-admin" ]; then
  echo "[cognito] ERROR: RBAC_GROUPS 数组被污染(撞上 bash 特殊变量?)实际=[${RBAC_GROUPS[*]}]" >&2
  exit 1
fi

gen_pw() { printf 'Bgp%s!%s' "$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom | head -c8)" "$((RANDOM%9000+1000))"; }

# 口令先一次性备齐:两条路径共用同一份,免得回落时又生成一套、把已打印的那套作废。
declare -A PW
for u in "${USERS[@]}"; do
  var="${PWVAR[$u]}"
  pw="${!var:-}"
  if [ -z "$pw" ]; then pw="$(gen_pw)"; echo "  (generated password for $u: $pw  — 请妥善保存)"; fi
  # payload 走 TAB 分隔的 stdin(见下),故拒收含制表符/换行的口令,免得静默截断成弱口令。
  case "$pw" in
    *$'\t'*|*$'\n'*) echo "[cognito] ERROR: $u 的口令含制表符或换行,不支持" >&2; exit 1;;
  esac
  PW[$u]="$pw"
done

# ── 🔴🔴 口令交接:生成它的人负责把它**落盘**(2026-09-16 立)─────────────────────────
# 起因(每次换账号都踩):第 11 步在**子进程**里随机生成口令、只 echo 到日志,而同一次 deploy-all 的
#   第 11.5 步(home seed)要用 admin 口令登录 ⇒ 父脚本读不到 ⇒ **全新账号首装必然在 11.5 失败**
#   (2026-09-16 重建环境时又一次;报错文案还写着「重跑本步」,而重跑还是读不到)。
#   这不是「忘了 export」——是**同一次运行内部的接缝**:值只存在于子进程的内存和日志里。
# 根治:谁生成谁负责交接 —— 写一份 600 权限的 JSON,父脚本与验收层都从它读(单一真值源)。
PW_FILE="${BGP_PW_FILE:-/tmp/bgp-cognito-pw-${PROFILE}.json}"   # 🔴 按 profile 分文件:多账号并存时固定路径会被覆盖
for u in "${USERS[@]}"; do printf '%s\t%s\n' "$u" "${PW[$u]}"; done | python3 -c '
import json, os, sys
pw = {}
for line in sys.stdin:
    line = line.rstrip("\n")
    if line:
        u, p = line.split("\t", 1)
        pw[u] = p
path = sys.argv[1]
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f:
    json.dump(pw, f)
' "$PW_FILE"
echo "[cognito] 口令已写入 $PW_FILE(权限 600;第 11.5 步与验收层从这里读,不再依赖 export)"

ERRF="$(mktemp)"; PAYLOAD=""; OUTF=""
cleanup() { rm -f "$ERRF" ${PAYLOAD:+"$PAYLOAD"} ${OUTF:+"$OUTF"}; }
trap cleanup EXIT

is_denied() { grep -qiE 'AccessDenied|not authorized|explicit deny|AccessDeniedException' "$ERRF"; }

###############################################################################
# 路径A:直连
###############################################################################
DENIED=0
for g in "${RBAC_GROUPS[@]}"; do
  if aws cognito-idp create-group --user-pool-id "$POOL" --group-name "$g" \
       --profile "$PROFILE" --region "$REGION" >/dev/null 2>"$ERRF"; then
    echo "  + group $g"
  elif grep -q "GroupExistsException" "$ERRF"; then
    echo "  = group $g (exists)"
  elif is_denied; then
    DENIED=1; echo "  ! group $g: 权限被拒 → 稍后走引导 Lambda"
  else
    echo "  ! group $g: $(head -c 200 "$ERRF" | tr -d '\n')"
  fi
done

# 直连建一个用户;返回 0=成功 / 1=权限被拒 / 2=其它错误(已打印)
ensure_user_direct() {
  local u="$1" pw="${PW[$1]}" grp="${GROUP[$1]}"
  if ! aws cognito-idp admin-create-user --user-pool-id "$POOL" --username "$u" --message-action SUPPRESS \
       --profile "$PROFILE" --region "$REGION" >/dev/null 2>"$ERRF"; then
    if is_denied; then return 1; fi
    # 「已存在」是正常幂等路径;其它错误才算真错。
    if ! grep -q "UsernameExistsException" "$ERRF"; then
      echo "  ! user $u (create): $(head -c 200 "$ERRF" | tr -d '\n')"; return 2
    fi
  fi
  if ! aws cognito-idp admin-set-user-password --user-pool-id "$POOL" --username "$u" --password "$pw" --permanent \
       --profile "$PROFILE" --region "$REGION" >/dev/null 2>"$ERRF"; then
    if is_denied; then return 1; fi
    echo "  ! user $u (set-password): $(head -c 200 "$ERRF" | tr -d '\n')"; return 2
  fi
  if [ -n "$grp" ]; then
    if ! aws cognito-idp admin-add-user-to-group --user-pool-id "$POOL" --username "$u" --group-name "$grp" \
         --profile "$PROFILE" --region "$REGION" >/dev/null 2>"$ERRF"; then
      if is_denied; then return 1; fi
      echo "  ! user $u (add-to-group): $(head -c 200 "$ERRF" | tr -d '\n')"; return 2
    fi
  fi
  echo "  user $u ready ${grp:+(group $grp)}"
  return 0
}

HARD_ERR=0
for u in "${USERS[@]}"; do
  rc=0; ensure_user_direct "$u" || rc=$?
  case "$rc" in
    0) ;;
    1) DENIED=1; echo "  ! user $u: 权限被拒 → 稍后走引导 Lambda";;
    *) HARD_ERR=1;;
  esac
done

###############################################################################
# 路径B:回落 invoke 引导 Lambda(仅在直连撞 AccessDenied 时)
###############################################################################
if [ "$DENIED" = "1" ]; then
  echo "[cognito] 直连的 cognito-idp:Admin* 被本账号裁掉(受限账号常见)"
  if [ -z "$BOOTSTRAP_FN" ]; then
    echo "[cognito] 且 BgpAuthStack 没有 CognitoBootstrapFnName 输出(可能用 -c cognitoBootstrapFn=0 部署)"
    echo "[cognito] ⇒ 跳过路径B,直接走路径C(部署期自愈)"
    NEED_PATH_C=1
  fi
  if [ "${NEED_PATH_C:-0}" != "1" ]; then
  echo "[cognito] ⇒ 改走引导 Lambda: $BOOTSTRAP_FN(由部署角色代跑,不依赖你的 IAM)"
  PAYLOAD="$(mktemp)"; chmod 600 "$PAYLOAD"
  # 口令经 stdin 传给 python(不进 argv ⇒ 不出现在 ps),由 python 做 JSON 转义。
  for u in "${USERS[@]}"; do printf '%s\t%s\n' "$u" "${PW[$u]}"; done | python3 -c '
import json, sys
pw = {}
for line in sys.stdin:
    line = line.rstrip("\n")
    if not line:
        continue
    u, p = line.split("\t", 1)
    pw[u] = p
with open(sys.argv[1], "w") as f:
    json.dump({"passwords": pw}, f)
' "$PAYLOAD"

  OUTF="$(mktemp)"
  INVOKE_META=""
  if ! INVOKE_META="$(aws lambda invoke --function-name "$BOOTSTRAP_FN" --payload "fileb://$PAYLOAD" \
        --profile "$PROFILE" --region "$REGION" "$OUTF" 2>"$ERRF")"; then
    if is_denied; then
      # 🔴 路径B 的软肋:它仍然压在**操作者**的 `lambda:InvokeFunction` 上。
      echo "[cognito] invoke 也被拒(连 lambda:InvokeFunction 都没有)⇒ 走路径C(部署期自愈)"
      NEED_PATH_C=1
    else
      echo "[cognito] 🔴 invoke 失败: $(head -c 300 "$ERRF" | tr -d '\n')" >&2; exit 1
    fi
  fi
  # 🔴 `aws lambda invoke` 函数内部抛异常时**退出码仍是 0**,只在响应元数据里带 FunctionError。
  if [ "${NEED_PATH_C:-0}" != "1" ] && printf '%s' "$INVOKE_META" | grep -q "FunctionError"; then
    echo "[cognito] 🔴 引导 Lambda 内部报错: $(head -c 400 "$OUTF" | tr -d '\n')" >&2; exit 1
  fi
  [ "${NEED_PATH_C:-0}" = "1" ] || python3 -c '
import json, sys
d = json.load(open(sys.argv[1]))
print("[cognito] 引导 Lambda 结果:")
for k, v in (d.get("groups") or {}).items():
    print("   group %-14s %s" % (k, v))
for k, v in (d.get("users") or {}).items():
    print("   user  %-14s %s" % (k, v))
sys.exit(0 if d.get("ok") else 1)
' "$OUTF" || { echo "[cognito] 🔴 引导 Lambda 判为失败(见上)" >&2; exit 1; }
  fi
fi

###############################################################################
# 路径C:部署期自愈(口令走 SSM,由 CloudFormation 调引导函数)
#
# 🔴 为什么这条路才是终点:路径A 压在 `cognito-idp:Admin*`、路径B 压在 `lambda:InvokeFunction`,
#    **两条都还是操作者的权限**。只有「由部署角色代跑」才与操作者权限彻底脱钩。
# 🔴 没有静默默认值:开关开着而参数不存在 ⇒ 自定义资源**响亮失败**、栈回滚,
#    绝不会出现「装完了但一个用户都没有」——那正是这次要根治的病。
###############################################################################
write_pw_param() {  # $1=输出文件 $2=参数类型
  for u in "${USERS[@]}"; do printf '%s\t%s\n' "$u" "${PW[$u]}"; done | python3 -c '
import json, os, sys
pw = {}
for line in sys.stdin:
    line = line.rstrip("\n")
    if not line:
        continue
    u, p = line.split("\t", 1)
    pw[u] = p
body = {"Name": sys.argv[2], "Value": json.dumps(pw), "Type": sys.argv[3], "Overwrite": True}
fd = os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f:
    json.dump(body, f)
' "$1" "$PW_PARAM" "$2"
}

if [ "${NEED_PATH_C:-0}" = "1" ]; then
  echo "[cognito] 路径C:口令写进 SSM($PW_PARAM),再由部署角色代跑引导函数"
  CLIJSON="$(mktemp)"; chmod 600 "$CLIJSON"
  # 口令经 stdin → python 生成 --cli-input-json 文件:**不进 argv**(免落 ps / history)。
  write_pw_param "$CLIJSON" SecureString
  put_ok=0
  if aws ssm put-parameter --cli-input-json "file://$CLIJSON" --profile "$PROFILE" --region "$REGION" \
       >/dev/null 2>"$ERRF"; then
    put_ok=1
  elif grep -qiE 'kms|AccessDenied|not authorized' "$ERRF"; then
    # SecureString 要 kms:Encrypt,受限身份可能没有。退回明文 String 并**响亮说明**:
    # 它只存活一次部署,引导函数用完即删(删除结果回报到 CFN 输出,不许悄悄留着)。
    echo "[cognito] ⚠️ SecureString 写不了($(head -c 160 "$ERRF" | tr -d '\n'))⇒ 退回 String(明文,函数用完即删)" >&2
    write_pw_param "$CLIJSON" String
    if aws ssm put-parameter --cli-input-json "file://$CLIJSON" --profile "$PROFILE" --region "$REGION" \
         >/dev/null 2>"$ERRF"; then put_ok=1; fi
  fi
  rm -f "$CLIJSON"
  if [ "$put_ok" != "1" ]; then
    echo "[cognito] 🔴 连 ssm:PutParameter 都被拒:$(head -c 240 "$ERRF" | tr -d '\n')" >&2
    echo "          ⇒ 这个身份没有任何可用通道建用户:请账号管理员补 ssm:PutParameter(或 lambda:InvokeFunction)。" >&2
    exit 1
  fi

  echo "[cognito] ⇒ cdk deploy BgpAuthStack -c bootstrapUsers=1(CloudFormation 代跑引导函数)"
  ( cd "$ROOT/infra" && npx cdk deploy BgpAuthStack --require-approval never --profile "$PROFILE" \
      -c bootstrapUsers=1 -c bootstrapPwParam="$PW_PARAM" ) || {
    echo "[cognito] 🔴 路径C 部署失败 —— 看 CFN 事件里 CognitoBootstrapRun 的 Reason(它会点名缺什么)" >&2
    exit 1
  }

  # 验证只用 cloudformation:DescribeStacks(受限身份也有这一条)
  RUN_USERS="$(stack_out CognitoBootstrapRunUsers)"
  PW_DELETED="$(stack_out CognitoBootstrapPwParamDeleted)"
  echo "[cognito] 路径C 结果:users=$RUN_USERS pwParamDeleted=$PW_DELETED"
  for u in "${USERS[@]}"; do
    case "$RUN_USERS" in
      *"$u"*) ;;
      *) echo "[cognito] 🔴 路径C 输出里没有用户 $u —— 引导没覆盖全名册" >&2; exit 1;;
    esac
  done
  # 🔴 真值只有一个:去 SSM 看那个参数还在不在。**不能只信 CFN 输出** ——
  #   幂等重跑时自定义资源属性没变 ⇒ CFN 压根不再调函数 ⇒ 输出还是上一次那句 yes,
  #   而本次刚写进去的口令参数**还留在账号里**(第一版就是这个洞:输出说删了,其实没删)。
  if aws ssm get-parameter --name "$PW_PARAM" --profile "$PROFILE" --region "$REGION" >/dev/null 2>&1; then
    echo "[cognito] 口令参数仍在(本次是幂等重跑,函数没被再调一次)⇒ 由脚本自己删掉"
    if aws ssm delete-parameter --name "$PW_PARAM" --profile "$PROFILE" --region "$REGION" >/dev/null 2>"$ERRF"; then
      echo "[cognito] ✓ 已删除 $PW_PARAM"
    else
      echo "[cognito] 🔴 删不掉 $PW_PARAM($(head -c 160 "$ERRF" | tr -d '\n'))—— 口令留在账号里了,请立刻手工删除" >&2
      exit 1
    fi
  else
    echo "[cognito] ✓ 口令参数已不在 SSM(函数用完即删;CFN 输出记的是 $PW_DELETED)"
  fi
  # 走了路径C 就不再拿路径A 的硬错误判死(那些错本身就是「权限被拒」的连带)
  HARD_ERR=0
fi

[ "$HARD_ERR" = "0" ] || { echo "[cognito] 🔴 有非权限类错误(见上)" >&2; exit 1; }
echo "[cognito] done."
