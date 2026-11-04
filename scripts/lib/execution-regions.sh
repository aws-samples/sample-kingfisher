#!/usr/bin/env bash
###############################################################################
# scripts/lib/execution-regions.sh —— 控制面「放行清单」(执行 region 列表)的**唯一作者**(序 48)。
#
#   exec_regions_registry                 只读:注册表 bgp-execution-envs 里**未删除**执行环境的 region,逐行(不含 home 自身也无妨,调用方会并)
#   exec_regions_candidates_read          只读:SSM /bgp/wiring/execution-region-candidates 里的**候选区**,逐行;参数不存在 ⇒ 空
#   exec_regions_candidates_declare SPEC  写:校验并持久化候选区(SPEC = 逗号分隔区全名 | all-enabled | none),打印最终清单
#   exec_regions_resolve                  并集(逗号串,去重排序):home ∪ 注册表在用区 ∪ 候选区 —— 这就是要烘进 IAM 与 EXECUTION_REGIONS 的那份
#   exec_regions_actual                   并集(逗号串):home ∪ 注册表在用区(不含候选)—— 给「只对真有执行环境的区做事」的步骤(如联邦目录开通)
#   exec_regions_account_not_opted_in     只读:账号**未 opt-in** 的 region(ec2 describe-regions --all-regions),逐行;读失败 ⇒ 回非 0(不 die,调用方决定)
#   exec_regions_pick_probe LIST          挑一个**不在** LIST 里的区给 IAM 模拟门做 any-region 探测:账号未 opt-in 的区优先,固定备选兜底;都没有 ⇒ 空串
#
# 【为什么存在(序 48,2026-10-19 客户现网法兰克福加区实录)】平台 TaskRole 等 18 处 IAM `aws:RequestedRegion` 条件
#   在 synth 期烘入模板(infra/lib/shared/execution-regions.ts),所以「加一个执行区」= 必须重部署一次控制面「放行」;
#   客户在页面建好区之后还要运维在 CLI 跑 redeploy-platform.sh,这一步既慢又容易忘(忘了的症状是「检测初始化」9 行红)。
#   SPEC §12.0 不许把放行塞进执行环境 CodeBuild(那会让部署角色拿到控制面写权),所以自动化的唯一正路是**把「人决定平台
#   可以碰哪些区」提前**:安装 / 升级时一次性声明若干「候选区」,IAM 条件 = home ∪ 注册表在用区 ∪ 候选区;候选区内加区
#   全在页面完成(新建 → 构建 → 检测初始化 → 启用),不再需要 CLI。候选区持久化在 SSM,之后每次 redeploy 自动带上。
# 【边界 · 不放宽】不接受 `*`;候选区必须是账号里**已启用**的 region 全名;不声明候选区的存量环境行为逐字节不变
#   (并集退化为 home ∪ 注册表,与 2026-09 起的 1b 步同口径)。
#
# 使用约定(source 本文件的一方必须**先**定义好):变量 PROFILE REGION(= home);函数 info() die()。
#   本文件只定义,不执行(不 set -e、不改 cwd)。读注册表 / SSM 失败一律**如实分开**:参数不存在 = 正常空;读不到 = die。
###############################################################################

EXEC_REGION_CANDIDATES_SSM="/bgp/wiring/execution-region-candidates"
EXEC_REGION_NAME_RE='^[a-z]{2}(-[a-z]+)+-[0-9]$'

# 注册表里未删除(status ≠ deleted)的执行环境 region,逐行。表不存在 ⇒ 空(全新账号首装时还没建表)。
# 🔴 `status=deleted` 不算(与产品 data-plane-target.ts 同口径:deleted 是终态,栈已核实删净);deleting / draining 等仍要撤资源 ⇒ 保留。
exec_regions_registry() {
  aws dynamodb describe-table --table-name bgp-execution-envs --profile "$PROFILE" --region "$REGION" >/dev/null 2>&1 || return 0
  local out
  out=$(aws dynamodb scan --table-name bgp-execution-envs --profile "$PROFILE" --region "$REGION" \
          --projection-expression "#r, #s" --expression-attribute-names '{"#r":"region","#s":"status"}' \
          --filter-expression "attribute_not_exists(#s) OR #s <> :deleted" \
          --expression-attribute-values '{":deleted":{"S":"deleted"}}' \
          --query 'Items[].region.S' --output text 2>&1) \
    || die "读注册表 bgp-execution-envs 失败(放行清单推导不下去;上面是 aws 原话):$out"
  printf '%s\n' "$out" | tr '\t' '\n' | grep -E "$EXEC_REGION_NAME_RE" | sort -u || true
}

# SSM 里的候选区,逐行。参数不存在 ⇒ 空(正常:从没声明过);别的失败(无权限 / 网络)⇒ die,不把「读不到」当「没有」。
exec_regions_candidates_read() {
  local out rc=0
  out=$(aws ssm get-parameter --name "$EXEC_REGION_CANDIDATES_SSM" --query Parameter.Value --output text \
          --profile "$PROFILE" --region "$REGION" 2>&1) || rc=$?
  if [ "$rc" -ne 0 ]; then
    case "$out" in *ParameterNotFound*) return 0;; esac
    die "读 SSM $EXEC_REGION_CANDIDATES_SSM 失败(不是「不存在」;上面是 aws 原话):$out"
  fi
  [ "$out" = "None" ] && return 0
  printf '%s\n' "$out" | tr ',' '\n' | sed 's/^ *//;s/ *$//' | grep -E "$EXEC_REGION_NAME_RE" | sort -u || true
}

# 账号里已启用的 region(ec2 describe-regions 的账号级真值),逐行。
exec_regions_account_enabled() {
  local out
  out=$(aws ec2 describe-regions --query 'Regions[].RegionName' --output text --profile "$PROFILE" --region "$REGION" 2>&1) \
    || die "读账号启用的 region 清单失败(ec2:DescribeRegions;上面是 aws 原话):$out"
  printf '%s\n' "$out" | tr '\t' '\n' | grep -E "$EXEC_REGION_NAME_RE" | sort -u || true
}

# 声明候选区并持久化到 SSM。SPEC:
#   · "us-west-2,eu-central-1"  显式清单(区全名;每个都必须是账号里已启用的区,否则拒 —— 预授权一个不存在 / 没启用的区没有意义,多半是拼错)
#   · "all-enabled"             账号里当前已启用的全部 region(解析成**具体清单**写入,之后新启用的区不会自动进来)
#   · "none"                    撤销全部候选区(删参数;下一次 redeploy 后 IAM 收回到 home ∪ 注册表在用区)
# 成功 ⇒ 打印一行 `候选区 = …`;任何校验失败 ⇒ die(一个区都不写)。
exec_regions_candidates_declare() {
  local spec="${1:-}" enabled list r bad=""
  [ -n "$spec" ] || die "exec_regions_candidates_declare: 缺参数(区全名逗号串 | all-enabled | none)"
  if [ "$spec" = "none" ]; then
    aws ssm delete-parameter --name "$EXEC_REGION_CANDIDATES_SSM" --profile "$PROFILE" --region "$REGION" >/dev/null 2>&1 || true
    info "候选区 = (已撤销;本次及以后的放行清单退回 home ∪ 注册表在用区)"
    return 0
  fi
  # 🔴 `v=$(f)` 里 f 的 die 只结束那个子 shell ⇒ 必须 `|| return` 把失败传出来(否则 v 会装进错误文本继续往下走)
  enabled=$(exec_regions_account_enabled) || return 1
  if [ "$spec" = "all-enabled" ]; then
    list="$enabled"
  else
    [[ "$spec" != *'*'* ]] || die "候选区不接受 \`*\`(SPEC §12.1:不放宽,守最小权限);请写具体区全名"
    list=$(printf '%s\n' "$spec" | tr ',' '\n' | sed 's/^ *//;s/ *$//' | grep -v '^$' || true)
    [ -n "$list" ] || die "候选区清单为空:$spec"
    for r in $list; do
      [[ "$r" =~ $EXEC_REGION_NAME_RE ]] || die "候选区 \`$r\` 不是 region 全名(形如 us-west-2;不收缩写)"
      grep -qx "$r" <<<"$enabled" || bad="$bad $r"
    done
    [ -z "$bad" ] || die "候选区$bad 不在本账号已启用的 region 里(拼错?或先在账号层启用该区)。账号已启用:$(printf '%s' "$enabled" | tr '\n' ' ')"
  fi
  list=$(printf '%s\n' "$list" | grep -v "^$REGION$" | sort -u | tr '\n' ',' | sed 's/,$//')
  if [ -z "$list" ]; then
    aws ssm delete-parameter --name "$EXEC_REGION_CANDIDATES_SSM" --profile "$PROFILE" --region "$REGION" >/dev/null 2>&1 || true
    info "候选区 = (只有主控区自己 ⇒ 等同未声明)"
    return 0
  fi
  aws ssm put-parameter --name "$EXEC_REGION_CANDIDATES_SSM" --type String --overwrite --value "$list" \
    --profile "$PROFILE" --region "$REGION" >/dev/null \
    || die "写 SSM $EXEC_REGION_CANDIDATES_SSM 失败"
  info "候选区 = $list(已写 SSM $EXEC_REGION_CANDIDATES_SSM;之后每次放行 / 升级自动带上)"
}

_exec_regions_union() {  # 把 stdin 的逐行 region 与 home 并起来 ⇒ 一行逗号串(去重排序,home 恒在)
  { printf '%s\n' "$REGION"; cat; } | grep -E "$EXEC_REGION_NAME_RE" | sort -u | tr '\n' ',' | sed 's/,$//'
  printf '\n'
}

# 🔴 两个并集函数都**不**把可失败的读取放进管道:管道左侧的 die 只结束那个子 shell,错误文本会被右侧的 grep 过滤掉、
#   管道照常产出一个「只有 home」的清单 —— 那正是「读不到被当成没有」(权限收窄一下,平台对所有执行区的授权就静默消失)。
#   ⇒ 先各自 `v=$(f) || return 1` 取值,失败如实传出(调用方在 set -e 下当场停)。

# home ∪ 注册表在用区(不含候选区)。
exec_regions_actual() {
  local reg
  reg=$(exec_regions_registry) || return 1
  printf '%s\n' "$reg" | _exec_regions_union
}

# home ∪ 注册表在用区 ∪ 候选区 —— 要烘进 IAM 区域条件与 EXECUTION_REGIONS 的那份。
exec_regions_resolve() {
  local reg cand
  reg=$(exec_regions_registry) || return 1
  cand=$(exec_regions_candidates_read) || return 1
  printf '%s\n%s\n' "$reg" "$cand" | _exec_regions_union
}

# 账号**未 opt-in** 的 region(describe-regions --all-regions 才列得出;已启用的区 OptInStatus 是 opt-in-not-required / opted-in),逐行。
# 🔴 读失败回非 0 而不 die:它只用来挑 IAM 模拟门的探测区,挑不到还有固定备选兜底;调用方自己决定怎么说。
exec_regions_account_not_opted_in() {
  local out
  out=$(aws ec2 describe-regions --all-regions --query "Regions[?OptInStatus=='not-opted-in'].RegionName" --output text \
          --profile "$PROFILE" --region "$REGION" 2>&1) || { printf '%s\n' "$out" >&2; return 1; }
  printf '%s\n' "$out" | tr '\t' '\n' | grep -E "$EXEC_REGION_NAME_RE" | sort -u || true
}

# 固定备选探测区(B-114 之前的唯一来源;现在只做兜底)。顺序固定,方便判据与日志对照。
EXEC_REGIONS_PROBE_FALLBACK="eu-central-1 eu-west-3 sa-east-1 ca-central-1 ap-south-1 eu-north-1 ap-northeast-3"

# 给 IAM 模拟门挑 any-region 探测区:必须**不在**放行清单里(否则那几条 any-region 轴等于没验)。
# 🔴 B-114(2026-10-22 测试账号升级真撞):`EXEC_REGION_CANDIDATES=all-enabled` 把账号已启用的全部区放进清单,
#   7 个固定备选区全在其中 ⇒ 挑不出 ⇒ 调用方 die ⇒ 平台栈其实已部署完却被报成失败、页面向导拿不到裁决。
#   根治:探测区**优先从账号未 opt-in 的区里挑** —— 它们按定义不可能进放行清单(候选区必须已启用、注册表在用区都是真部署过的区),
#   而 IAM SimulatePrincipalPolicy 只拿 `aws:RequestedRegion` 当字符串条件值评估,区不必启用;固定备选只做兜底
#   (账号读不出未 opt-in 清单、或已 opt-in 全部区时)。两处都挑不出 ⇒ 回空串,调用方把 any-region 轴标「本账号验不了」而不是 die。
exec_regions_pick_probe() {
  local list=",${1:-}," r pool
  pool=$(exec_regions_account_not_opted_in) \
    || { pool=""; printf '[execution-regions] ⚠️ 读账号未 opt-in 的 region 清单失败(上面是 aws 原话)⇒ IAM 门探测区改从固定备选里挑\n' >&2; }
  for r in $pool $EXEC_REGIONS_PROBE_FALLBACK; do
    case "$list" in *",$r,"*) ;; *) printf '%s' "$r"; return 0;; esac
  done
  printf ''
}
