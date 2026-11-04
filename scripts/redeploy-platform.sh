#!/usr/bin/env bash
###############################################################################
# redeploy-platform.sh — 安全重部署平台栈的【唯一入口】。
#
# 为什么存在(反复咬人的回归元凶):
#   平台栈的 AI 接线(OM URL / genbi / net·param advisor 的 backend + runtime-arn +
#   memory-id)靠命令行 -c 传入,默认值是"关闭/空"。任何一次裸
#   `cdk deploy BgpPlatformStack`(不带这一长串 -c)都会把接线【静默冲回默认空值】,
#   导致 OM 页面报错、GenBI skill 不命中、网络/参数顾问退回进程内 —— 而页面不会白屏,
#   坏得悄无声息,直到有人手点到那一页才发现。这是"修一个 bug 又冒出别的问题"的根源之一。
#
# 本脚本根治:
#   ① 从 CloudFormation 输出【动态读取】真实 ARN/ID,零硬编码账号/区域/ARN;
#   ② 校验每个值非空(读不到就报错退出,而不是带着空值静默部署);
#   ③ 把这些"期望接线"幂等写入 SSM(/bgp/wiring/*),作为持久事实源 —— 供
#      infra/bin/app.ts 在任何后续【裸部署】时自愈补齐(见该文件 wiring 自愈段);
#   ④ 组装完整 -c 参数部署平台栈。
#
# 以后重部署平台栈【只调本脚本】,不要再裸 `cdk deploy BgpPlatformStack`。
#
#   ./scripts/redeploy-platform.sh <aws-profile> [region] [-- 额外的 cdk 参数]
###############################################################################
set -euo pipefail

# 🔴🔴 **不许把旗标当成 profile 名**(2026-09-22 我自己踩:写成 `--profile temp-account`
#   ⇒ `PROFILE="--profile"` / `REGION="temp-account"`,于是 aws 调用整个畸形,
#   而上层看到的症状是一句「查不了经典 MWAA 栈的状态」—— 离根因很远,白烧一轮)。
#   本脚本收的是**位置参数**;以 `-` 开头的第一个参数一律当成用法错误,当场停。
if [[ "${1:-}" == -* && "${1:-}" != "--help" ]]; then
  printf '\033[1;31m✗ 用法错误:本脚本收**位置参数**,不是旗标\033[0m\n'
  printf '   你传的是:%s %s\n' "${1:-}" "${2:-}"
  printf '   正确写法:bash %s <profile> [region]\n' "$0"
  printf '   例:      bash %s temp-account us-east-1\n' "$0"
  exit 2
fi
PROFILE="${1:-temp-account}"
REGION="${2:-us-east-1}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
export AWS_PROFILE="$PROFILE"          # 关键:供 app.ts 的 SSM 自愈读取继承 profile
# 🔴 生产上线批次 A:部署模式与首装一致 —— 从 SSM /bgp/deploy-mode 读(deploy-all 写的);
#   显式给了 BGP_DEPLOY_MODE 且与 SSM 不同 ⇒ 拒(不许中途换模式);都没有(旧环境)⇒ 按 production
#   (缺省规则同 infra/lib/shared/deploy-mode.ts)并写回 SSM。连带部署的 AuthStack 据此决定初始用户名单。
SSM_MODE=$(aws ssm get-parameter --name /bgp/deploy-mode --query Parameter.Value --output text --profile "$PROFILE" --region "$REGION" 2>/dev/null || true)
[ "$SSM_MODE" = "None" ] && SSM_MODE=""
if [ -n "${BGP_DEPLOY_MODE:-}" ] && [ -n "$SSM_MODE" ] && [ "$BGP_DEPLOY_MODE" != "$SSM_MODE" ]; then
  printf '\033[1;31m✗ 本环境部署模式是 %s(SSM /bgp/deploy-mode),这次给的是 %s —— 拒绝中途换模式\033[0m\n' "$SSM_MODE" "$BGP_DEPLOY_MODE"
  exit 2
fi
export BGP_DEPLOY_MODE="${BGP_DEPLOY_MODE:-${SSM_MODE:-production}}"
case "$BGP_DEPLOY_MODE" in production|demo) ;; *) printf '✗ BGP_DEPLOY_MODE 非法:%s\n' "$BGP_DEPLOY_MODE"; exit 2 ;; esac
if [ -z "$SSM_MODE" ]; then
  aws ssm put-parameter --name /bgp/deploy-mode --type String --overwrite --value "$BGP_DEPLOY_MODE" --profile "$PROFILE" --region "$REGION" >/dev/null || true
fi
echo "   部署模式 = $BGP_DEPLOY_MODE(SSM /bgp/deploy-mode${SSM_MODE:+ 已有})"
# 经典 MWAA 栈还在就别更新平台栈(会 UPDATE_ROLLBACK;理由见该脚本头)
bash "$HERE/preflight-classic-mwaa.sh" "$PROFILE" "$REGION" || exit 1
export CDK_DEFAULT_REGION="$REGION"
# 🔴 CDK CLI 解析目标区时 AWS_REGION / AWS_DEFAULT_REGION 优先于 CDK_DEFAULT_REGION(会覆盖它)⇒ 必须一起对齐,
#   否则部署机环境里残留的 AWS_REGION 会把整套控制面静默建进别的区(2026-10-10 第二账号彩排实撞)。
#   KF_HOME_REGION 交给 infra/bin/app.ts 做 synth 期比对(不一致 ⇒ 一个栈都不部署)。
export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION" KF_HOME_REGION="$REGION"

info() { printf '   %s\n' "$*"; }
say()  { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }
out()  { aws cloudformation describe-stacks --stack-name "$1" --profile "$PROFILE" --region "$REGION" \
           --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text 2>/dev/null; }

# 三个 AI agent 栈的映射表:单一事实源 scripts/lib/agentcore-agents.sh(deploy-all / redeploy-agents 同一份;
#   原来这里抄了三张表,2026-10-14 收口)。🔴 本脚本只**读**智能体栈的输出做平台接线,
#   **不重建**智能体镜像、不部署智能体栈 —— 那是 redeploy-agents.sh 的事(升级时两个脚本都要跑)。
# shellcheck source=lib/agentcore-agents.sh
source "$HERE/lib/agentcore-agents.sh"
source "$HERE/lib/s3tables-catalog.sh"   # S3 Tables 联邦目录 s3tablescatalog 的安装 / 升级期唯一作者(第 3c 步)
source "$HERE/lib/execution-regions.sh"  # 放行清单(home ∪ 注册表在用区 ∪ 候选区)的唯一作者(第 1b 步)

# 默认大模型按主控区账号真值选(与 deploy-all 同一个作者)
if [ -z "${BEDROCK_MODEL_ID:-}" ]; then
  BEDROCK_MODEL_ID=$(bash "$HERE/resolve-home-model.sh" "$PROFILE" "$REGION") \
    || die "主控区没有能用的默认大模型(见上)"
fi
export BEDROCK_MODEL_ID
info "默认大模型(主控区 $REGION 账号真值,真调用通过)= $BEDROCK_MODEL_ID"

say "1) 从 CloudFormation 读取真实接线(零硬编码)"
OM_URL=$(out BgpOmServiceStack OpenMetadataCdnUrl)
[ -n "$OM_URL" ] && [ "$OM_URL" != "None" ] \
  || die "OpenMetadata URL 读取失败(BgpOmServiceStack 未部署?)。"
info "OM: $OM_URL"

declare -A RT_ARN MEM_ID
for a in genbi netadvisor paramadvisor; do
  RT_ARN[$a]=$(out "${A_STACK[$a]}" "${A_RT_OUT[$a]}")
  MEM_ID[$a]=$(out "${A_STACK[$a]}" "${A_MEM_OUT[$a]}")
  { [ -n "${RT_ARN[$a]}" ] && [ "${RT_ARN[$a]}" != "None" ]; } \
    || die "$a Runtime ARN 读取失败(${A_STACK[$a]} 未创建 Runtime?先跑 deploy-all.sh 或 -c $a-runtime=1)。"
  { [ -n "${MEM_ID[$a]}" ] && [ "${MEM_ID[$a]}" != "None" ]; } \
    || die "$a Memory id 读取失败(${A_STACK[$a]})。"
  info "$a: runtime=${RT_ARN[$a]}  memory=${MEM_ID[$a]}"
done

# ── 1b) 执行环境 region 列表(🔴 真跑撞出:忘了传 = 新 region 静默无权)──
# 平台 IAM 的 `aws:RequestedRegion` 条件是**部署时静态**写进策略的(切片 f):不传
# `-c execution-regions=` 就只放行 home,于是注册了第二 region、栈也真建好了,平台去探活/下推
# 却被 AccessDenied —— 实测就这么卡住过一轮(s3tables:ListTableBuckets on us-west-2 被拒)。
# ⇒ **从注册表自己推导**,不靠人记:region 集合 = home ∪ 所有**未删除** target 的 region。
#   这与本脚本的存在理由一致(接线的真值从活环境读,而不是靠命令行记忆)。
# 🔴 `status=deleted` 不算(与产品 data-plane-target.ts 同一口径:deleted 是终态,栈已核实删净)。
#   原来连已删除的也算 ⇒ 平台 TaskRole 对一个已经没有执行环境的区**一直保留权限**,IAM 门也一直在验它
#   (2026-10-10 弃置 tgt_apn1_a 后 redeploy 实见 regions 仍含 ap-northeast-1)。deleting / draining 等仍要撤资源 ⇒ 保留。
# ──(2026-10-19 客户现网法兰克福加区实录):**候选区预授权**,放行从「每加一区跑一次本脚本」变成「零次」──
#   并集 = home ∪ 注册表在用区 ∪ **候选区**(SSM /bgp/wiring/execution-region-candidates,安装 / 升级 / 本脚本任一次
#   用环境变量 EXEC_REGION_CANDIDATES 声明一次就持久化)。候选区内在页面新建执行区:构建完直接「检测初始化」→「启用」,
#   不必再跑本脚本。推导 / 校验 / 持久化只有一个作者 scripts/lib/execution-regions.sh(deploy-all / redeploy-agents 同用)。
#   不声明候选区 ⇒ 并集退化为原来的 home ∪ 注册表,行为逐字节不变。不放宽为 `*`。
#     EXEC_REGION_CANDIDATES="eu-central-1,ap-northeast-1"   显式清单(必须是账号已启用的区全名)
#     EXEC_REGION_CANDIDATES=all-enabled                     账号当前已启用的全部 region(解析成具体清单写入)
#     EXEC_REGION_CANDIDATES=none                            撤销候选区(下一次放行 IAM 收回到 home ∪ 注册表在用区)
say "1b) 推导放行清单 = home ∪ 注册表在用区 ∪ 候选区(不靠人传 -c;单一作者 scripts/lib/execution-regions.sh)"
if [ -n "${EXEC_REGION_CANDIDATES:-}" ]; then
  exec_regions_candidates_declare "$EXEC_REGION_CANDIDATES"
fi
EXEC_REGIONS_ACTUAL=$(exec_regions_actual)
EXEC_REGIONS=$(exec_regions_resolve)
CANDIDATES_NOW=$(exec_regions_candidates_read | tr '\n' ',' | sed 's/,$//')
info "home = $REGION · 注册表在用区并 home = $EXEC_REGIONS_ACTUAL · 候选区 = ${CANDIDATES_NOW:-(未声明)}"
info "execution-regions = $EXEC_REGIONS"
# 🔴 同一份清单也经环境变量交给**本脚本接下来每一条** cdk deploy(含连带部署的依赖栈):infra/lib/shared/execution-regions.ts
#   的 requestedRegionCondition 在没有 -c execution-regions 时读它。第 3 步平台栈仍显式传 -c(两条通道同值;-c 优先)。
export BGP_EXECUTION_REGIONS="$EXEC_REGIONS"

say "2) 幂等写入 SSM /bgp/wiring/*(期望接线的持久事实源,供裸部署自愈)"
put() { aws ssm put-parameter --name "$1" --value "$2" --type String --overwrite \
          --profile "$PROFILE" --region "$REGION" >/dev/null && info "  $1"; }
put /bgp/wiring/openmetadata-url          "$OM_URL"
put /bgp/wiring/genbi-backend             "agentcore"
put /bgp/wiring/genbi-runtime-arn         "${RT_ARN[genbi]}"
put /bgp/wiring/genbi-memory-backend      "agentcore"
put /bgp/wiring/genbi-memory-id           "${MEM_ID[genbi]}"
put /bgp/wiring/netadvisor-backend        "agentcore"
put /bgp/wiring/netadvisor-runtime-arn    "${RT_ARN[netadvisor]}"
put /bgp/wiring/netadvisor-memory-backend "agentcore"
put /bgp/wiring/netadvisor-memory-id      "${MEM_ID[netadvisor]}"
put /bgp/wiring/paramadvisor-backend      "agentcore"
put /bgp/wiring/paramadvisor-runtime-arn  "${RT_ARN[paramadvisor]}"
put /bgp/wiring/paramadvisor-memory-backend "agentcore"
put /bgp/wiring/paramadvisor-memory-id    "${MEM_ID[paramadvisor]}"

# ── 2b) 执行环境部署机制栈(broker + CodeBuild + 源包 asset)随 HEAD 一起刷新 ────────────────
# 🔴 单一作者(2026-09-06 根治):deploy-all 第 6.5 步首装、本脚本每次刷新、mr-gate 只调本脚本。
#   不发它的两种后果:① 新账号里根本没有 broker ⇒ 向导「开始部署」报 Function not found(2026-09-06 真撞);
#   ② infra/lib/exec-env/* 改了但源包 asset 没更新 ⇒ 非 home 的「重新部署」跑的仍是旧栈代码,
#      验收只看到 finalize 报「CFN Outputs 缺 …」这种离根因很远的错。
#   放在平台栈之前:平台代码要求的描述符键必须能被新栈产出。源包按内容哈希不可变 ⇒ 无改动时秒级 no-op。
say "2b) 执行环境部署机制栈 BgpExecEnvDeployStack(源包随 HEAD 刷新)"
cd "$ROOT/infra"
npx cdk deploy BgpExecEnvDeployStack --require-approval never --profile "$PROFILE" \
  || die "BgpExecEnvDeployStack 部署失败(没有它,新建 / 重新部署执行环境一律失败)"

# ── 2c) home 的 MWAA Serverless 入口栈随 HEAD 刷新(分钟级、无改动即 no-op)──
say "2c) BgpAirflowServerlessStack(home 的 MWAA Serverless 入口)"
cd "$ROOT/infra"
npx cdk deploy BgpAirflowServerlessStack --require-approval never --profile "$PROFILE" || die "BgpAirflowServerlessStack 部署失败"

# ── 2c′) DynamoDB 库栈随 HEAD 刷新(2026-10-20 …7237 真撞)─────────────────────────────
# 🔴 为什么必须有这一步:平台栈只按**表名字面**读写表(TABLES),对 BgpDatabaseStack 没有 CDK 依赖 ⇒ 第 3 步
#   `cdk deploy BgpPlatformStack` 不会连带部署它。新版若新增了表(该缺陷的 bgp-ai-tasks 是 tag release-2026-10-13
#   之后第一张),只跑本脚本升级 ⇒ 表不存在 ⇒ 用到它的接口整条 500。库栈所有表 RemovalPolicy.RETAIN + PITR,
#   既有表字段不变 ⇒ 无改动时秒级 no-op;放在平台栈之前,新代码滚上去时表一定已在。
#   (FinOps 3 表 / Platform 2 表分别归 BgpFinOpsStack / BgpPlatformStack,后者本脚本本来就部署。)
say "2c′) BgpDatabaseStack(新版新增的 DynamoDB 表随升级建出来;无改动即 no-op)"
cd "$ROOT/infra"
npx cdk deploy BgpDatabaseStack --require-approval never --profile "$PROFILE" \
  || die "BgpDatabaseStack 部署失败(新版新增的表建不出来,平台启动后用到它的接口会 500)"

# ── 2c″) OpenMetadata 库栈随 HEAD 刷新─────────────────────────────────────────
# 🔴 为什么要这一步:BgpOmServiceStack 只引用库栈的实例(跨栈 import),部署它**不会**连带部署 BgpOmDatabaseStack ⇒
#   引擎版本这类库栈自己的变更(MySQL 8.0 → 8.4,消掉 RDS 扩展支持费)只跑本脚本升级时永远落不下去。
#   无改动时秒级 no-op;有大版本变更时是 RDS 原地升级:Multi-AZ 实例一次停机窗口约 10–20 分钟,期间治理目录 / 血缘等
#   OpenMetadata 功能不可用,RDS 升级前自动留快照(回滚 = 从该快照恢复,见手册 §7ter.2)。放在 OM 服务栈之前:
#   服务起来时库已是新版本。
say "2c″) BgpOmDatabaseStack(OpenMetadata 库引擎 / 规格随升级落下去;无改动即 no-op,大版本变更有停机窗口)"
cd "$ROOT/infra"
npx cdk deploy BgpOmDatabaseStack --require-approval never --profile "$PROFILE" \
  || die "BgpOmDatabaseStack 部署失败(OpenMetadata 库没升上去;实例本身与快照都在,按手册 §7ter.2 核对后重跑)"

say "2d) OpenMetadata 加固(WAF / 回源校验头 / 管理员口令密钥)—— 生产上线批次 A"
# 🔴 已上线的环境升级时这一步不可省:平台 om-client 不再回落出厂口令 admin,而 bgp/om/admin-password
#   只由 BgpOmServiceStack 生成 ⇒ 不先部署它,平台读不到口令,治理目录 / 血缘等 OM 功能当场断。
cd "$ROOT/infra"
# 🔴 --exclusively(回滚演练 2026-10-26 真撞):不带它 CDK 会连带部署 BgpOmServiceStack 的依赖栈 BgpOmDatabaseStack。
#   库栈在上面 2c″ 步已显式部署过(升级方向 no-op);而从更新的版本**回滚**到本版时,本版模板里的引擎版本比现网低 ⇒
#   CloudFormation 会试图给 RDS 降大版本 ⇒ 被拒「Cannot upgrade mysql from X to Y」⇒ 整条回滚在这一步中止、平台栈没回滚。
#   RDS 不支持大版本降级是事实,回滚脚本就不该让 CDK 顺手去碰库栈。release-2026-10-13 的同一行已用热修补上。
npx cdk deploy BgpWafStack BgpOmServiceStack --exclusively --require-approval never --profile "$PROFILE" || die "BgpWafStack / BgpOmServiceStack 部署失败"

say "3) 部署平台栈(完整 -c 接线)"
cd "$ROOT/infra"
npx cdk deploy BgpPlatformStack --require-approval never --profile "$PROFILE" \
  -c openmetadata-url="$OM_URL" \
  -c genbi-backend=agentcore       -c genbi-runtime-arn="${RT_ARN[genbi]}" \
  -c genbi-memory-backend=agentcore -c genbi-memory-id="${MEM_ID[genbi]}" \
  -c netadvisor-backend=agentcore  -c netadvisor-runtime-arn="${RT_ARN[netadvisor]}" \
  -c netadvisor-memory-backend=agentcore -c netadvisor-memory-id="${MEM_ID[netadvisor]}" \
  -c paramadvisor-backend=agentcore -c paramadvisor-runtime-arn="${RT_ARN[paramadvisor]}" \
  -c paramadvisor-memory-backend=agentcore -c paramadvisor-memory-id="${MEM_ID[paramadvisor]}" \
  -c execution-regions="$EXEC_REGIONS" \
  "${@:3}"

say "3b) OM 管理员口令:出厂 admin/admin ⇒ Secrets Manager 里的随机口令(幂等,带验证)"
bash "$HERE/om-secure-admin.sh" "$PROFILE" "$REGION" || die "OM 管理员口令加固失败(见上;OM 对公网可达,不许带着出厂口令收工)"

# ── 3c) S3 Tables 联邦目录 s3tablescatalog──────────────────────────────────────────────
# 🔴 升级到本版的存量环境(含现网)只要从没跑过「写 S3 Tables 的同步」,这个目录就不存在 ⇒ Athena 直查 / 问数一律
#   CATALOG_NOT_FOUND。它不是 CDK 资源,这里对主控区 + 每个已注册执行区幂等开通(已在则秒过);运行时另有自愈
#   (同步启动 / 直查),但安装 / 升级面必须先把前提摆好,问数智能体(自己的角色、不经平台路由)只靠这里。
# 只对**真有执行环境的区**(home ∪ 注册表在用区)开通,不含候选区 —— 候选区里还没有任何东西,不为「将来可能用」建对象;
#   候选区内新建的执行区由页面「检测初始化」在该区幂等开通(platform/src/lib/exec-env/probe-runner.ts 的 lake:s3tablescatalog 项)。
say "3c) S3 Tables 联邦目录 s3tablescatalog(regions=$EXEC_REGIONS_ACTUAL;候选区不建)"
for r in ${EXEC_REGIONS_ACTUAL//,/ }; do ensure_s3tables_catalog "$r"; done

# ── 4) IAM 模拟门────────────────────────────────────────────
# 🔴 为什么在这里:一刀内 IAM 类缺陷三次(缺 iam:GetRole 缺 codebuild:ListBuildsForProject CreateWorkflow 资源模式
#   bgp* 永不匹配 workflow/*),每次都是部署完、验收跑到下发那一步才炸。SimulatePrincipalPolicy 是离线的(不真调服务、零副作用、十几秒),
#   拿「平台真实调用清单」(infra/iam/platform-taskrole-calls.json,ARN 只用服务自己报出的形态)去问 IAM:任何一条不是 allowed 就红,不许收工。
say "4) IAM 模拟门:TaskRole × 平台真实调用清单(infra/iam/platform-taskrole-calls.json;regions=$EXEC_REGIONS)"
# any-region 轴的探测区必须**不在**放行清单里(门自己会拒);候选区一多,写死的 eu-central-1 就可能撞进清单 ⇒ 从备选里挑
# 🔴 (2026-10-22 测试账号 all-enabled 升级真撞):这里原来是 `[ -n "$IAM_PROBE_REGION" ] || die …` —— all-enabled 把 7 个固定备选区
#   全放进了清单 ⇒ 挑不出 ⇒ die exit 1:平台栈 / 接线 / 口令 / 联邦目录全做完了却被报成「升级失败」,页面向导也拿不到机读裁决。
#   根治在 lib(探测区优先取账号未 opt-in 的区,按定义不可能在清单里);这里兜底:真挑不出就把 `none` 交给门,门只验其余轴、
#   把 any-region 轴记成「本账号验不了」(退 4 ⇒ env-blocked),**不 die** —— 部署已完成,门少验的那几行要如实说,不许连累整条升级链。
IAM_PROBE_REGION=$(exec_regions_pick_probe "$EXEC_REGIONS")
if [ -z "$IAM_PROBE_REGION" ]; then
  IAM_PROBE_REGION=none
  printf '\033[1;33m⚠️ 放行清单已覆盖本账号能挑出的每一个探测区 ⇒ IAM 模拟门的 any-region 轴本次没有探测区可用,只验其余轴(门会把这几行记成「本账号验不了」)\033[0m\n'
fi
# 🔴🔴 2026-09-17:这里原来是 `|| die "IAM 模拟门红:TaskRole 存在 deny"` —— 把门的**三个**退出码
#   压成两个,于是在受限账号里(`ecs:ListServices` 被拒 ⇒ 门自己报「环境错误」并退 2)
#   脚本照样宣告「TaskRole 对平台真实调用存在 deny」= **给产品定了一个假罪**,并把人引去改
#   platform-stack.ts。门的契约本来写得很清楚(0 全 allowed / 1 有 deny / 2 环境错误),
#   是调用方没照着分。⇒ 判定抽成函数,三态各自的话各自说(见记忆 gate-must-separate-crash-from-fail)。
# 🔴🔴 2026-09-19 再加一态(用户原话:「不能永久拒绝某一个区域,因为这只是在现有临时账号受到
#   限制,后续别人的真实账号还是没有限制的。所以这个要注意。」):门新增退出码 **4 = 无真红,
#   但有若干行被**账号所在组织的 SCP** 拦住,在本账号里验不了**。
#   压成「红」的后果正是用户点的那一条:平台会因为「某个区在这个临时账号里被拦」而**永远**部署不下去,
#   而且结论会长成「那个区不可用」—— 那是账号的属性,不是区的属性、更不是平台的属性。
#   ⇒ 单独一态:部署照常完成(它已经完成了),但**明确说这不是过关**,并写清换账号必复验。
# >>> iam-gate-verdict-block(离线判据 infra/test/redeploy-verdict/test_verdict.sh 逐字抽这一段来跑)
iam_gate_verdict() {  # $1=门的退出码 ⇒ 0 绿 / 1 产品红 / 3 门未执行 / 4 有环境阻塞无真红
  case "$1" in
    0) return 0;;
    2) return 3;;
    4) return 4;;
    *) return 1;;
  esac
}
# 🔴🔴 2026-09-19 真踩(同族第三次「三态写了但接不上」):这里原来写的是
#     `iam_gate_verdict "$IAM_GATE_RC"; VERDICT=$?`
#   —— 在 `set -euo pipefail` 之下,**函数回非 0 就当场把脚本杀掉**,于是下面那个 case 里
#   除了「0 绿」以外的每一条话(包括 2026-09-17 专门为三态写的两条)**一次都没打印过**:
#   日志停在门的摘要后面,脚本静默退出。也就是说「三态」写在代码里、却从来没有接上。
#   ⇒ 必须用 `|| VERDICT=$?` 这种**不触发 errexit** 的形式取返回码。
#   判据:`infra/test/redeploy-verdict/test_verdict.sh` 把本段逐字抽出来,在 `set -euo pipefail` 下
#   对 rc ∈ {0,1,2,3,4} 各跑一次,断言每一态都**真的打印了**自己那句话 + 退出码正确。
if [ -z "${IAM_GATE_RC:-}" ]; then
  set +e
  python3 "$ROOT/scripts/iam-simulate-gate.py" --profile "$PROFILE" --home-region "$REGION" --regions "$EXEC_REGIONS" --probe-region "$IAM_PROBE_REGION"
  IAM_GATE_RC=$?
  set -e
fi
VERDICT=0
iam_gate_verdict "$IAM_GATE_RC" || VERDICT=$?
case "$VERDICT" in
  0) say "✅ 平台栈重部署完成(IAM 模拟门全绿)。接线已固化到 SSM,后续裸部署也会自愈补齐。";;
  1) die "IAM 模拟门红:TaskRole 对平台真实调用存在 deny(见上表点名的动作 × 资源)—— 修 infra/lib/platform-stack.ts 后重跑本脚本";;
  3) printf '\n\033[1;33m⚠️ IAM 模拟门**没有执行**(退 2 = 环境/权限原因,见上一行)—— 这既不是过关也不是产品红:\n'
     printf '   平台栈本身已部署完成、接线已固化;但「TaskRole 能不能做那些调用」这一条本次**没人看过**。\n'
     printf '   换一个有 ecs:Describe* + iam:SimulatePrincipalPolicy 的身份重跑:scripts/redeploy-platform.sh %s %s\033[0m\n\n' "$PROFILE" "$REGION"
     exit 3;;
  4) printf '\n\033[1;33m⚠️ IAM 模拟门:**没有真红**,但有若干行在本账号里验不了(被账号所在组织的 SCP 拦住 ⛔,或 any-region 轴没有探测区可用 ⚠️;见上表)。\n'
     printf '   平台栈已部署完成、接线已固化,放行清单也已按注册表写入。\n'
     printf '   🔴 这**不是过关**:那些行的平台侧授权本次没人验成。它是**本账号的限制**,不是那些 region 的属性 ——\n'
     printf '      换到没有该 SCP / 还有未放行区的账号必须重跑本门复验(别把它记成「某个区不可用」)。\033[0m\n\n'
     ;;
esac
# 🔴 给**调用方**一行机读裁决(`34-add-region-headless.py` 等):别让它们各自去 grep 中文句子 ——
#   本脚本的收尾话术改一个字,那些调用方就会静默判错(「放行失败」而其实放行成功了)。
case "$VERDICT" in
  0) echo "[redeploy] IAM_GATE_VERDICT=green";;
  4) echo "[redeploy] IAM_GATE_VERDICT=env-blocked";;
  *) echo "[redeploy] IAM_GATE_VERDICT=unknown";;
esac
# <<< iam-gate-verdict-block
