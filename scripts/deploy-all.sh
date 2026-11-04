#!/usr/bin/env bash
###############################################################################
# Kingfisher — Big Data Governance Platform : full from-scratch deployment
#
# One command to stand up the ENTIRE platform on a fresh AWS account, in the
# correct order. Safe to re-run (idempotent where it matters).
#
#   BGP_DEPLOY_MODE=production|demo ./scripts/deploy-all.sh <aws-profile> <主控区>
#
#   🔴 模式必填(唯一作者 infra/lib/shared/deploy-mode.ts):production = 客户生产(不造数、不建演示 MySQL、只建 admin);
#      demo = 演示 / 验收环境(演示数据 + 测试账号)。写进 SSM /bgp/deploy-mode 之后**不许换**(本脚本会拒绝)。
#   🔴 两个位置参数都写全:漏传**不报错**,静默缺省成 temp-account / us-east-1(AGENTS.md §7 红线)。
#   🔴 admin 初始口令由第 11 步落盘到 /tmp/bgp-cognito-pw-<profile>.json(键 admin;可用 BGP_PW_FILE 改路径),
#      stdout 也会打印一次 —— 部署日志要妥善处置(手册 docs/CUSTOMER-PROD-DEPLOY.md §4)。
#
# What it deploys (every module):
#   Foundation .... KMS(CMK) · WAF · VPC · Cognito · DynamoDB(bgp-* 表 72 张:BgpDatabaseStack 67 +
#                   BgpFinOpsStack 3 + BgpPlatformStack 2;平台进程经 lib/aws/dynamodb.ts TABLES 读写其中 63 张;
#                   2026-10-21 按 AGENTS.md §1 / §5 校准)·
#                   Redshift Serverless(主控区)· source RDS(MySQL,**仅 demo 模式**的演示源库 BgpRdsStack)
#   Governance .... OpenMetadata (backend DB · OpenSearch · service+CloudFront)
#   AI (AgentCore)  GenBI · Network Advisor · Parameter Advisor
#                   (each = ECR + skill Lambda + Gateway + Memory + Runtime;
#                    built two-pass because the Runtime needs the image first)
#   Platform ...... ECS Fargate(Next.js) + CloudFront, wired to OM + all 3 agents
#   Scheduling .... MWAA Serverless(主控区一套;每个执行区自己一套随执行环境栈组建;经典 MWAA 只在 -c classic-mwaa=1 时才建)
#   Security ...... CloudTrail + VPC Flow Logs (audit stack)
#   Cognito ....... 4 RBAC groups + initial users
#
# DynamoDB tables for modules 33 (engine jobs), 34 (alerting) and 36 (sensitive
# findings) live in BgpDatabaseStack, and their application code ships in the
# Platform image — so they are covered automatically by the steps above; no
# separate stack is required.
#
# Real-time / compute capability stacks — ON by default (2026-07-07 cost refactor
# made them ≈zero standing cost, so a turnkey deploy stands up EVERY feature):
#   DEPLOY_REALTIME=1(default)  BgpRealtimeStack  (module 31: DMS CDC durable base
#                     — subnet group + SG + roles only; the DMS replication instance
#                       is LAZY-created by the backend when the first sync task is
#                       built, ~3-5min first time then reused; no standing instance)
#   DEPLOY_FLINK=1(default)     BgpFlinkStack     (module 32: MSAF service role only;
#                       Kinesis source stream removed — Flink uses MySQL binlog CDC)
#   DEPLOY_EMR=1(default)       BgpEmrStack       (module 33: EMR Serverless exec role
#                       only; the application is created per-job and deleted after)
# Set any to 0 to skip that stack. Kinesis streams were removed (unused for MySQL);
# the only on-demand billable resource is the DMS instance, created when actually used.
#
# Other optional env vars:
#   SKIP_CLOUDTRAIL=1   skip CloudTrail in the audit stack (some org SCPs block it)
#   OM_INGESTION=1      also deploy the OpenMetadata ingestion connectors stack
#   BGP_ADMIN_PASSWORD / BGP_PM_PASSWORD / BGP_DEV_PASSWORD /
#   BGP_ANALYST_PASSWORD / BGP_BIZ_PASSWORD   initial Cognito passwords
#                       (unset -> a random one is generated and printed once)
#
# Requirements: awscli v2, Node 20+, CDK CLI, Docker (with buildx) running.
# Tested region: us-east-1 (Bedrock models / S3 Tables / MWAA availability).
###############################################################################
set -euo pipefail

PROFILE="${1:-temp-account}"
REGION="${2:-us-east-1}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
# 关键(接线自愈根治层1):export AWS_PROFILE,不只是靠 --profile 传给 cdk。
# 原因:infra/bin/app.ts 的 SSM 接线自愈段用 execFileSync 调 aws CLI,它只认 process.env.AWS_PROFILE
# (读不到就无 profile 调用 → 报错 → catch 静默跳过自愈)。此前 deploy-all 只 export REGION 漏了 PROFILE,
# 导致 step7 `cdk deploy MwaaStack` 连带重刷 Platform(MWAA 依赖 Platform)时,那次 synth 未带 -c 接线、
# 自愈又因无 profile 失效 → GENBI 等 env 被冲回 inprocess。与 redeploy-platform.sh:29 保持一致。
export AWS_PROFILE="$PROFILE"
# @kf-batch 50-WP20-retire-classic-mwaa —— 经典 MWAA 栈还在就别更新平台栈(会 UPDATE_ROLLBACK;理由见该脚本头)
bash "$HERE/preflight-classic-mwaa.sh" "$PROFILE" "$REGION" || exit 1
export CDK_DEFAULT_REGION="$REGION"
# 🔴 CDK CLI 解析目标区时 AWS_REGION / AWS_DEFAULT_REGION 优先于 CDK_DEFAULT_REGION(会覆盖它)⇒ 必须一起对齐,
#   否则部署机环境里残留的 AWS_REGION 会把整套控制面静默建进别的区(2026-10-10 第二账号彩排实撞)。
#   KF_HOME_REGION 交给 infra/bin/app.ts 做 synth 期比对(不一致 ⇒ 一个栈都不部署)。
export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION" KF_HOME_REGION="$REGION"

# 🔴 生产上线批次 A:部署模式**必须显式给**(唯一作者 infra/lib/shared/deploy-mode.ts)。
#   production = 客户生产:不造数、不部署演示 MySQL(BgpRdsStack)、初始用户只建 admin;
#   demo       = 演示 / 验收环境:原来的全套(造数 + 演示源库 + 四个测试账号)。
#   导出成环境变量 ⇒ 本次部署里**每一条** cdk deploy(含连带部署的依赖栈)看到同一个值;
#   并写进 SSM /bgp/deploy-mode(见下方),redeploy-platform 读同一个值,同一环境前后不会漂。
case "${BGP_DEPLOY_MODE:-}" in
  production|demo) ;;
  *) echo "❌ 必须显式设置 BGP_DEPLOY_MODE:production(客户生产:不造数 / 不建演示 MySQL / 只建 admin)或 demo(演示 / 验收环境)"; exit 2 ;;
esac
export BGP_DEPLOY_MODE

# The three AI capabilities share one build/deploy shape (module 28 standard).
# Keyed maps keep the two-pass logic DRY instead of copy-pasting it three times.
# 映射表与「构建推送镜像 / 部署 Runtime」两个函数的**单一事实源**在 scripts/lib/agentcore-agents.sh
# (redeploy-platform.sh 第 1 步、redeploy-agents.sh 也 source 它;B-76 2026-10-14 抽出:升级路径原来漏了智能体)。
# shellcheck source=lib/agentcore-agents.sh
source "$HERE/lib/agentcore-agents.sh"
source "$HERE/lib/s3tables-catalog.sh"   # 序 43 B-91:S3 Tables 联邦目录 s3tablescatalog 的安装期唯一作者(第 6.3 步)
source "$HERE/lib/execution-regions.sh"  # 序 48:放行清单(home ∪ 注册表在用区 ∪ 候选区)的唯一作者(第 2.6 步)

say()  { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
info() { printf '   %s\n' "$*"; }

# ── 失败台账(2026-08-31 根治两个"部署可信度"缺陷)─────────────────────────────
# 缺陷①【级联中止】第 11/12 步是裸调用,而本脚本开着 `set -euo pipefail` ⇒ 任一失败就
#   **整锅中止**,把后面**必须跑的第 13 步接线体检**也跳过。2026-08-29 在受限账号实测:
#   第 11 步 Cognito 管理写被禁 → 部署当场停在那里,基础设施其实早已就绪,却既没造数、
#   也没做接线体检,操作者看到的只是一个半途的红字。
# 缺陷②【exit 0 不等于真就位】第 13 步接线体检查出异常、自愈也失败时,**只打红字**,
#   随后照样 `Done.` + **退出码 0**。于是"脚本成功"与"平台可用"脱钩 —— 这正是历史上
#   "step12 造数失败被吞成 exit 0" 同一类坑的复发面。
# 定案:能独立跑的步骤一律**跑完**,失败**记账不中止**;收尾把台账列出来并**以非零码退出**。
FAILED_STEPS=()
note_failure() { FAILED_STEPS+=("$1"); printf '   \033[1;31m✗ %s\033[0m\n' "$1"; }
# run_step "<可读标签>" cmd args…  —— 失败只记账,不让 set -e 掀桌子。
# 🔴 必须用 `cmd || rc=$?` 取退出码,**不能**写成 `if cmd; then return 0; fi; rc=$?`:
#    后者在 `fi` 之后拿到的是 **if 复合命令自身的 0**(实测 `exit 7` 被捕获成 0),
#    于是会打出"失败(退出码 0)"这种自相矛盾的话。`|| ` 右侧存在时 errexit 亦不触发。
run_step() {
  local label="$1"; shift
  local rc=0
  "$@" || rc=$?
  if [ "$rc" -eq 0 ]; then return 0; fi
  note_failure "${label} 失败(退出码 ${rc})—— 已记账,继续跑后续独立步骤;收尾会以非零码退出"
  return 0
}
die()  { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# Read a CloudFormation stack output value by key.
out() {
  aws cloudformation describe-stacks --stack-name "$1" --profile "$PROFILE" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text
}

###############################################################################
say "0) Preflight — tools & credentials"
###############################################################################
for bin in aws node npx docker; do
  command -v "$bin" >/dev/null 2>&1 || die "'$bin' not found on PATH."
done
docker info >/dev/null 2>&1 || die "Docker daemon is not running (needed to build agent images)."

# 依赖自愈(根因治理):node_modules 是 .gitignore 的,`git clone` 不带来。全新 clone 直接部署会在
# CDK synth(step2)即 TSError(Cannot find module 'aws-cdk-lib' / @types/node),全球用户按
# "clone → deploy" 必撞。故此处幂等自愈:未装(缺 npm ci 的完整性标记 .package-lock.json)才装。
# infra 供 CDK synth;platform 供 Next.js 镜像(fromAsset)构建。已装则秒过,不拖累重复部署。
ensure_deps() {
  local dir="$1"
  if [ -f "$ROOT/$dir/node_modules/.package-lock.json" ]; then
    info "deps: $dir 已就绪(跳过)"
  else
    info "deps: $dir 缺依赖,npm ci 安装中(全新 clone 首次约 1-2min)..."
    ( cd "$ROOT/$dir" && npm ci ) || die "'$dir' npm ci 失败(检查 Node 版本 / package-lock.json)。"
  fi
}
ensure_deps infra
ensure_deps platform

# RED LINE: never deploy to the wrong account. Print identity and require the
# operator to have selected the intended profile.
IDENT=$(aws sts get-caller-identity --profile "$PROFILE" --region "$REGION" 2>&1) \
  || die "Cannot authenticate with profile '$PROFILE' (expired token? run: aws configure --profile $PROFILE). Detail: $IDENT"
ACCOUNT=$(echo "$IDENT" | awk -F'"' '/"Account"/{print $4}')
info "Profile : $PROFILE"
info "Region  : $REGION"
info "Account : $ACCOUNT"
[ "$REGION" = "us-east-1" ] || info "WARNING: only us-east-1 is tested (Bedrock / S3 Tables / MWAA)."

###############################################################################
say "1) Account-level prerequisites (service-linked roles, DMS roles)"
###############################################################################
"$HERE/00-prereqs.sh" "$PROFILE" "$REGION"

###############################################################################
say "2) CDK bootstrap (idempotent)"
###############################################################################
cd "$ROOT/infra"
# @kf-batch 50-PROD-A-launch-hardening(h):CloudFront 的 WAF 栈固定建在 us-east-1(AWS 规则)⇒ 主控区不是
#   us-east-1 时那个区也要 bootstrap(否则 BgpWafStack 部署时找不到 bootstrap 资源)。
# 🔴 本次部署会往哪些区放 CDK 资产 = 这一张清单(bootstrap 与第 2.5 步资产自愈**共用**,不各写一份)。
#   CLOUDFRONT_WAF_REGION 必须与 infra/lib/waf-stack.ts 的同名常量相等(离线判据 deploy-all-checks 钉着)。
CLOUDFRONT_WAF_REGION="us-east-1"
BOOTSTRAP_REGIONS="$REGION"
[ "$REGION" = "$CLOUDFRONT_WAF_REGION" ] || BOOTSTRAP_REGIONS="$REGION $CLOUDFRONT_WAF_REGION"
for _r in $BOOTSTRAP_REGIONS; do
  npx cdk bootstrap "aws://$ACCOUNT/$_r" --profile "$PROFILE"
done

# @kf-batch 50-PROD-A-launch-hardening(h):默认大模型按**主控区账号真值**选(出厂默认是 us.* 美国推理配置,
#   主控区在欧洲 / 亚太时调不通 ⇒ 9 个 AI 能力全哑火而部署是绿的)。显式给了 BEDROCK_MODEL_ID 就用它。
if [ -z "${BEDROCK_MODEL_ID:-}" ]; then
  BEDROCK_MODEL_ID=$(bash "$HERE/resolve-home-model.sh" "$PROFILE" "$REGION") \
    || { echo "❌ 主控区没有能用的默认大模型(见上)"; exit 1; }
fi
export BEDROCK_MODEL_ID
info "默认大模型(主控区 $REGION 账号真值,真调用通过)= $BEDROCK_MODEL_ID"

###############################################################################
say "2.6) 执行区候选预授权(序 48):放行清单 = home ∪ 注册表在用区 ∪ 候选区"
###############################################################################
# 🔴 为什么在安装期就定(2026-10-19 客户现网法兰克福加区实录):平台 TaskRole 等 18 处 IAM `aws:RequestedRegion` 条件在 synth 期
#   烘入模板 ⇒ 不预授权的话,客户每在页面建一个执行区,运维都得再跑一次 redeploy-platform.sh「放行」(SPEC §12.0 不许让执行环境
#   CodeBuild 代劳)。这里把「人决定平台可以碰哪些区」提前到安装:EXEC_REGION_CANDIDATES 声明一次(持久化 SSM),候选区内
#   加区全在页面完成。不给 ⇒ 只放行主控区(与原行为逐字节一致),之后任何一次 redeploy-platform.sh 也能补声明。
#     EXEC_REGION_CANDIDATES="eu-central-1,ap-northeast-1" | all-enabled | none   (区全名,必须是账号已启用的区;不接受 *)
if [ -n "${EXEC_REGION_CANDIDATES:-}" ]; then
  exec_regions_candidates_declare "$EXEC_REGION_CANDIDATES"
else
  info "未声明候选区(EXEC_REGION_CANDIDATES 为空)⇒ 本次只放行主控区;之后在页面建的每个执行区都要跑一次 redeploy-platform.sh 放行"
fi
EXEC_REGIONS=$(exec_regions_resolve)
info "execution-regions = $EXEC_REGIONS"
# 同一份清单经环境变量交给本次部署里**每一条** cdk deploy(平台栈 / 三个智能体栈 / EMR 栈都有区域条件;第 6 步平台栈另显式传 -c,两通道同值)
export BGP_EXECUTION_REGIONS="$EXEC_REGIONS"

###############################################################################
say "2.5) CDK asset 完整性自愈(修 CDK CLI 偶发'空 zip'导致 Lambda 创建 non-empty zip 失败)"
###############################################################################
# 根因治理(2026-08-24 首见;2026-08-31 根治首次部署盲区):CDK CLI 某些版本会把
# 个别 asset(如内置 S3AutoDelete handler)打成 22 字节【空 zip】上传到 bootstrap asset 桶,
# 导致 `AWS::Lambda::Function` 创建报 "Uploaded file must be a non-empty zip" → 整个
# BgpPlatformStack ROLLBACK。且 CDK 靠 S3Key(内容 hash)判"已存在不重传"→坏 zip 一旦上桶
# 重试永远复用,变【必现】。手动修桶只救单环境,全球用户会撞同样坑,故在此自愈。
#
# 🔴 **本函数 2026-08-31 重写,修掉两个让它在"新账号首次部署"时形同不存在的缺陷**
#    (2026-08-31 在全新账号实测:第一次部署照样 ROLLBACK,第二次才过 —— 就是被这两条挡的):
#
#  ① **MISSING 曾被跳过 ⇒ 空桶 = 整个函数 no-op。** 旧逻辑只修桶里【已存在】的坏 zip,
#     理由写着"MISSING 不处理(CDK deploy 会自己传)"—— 但全新账号的 asset 桶本来就是空的,
#     每个 asset 都 MISSING ⇒ 自愈一个都不碰,随后 CDK 自己把坏 zip 传上去,Lambda 创建即失败。
#     ⇒ **改为 MISSING 也主动预上传**:我们先把好 zip 放进桶,CDK 发现 key 已存在就跳过自己那次
#     上传(正是"坏 zip 一旦上桶就被复用"的同一机制,这里反过来用),首次部署即免疫。
#  ② **key 靠目录名猜。** 旧逻辑 glob `cdk.out/asset.*/` 再拼 `<hash>.zip`,而 cdk.out 里堆着
#     历次 synth 的**陈旧残留**(实测 95 个目录,清单里真正要发布的只有 5 个)⇒ 既做无用功、
#     又可能上传出根本没人引用的孤儿对象,而真正的 key 万一不叫 `<hash>.zip` 就漏修。
#     ⇒ **改为读 CDK 自己的 asset 清单 `cdk.out/*.assets.json`**:objectKey 与 bucketName 都由
#     清单给出(权威),只取 `packaging=="zip"` 的条目(docker 镜像 asset 在 dockerImages 段、
#     模板类是 packaging=="file",都与本 bug 无关),跨栈按 (bucket,key) 去重。
#
# 纯 S3 对象修复,不改任何 CDK 栈定义/产品代码。幂等:桶里 zip 健康(≥64B)则跳过。
# 调试:`HEAL_DRY_RUN=1` 只打印判定不真上传。
heal_cdk_empty_assets() {
  local no_synth="${1:-}"
  if [ "$no_synth" != "--no-synth" ]; then
    info "asset 自愈:synth 生成 cdk.out …"
    # 🔴 **必须带 --profile**(2026-08-31 实测教训):不带时 CDK 用**本机默认 profile** 解析环境,
    # 把 cdk.out 的清单写成**别的账号**的 bucket 名(实测出现过 073…765 / 124…897 两个外部账号),
    # 随后自愈就会拿本账号凭证去 head/put **别人账号的桶** ⇒ 一串 AccessDenied,
    # 而且是真的对外部账号发了请求。deploy-all 顶部虽然 export 了 AWS_PROFILE,但本函数
    # 也可能被单独 source/调用,不能依赖调用环境。
    npx cdk synth --all --quiet --profile "$PROFILE" >/dev/null 2>&1 || { info "  synth 非零(可能部分栈需 context),继续按已生成 cdk.out 校验"; }
  fi
  if ! command -v zip >/dev/null 2>&1; then
    info "  🔴 本机未装 zip ⇒ 自愈无法进行(空 zip 会原样进部署)。装 zip 后重跑本脚本。"
    return 1
  fi

  # 权威枚举:objectKey / bucketName 一律取自 CDK 自己的 assets 清单,不按目录名猜。
  local rows
  # 🔴 每个目的地按**它自己的区**(清单里的 `region`;缺省 = 主控区):主控区不是 us-east-1 时 BgpWafStack
  #   的资产在 us-east-1 的 bootstrap 桶里(2026-10-10 第二账号 production 彩排实撞:7 个合法资产被当成
  #   「不属于本账号」全拒,部署第 3 分钟停下)。
  rows="$(python3 - "$ROOT/infra/cdk.out" "$ACCOUNT" "$REGION" <<'PY'
import json, glob, os, sys
out, acct, region = sys.argv[1], sys.argv[2], sys.argv[3]
seen = {}
for p in sorted(glob.glob(os.path.join(out, "*.assets.json"))):
    try:
        d = json.load(open(p))
    except Exception:
        continue
    for v in d.get("files", {}).values():
        s = v.get("source", {})
        if s.get("packaging") != "zip":
            continue                       # 只有目录型(打成 zip 的 Lambda 代码)会撞空 zip bug
        src = s.get("path") or ""
        if not src or not os.path.isdir(os.path.join(out, src)):
            continue                       # 清单里有、本地没 synth 出来 ⇒ 无从重打,交给 CDK
        for dest in (v.get("destinations", {}) or {}).values():
            key = dest.get("objectKey")
            dreg = dest.get("region") or region
            bkt = (dest.get("bucketName") or "")
            bkt = bkt.replace("${AWS::AccountId}", acct).replace("${AWS::Region}", dreg)
            if key and bkt:
                seen[(bkt, key)] = (src, dreg)   # 同一 asset 被多栈引用时天然去重
for (bkt, key), (src, dreg) in sorted(seen.items()):
    print("%s\t%s\t%s\t%s" % (bkt, key, src, dreg))
PY
)" || { info "  🔴 读取 asset 清单失败,自愈跳过"; return 1; }

  if [ -z "$rows" ]; then
    info "  asset 清单里没有 zip 型条目(或 cdk.out 为空),跳过。"
    return 0
  fi

  local checked=0 uploaded=0 failed=0
  while IFS=$'\t' read -r bkt key src dreg; do
    [ -n "$key" ] || continue
    checked=$((checked+1))
    # 🔴 fail-closed 账号护栏:清单里的 bucket **必须属于本次部署的账号**。
    # 缘由(实测):清单的 bucketName 是我们信任的外部输入,只要有一次 synth 没绑对 profile,
    # 它就会指向别的账号 —— 那时"自愈"会变成"拿本账号凭证去动别人账号的桶"。宁可当场拒绝。
    # ⚠️ 模块 50 多 target/多账号落地时需重新审这条(届时应按 target 的账号逐一放行,而非单账号)。
    # 区也必须是本次 bootstrap 过的区(BOOTSTRAP_REGIONS),否则同样拒绝 —— 不许往清单外的区写。
    case " ${BOOTSTRAP_REGIONS:-$REGION} " in
      *" ${dreg} "*) ;;
      *) info "  🔴 拒绝:资产目的地区 ${dreg} 不在本次 bootstrap 的区里(${BOOTSTRAP_REGIONS:-$REGION}):$bkt/$key"
         failed=$((failed+1)); continue;;
    esac
    case "$bkt" in
      *"-${ACCOUNT}-${dreg}") ;;
      *) info "  🔴 拒绝:清单里的 bucket 不属于本账号($bkt;期望以 -${ACCOUNT}-${dreg} 结尾)。"
         info "     这通常意味着 cdk.out 是用别的 profile synth 出来的 —— 删掉 infra/cdk.out 重跑。"
         failed=$((failed+1)); continue;;
    esac
    local size
    size="$(aws s3api head-object --bucket "$bkt" --key "$key" --profile "$PROFILE" --region "$dreg" \
             --query ContentLength --output text 2>/dev/null || echo MISSING)"
    # 空 zip 魔数约 22 字节;<64B 视为损坏/空。MISSING = 首次部署,也要预上传(缺陷①)。
    if [ "$size" != "MISSING" ] && [ "$size" -ge 64 ] 2>/dev/null; then
      continue
    fi
    local reason="空/损坏(${size} B)"; [ "$size" = "MISSING" ] && reason="桶内缺失(首次部署)"
    if [ "${HEAL_DRY_RUN:-}" = "1" ]; then
      info "  [dry-run] 将上传 ${key} ← ${src}(${reason})"
      uploaded=$((uploaded+1)); continue
    fi
    local tmp="/tmp/cdk_heal_$$_${key%.zip}.zip"; rm -f "$tmp"
    ( cd "$ROOT/infra/cdk.out/$src" && zip -X -r "$tmp" . >/dev/null 2>&1 )
    if [ ! -s "$tmp" ]; then
      info "  🔴 打包失败: ${src} → ${key}(${reason})"; failed=$((failed+1)); rm -f "$tmp"; continue
    fi
    # 重试一次:一次 S3 抖动不该让整轮部署在 40 分钟后才 ROLLBACK。
    # 🔴 **必须把 aws 的 stderr 留出来**:早先版本把它 `2>&1` 吞了,失败时只打"上传失败"
    # 而不说原因,排查要靠人肉复现(实测因此白绕很久,真因是 AccessDenied 打到了别人账号的桶)。
    local cperr="/tmp/cdk_heal_cp_$$.err"; : >"$cperr"
    if aws s3 cp "$tmp" "s3://${bkt}/${key}" --profile "$PROFILE" --region "$dreg" >/dev/null 2>>"$cperr" \
       || aws s3 cp "$tmp" "s3://${bkt}/${key}" --profile "$PROFILE" --region "$dreg" >/dev/null 2>>"$cperr"; then
      info "  预置/修复 zip: ${key}(${reason} → $(wc -c <"$tmp") B)"; uploaded=$((uploaded+1))
    else
      info "  🔴 上传失败: s3://${bkt}/${key}"
      info "     原因: $(tr -d '\r' <"$cperr" | tail -1 | cut -c1-300)"
      failed=$((failed+1))
    fi
    rm -f "$tmp" "$cperr"
  done <<< "$rows"

  info "asset 自愈完成:清单 $checked 个,预置/修复 $uploaded 个,失败 $failed 个。"
  if [ "$failed" -gt 0 ]; then
    # 明确中止,而不是让部署跑 40 分钟后在 BgpPlatformStack 上 ROLLBACK。
    info "  🔴 有 asset 未能预置 ⇒ 后续 Lambda 创建可能报 non-empty zip。请查 S3 写权限后重跑。"
    return 1
  fi
  return 0
}
heal_cdk_empty_assets

###############################################################################
say "3) Foundation + OpenMetadata + AI base stacks"
###############################################################################
# CDK orders these by their dependency graph (KMS first, etc.). The three AI
# "base" stacks are deployed here WITHOUT their Runtime (no -c *-runtime=1):
# they create the ECR repo, skill Lambda, Gateway, GatewayTarget and Memory.
# The Runtime is created in step 5, after we push the container image.

# 各 AI 能力的 core-dist(+②runtime件)编译分发:部署(fromAsset/容器 COPY 打包)前刷新,
# 保证 Lambda/容器里的 core 副本 + agent-runner 与 TS 源同步。幂等。
# 【模块47 L2】改调通用 core-prebuild.sh all(原只刷 genbi;paramadvisor 的 core-dist/_runtime
# 曾漏刷,靠提交入库兜底但改源忘 prebuild 会部署陈旧容器)。all 遍历能力注册表全刷,加能力零改此处。
info "Prebuild all AI cores → core-dist(+_runtime) [genbi Lambda+容器 / paramadvisor 容器]"
# 用 $HERE(第54行已解析的脚本绝对路径),不能用 $(dirname "$0"):此处 cwd 已在第112行 cd 到
# $ROOT/infra,而 $0 是相对路径(如 ./scripts/deploy-all.sh)→ dirname 相对 infra/ 解析找不到脚本。
bash "$HERE/core-prebuild.sh" all

# 🔴 部署模式落 SSM(同一环境不许中途换模式:换了会让演示资源与生产语义混在一起)。
DEPLOY_MODE_PARAM="/bgp/deploy-mode"
PREV_MODE=$(aws ssm get-parameter --name "$DEPLOY_MODE_PARAM" --query Parameter.Value --output text --profile "$PROFILE" --region "$REGION" 2>/dev/null || true)
if [ -n "$PREV_MODE" ] && [ "$PREV_MODE" != "None" ] && [ "$PREV_MODE" != "$BGP_DEPLOY_MODE" ]; then
  die "本环境已按 $PREV_MODE 模式部署过(SSM $DEPLOY_MODE_PARAM),这次给的是 $BGP_DEPLOY_MODE —— 拒绝中途换模式"
fi
aws ssm put-parameter --name "$DEPLOY_MODE_PARAM" --type String --overwrite --value "$BGP_DEPLOY_MODE" \
  --profile "$PROFILE" --region "$REGION" >/dev/null || die "写 SSM $DEPLOY_MODE_PARAM 失败"
info "部署模式 = $BGP_DEPLOY_MODE(已写 SSM $DEPLOY_MODE_PARAM)"
# 演示源库只在 demo 模式进 app(bin/app.ts 同一条规则),清单必须跟着走,否则 cdk 报「找不到栈」。
DEMO_STACKS=""
[ "$BGP_DEPLOY_MODE" = "demo" ] && DEMO_STACKS="BgpRdsStack"

npx cdk deploy \
  BgpKmsStack BgpWafStack BgpVpcStack BgpAuthStack BgpDatabaseStack BgpFinOpsStack \
  BgpRedshiftStack $DEMO_STACKS \
  BgpOmDatabaseStack BgpOmSearchStack BgpOmServiceStack \
  BgpAgentCoreStack BgpNetAdvisorAgentCoreStack BgpParamAdvisorAgentCoreStack \
  --concurrency 4 --require-approval never --profile "$PROFILE"

OM_URL=$(out BgpOmServiceStack OpenMetadataCdnUrl)
[ -n "$OM_URL" ] && [ "$OM_URL" != "None" ] || die "OpenMetadata CloudFront URL not found (BgpOmServiceStack)."
info "OpenMetadata URL: $OM_URL"

###############################################################################
say "4) Build & push the three AgentCore images (ARM64)"
###############################################################################
# AgentCore Runtime requires linux/arm64; most build hosts are x86_64, so we use
# a buildx builder (QEMU emulation). --provenance/--sbom=false produces a single
# -platform manifest instead of an OCI index with attestation sub-manifests,
# which the Runtime can fail to resolve when pulling by tag.
TAG=$(git -C "$ROOT" rev-parse --short HEAD)
info "Image tag (git SHA): $TAG"
# 实现(buildx 构建器 · 一次 ECR 登录 · 逐个 build --push · 核单平台 manifest)在 scripts/lib/agentcore-agents.sh,
# 与 redeploy-agents.sh 共用同一份(B-76)。
agentcore_build_push_images "$TAG"

###############################################################################
say "5) Create the three AgentCore Runtimes (second pass, with the image)"
###############################################################################
# 逐个 cdk deploy 带 -c <cap>-runtime=1 -c <cap>-agent-tag=$TAG;实现同在 scripts/lib/agentcore-agents.sh。
agentcore_deploy_runtimes "$TAG"

# Collect Runtime ARNs + Memory IDs to wire into the Platform env.
declare -A RT_ARN MEM_ID
for a in "${AGENTS[@]}"; do
  RT_ARN[$a]=$(out "${A_STACK[$a]}" "${A_RT_OUT[$a]}")
  MEM_ID[$a]=$(out "${A_STACK[$a]}" "${A_MEM_OUT[$a]}")
  info "$a runtime=${RT_ARN[$a]}  memory=${MEM_ID[$a]}"
done

###############################################################################
say "6) Platform (ECS + CloudFront) wired to OM + all three agents"
###############################################################################
# The Next.js image is built by CDK (fromAsset). The context flags below flip
# GenBI + both advisors to their AgentCore backends so the platform is fully
# "AI-on" out of the box; omitting them would fall back to the in-process path.
npx cdk deploy BgpPlatformStack --require-approval never --profile "$PROFILE" \
  -c openmetadata-url="$OM_URL" \
  -c genbi-backend=agentcore \
  -c genbi-runtime-arn="${RT_ARN[genbi]}" \
  -c genbi-memory-backend=agentcore \
  -c genbi-memory-id="${MEM_ID[genbi]}" \
  -c netadvisor-backend=agentcore \
  -c netadvisor-runtime-arn="${RT_ARN[netadvisor]}" \
  -c netadvisor-memory-backend=agentcore \
  -c netadvisor-memory-id="${MEM_ID[netadvisor]}" \
  -c paramadvisor-backend=agentcore \
  -c paramadvisor-runtime-arn="${RT_ARN[paramadvisor]}" \
  -c paramadvisor-memory-backend=agentcore \
  -c paramadvisor-memory-id="${MEM_ID[paramadvisor]}" \
  -c execution-regions="$EXEC_REGIONS" \
  --output "/tmp/cdk-out-platform-${PROFILE}"   # B-78:按 profile 分目录 —— 同机两条部署链(两个账号)并行到这一步不再互撞「Other CLIs are currently reading from …」

PLATFORM_URL=$(out BgpPlatformStack PlatformUrl)

# 防回归根治:把这次部署用的 AI 接线固化到 SSM /bgp/wiring/*(期望接线的持久事实源)。
# 目的:此后任何一次【裸 cdk deploy BgpPlatformStack】(忘带上面那一长串 -c)都会由
# infra/bin/app.ts 的 wiring 自愈段从 SSM 读回补齐,不再把接线静默冲成空值。
info "Persisting AI wiring to SSM /bgp/wiring/* (self-heal source for bare re-deploys)"
ssm_put() { aws ssm put-parameter --name "$1" --value "$2" --type String --overwrite \
              --profile "$PROFILE" --region "$REGION" >/dev/null 2>&1 || info "  WARN: ssm put $1 failed"; }
ssm_put /bgp/wiring/openmetadata-url            "$OM_URL"
ssm_put /bgp/wiring/genbi-backend               "agentcore"
ssm_put /bgp/wiring/genbi-runtime-arn           "${RT_ARN[genbi]}"
ssm_put /bgp/wiring/genbi-memory-backend        "agentcore"
ssm_put /bgp/wiring/genbi-memory-id             "${MEM_ID[genbi]}"
ssm_put /bgp/wiring/netadvisor-backend          "agentcore"
ssm_put /bgp/wiring/netadvisor-runtime-arn      "${RT_ARN[netadvisor]}"
ssm_put /bgp/wiring/netadvisor-memory-backend   "agentcore"
ssm_put /bgp/wiring/netadvisor-memory-id        "${MEM_ID[netadvisor]}"
ssm_put /bgp/wiring/paramadvisor-backend        "agentcore"
ssm_put /bgp/wiring/paramadvisor-runtime-arn    "${RT_ARN[paramadvisor]}"
ssm_put /bgp/wiring/paramadvisor-memory-backend "agentcore"
ssm_put /bgp/wiring/paramadvisor-memory-id      "${MEM_ID[paramadvisor]}"

# 🔴 序 43 B-91:S3 Tables 联邦目录 s3tablescatalog(Athena 直查 / 问数的数据湖入口)不是 CDK 资源,首装必须显式开通。
#   原来只有「同步任务写 S3 Tables」的启动路径懒创建 ⇒ 没跑过那种同步的全新账号,直查 / 问数一律 CATALOG_NOT_FOUND
#   (2026-10-16 全新账号页面驱动坐实)。幂等:已在则秒过。执行区的目录由加区后的 redeploy-platform.sh 第 3c 步开通。
s3tables_catalog_step() { ( ensure_s3tables_catalog "$REGION" ); }   # 子 shell:lib 里的 die 只结束这一步,由 run_step 记账
run_step "6.3) S3 Tables 联邦目录 s3tablescatalog(主控区)" s3tables_catalog_step

# 🔴 生产上线批次 A:OM 出厂口令 admin/admin 对公网可达 ⇒ 平台栈就位后立刻换成 Secrets Manager 里的随机口令
#   (平台 / 问数技能从同一个密钥读;幂等,带「新口令能登 ∧ 出厂口令不能登」验证)。
run_step "6.4) OM 管理员口令加固" "$HERE/om-secure-admin.sh" "$PROFILE" "$REGION"

###############################################################################
say "6.5) Execution-environment deploy mechanism (BgpExecEnvDeployStack: broker + CodeBuild)"
###############################################################################
# 🔴 根治(2026-09-06 新账号真跑撞出):向导「新建执行环境」注册成功、自动「触发部署」报
#   `Function not found: …:function:bgp-exec-env-broker` —— 本脚本从未部署过 BgpExecEnvDeployStack
#   (窄权 broker Lambda + exec-env 专用 CodeBuild 项目 + 源包 asset),旧账号是 P50.2g 时手工发的。
#   一个全新账号跑完 deploy-all,产品的多区域能力**整条断掉**而 13 步全绿 = 假就位。
#   它依赖 BgpDatabaseStack(bgp-execution-envs / bgp-audit 表)+ BgpKmsStack(表 CMK),放在平台栈之后、
#   MWAA 之前;源包按内容哈希不可变 ⇒ 无改动时秒级 no-op。第 13 步会核它**真在**(缺则自愈补发)。
#   单一作者:首装在这里,之后每次 scripts/redeploy-platform.sh §2b 随 HEAD 刷新源包,mr-gate 只调后者。
run_step "6.5) BgpExecEnvDeployStack(执行环境部署机制)" \
  npx cdk deploy BgpExecEnvDeployStack --require-approval never --profile "$PROFILE"

###############################################################################
say "6.6) MWAA Serverless entry for home (BgpAirflowServerlessStack: bucket + SG + role, minutes, no environment)"
###############################################################################
# @kf-batch 50-WP15-airflow-serverless:用户拍板「经典 MWAA 保留、新增 serverless 入口」;home 是两区验收之一。
#   seed-home(11.5 步)按 SSOT 名探到桶 / 角色 / SG 才在 home 描述符声称 airflow-serverless。redeploy-platform §2c 随 HEAD 刷新。
run_step "6.6) BgpAirflowServerlessStack(home 的 MWAA Serverless 入口)" \
  npx cdk deploy BgpAirflowServerlessStack --require-approval never --profile "$PROFILE"

###############################################################################
say "7) 经典 MWAA(Airflow)—— 🔴 **默认不再部署**(用户 2026-09-14 拍板:一律走 MWAA Serverless)"
###############################################################################
# 为什么去掉:经典 MWAA 是**常驻**环境(≈$350/月,建栈 ~30 min,是本脚本最长的一步);
# 而 MWAA Serverless 按任务秒计费、建栈分钟级(第 6.6 步),平台侧调度/编排语义已由 WP-17 统一到它。
# 🔴 栈类仍在 infra 里(存量账号那一个要能被认领与删除),只是不再默认实例化。
# 需要它时:DEPLOY_CLASSIC_MWAA=1 ./scripts/deploy-all.sh …
if [[ "${DEPLOY_CLASSIC_MWAA:-0}" == "1" ]]; then
  npx cdk deploy BgpMwaaStack --require-approval never --profile "$PROFILE" \
    -c classic-mwaa=1 -c openmetadata-url="$OM_URL"
else
  info "跳过经典 MWAA(默认)—— 调度走第 6.6 步的 BgpAirflowServerlessStack;要装经典版设 DEPLOY_CLASSIC_MWAA=1"
fi

###############################################################################
say "8) Audit stack (CloudTrail + VPC Flow Logs)"
###############################################################################
# Some organisation SCPs forbid creating a trail; SKIP_CLOUDTRAIL=1 keeps Flow
# Logs while skipping the trail so the deploy still succeeds.
npx cdk deploy BgpAuditStack --require-approval never --profile "$PROFILE" \
  -c skip-cloudtrail="${SKIP_CLOUDTRAIL:-0}"

###############################################################################
say "9) Real-time / compute stacks (ON by default; ≈zero standing cost after refactor)"
###############################################################################
if [ "${DEPLOY_REALTIME:-1}" = "1" ]; then
  info "BgpRealtimeStack (module 31 DMS durable base — subnet group/SG/roles; instance lazy-created)"
  # skip-dms-roles=1: dms-vpc-role etc. are created account-level by 00-prereqs.
  npx cdk deploy BgpRealtimeStack --require-approval never --profile "$PROFILE" \
    -c enable-realtime=1 -c skip-dms-roles=1
else
  info "BgpRealtimeStack skipped (DEPLOY_REALTIME=0)."
fi

if [ "${DEPLOY_FLINK:-1}" = "1" ]; then
  info "BgpFlinkStack (module 32 Flink/MSAF service role)"
  npx cdk deploy BgpFlinkStack --require-approval never --profile "$PROFILE" -c enable-flink=1
else
  info "BgpFlinkStack skipped (DEPLOY_FLINK=0)."
fi

if [ "${DEPLOY_EMR:-1}" = "1" ]; then
  info "BgpEmrStack (module 33 EMR Serverless exec role)"
  npx cdk deploy BgpEmrStack --require-approval never --profile "$PROFILE" -c enable-emr=1
else
  info "BgpEmrStack skipped (DEPLOY_EMR=0)."
fi

###############################################################################
say "10) OpenMetadata ingestion connectors (optional)"
###############################################################################
if [ "${OM_INGESTION:-0}" = "1" ]; then
  # 🔴 数仓管理员密钥优先取**执行环境注册表**(平台自己用的就是这一份 `resources.redshiftSecretArn`):
  #   ①不靠派生名去猜(`redshift!bgp-namespace-admin` 换 namespace 就断,记忆 fresh-account-first-install-traps)
  #   ②不依赖操作者的 `secretsmanager:DescribeSecret`(受限账号里这条常被整片裁掉)。
  RS_ADMIN_ARN=$(aws dynamodb get-item --table-name bgp-execution-envs --profile "$PROFILE" --region "$REGION" \
    --key '{"pk":{"S":"env"},"sk":{"S":"tgt_home"}}' \
    --query 'Item.resources.M.redshiftSecretArn.S' --output text 2>/dev/null)
  [ -n "$RS_ADMIN_ARN" ] && [ "$RS_ADMIN_ARN" != "None" ] || RS_ADMIN_ARN=$(aws secretsmanager describe-secret --secret-id 'redshift!bgp-namespace-admin' \
    --profile "$PROFILE" --region "$REGION" --query ARN --output text)
  OM_BOT_ARN=$(aws secretsmanager describe-secret --secret-id bgp/om/ingestion-bot-token \
    --profile "$PROFILE" --region "$REGION" --query ARN --output text)
  npx cdk deploy BgpOmIngestionStack --require-approval never --profile "$PROFILE" \
    -c openmetadata-url="$OM_URL" \
    -c om-bot-secret-arn="$OM_BOT_ARN" -c rs-admin-secret-arn="$RS_ADMIN_ARN"
else
  info "BgpOmIngestionStack skipped (set OM_INGESTION=1 to enable)."
fi

###############################################################################
say "10.6) Compute-engine jars (EMR S3Tables runtime + Flink SQL runner)"
###############################################################################
# BUG-G3/G4 修复:平台 env 指向脚本桶里的引擎 jar,但此前 deploy 无上传步骤,新账号从零部署后
# EMR 读 S3Table(FileNotFound)/ Flink 作业启动(invalid S3 location)必挂。此处幂等上传全部引擎 jar。
SCRIPTS_BUCKET="bgp-glue-scripts-$ACCOUNT"

# (a) EMR S3 Tables runtime jar —— EMR 默认 classpath 无 S3TablesCatalog,必须 --jars 挂它(Maven Central)。
# 版本与 Flink(flink-sql-runner-s3t 0.1.8)对齐,消除三引擎 catalog jar 漂移(三引擎验证专项 V4)。
EMR_JAR_VERSION="0.1.8"
EMR_JAR="s3-tables-catalog-for-iceberg-runtime-${EMR_JAR_VERSION}.jar"
if aws s3 ls "s3://$SCRIPTS_BUCKET/emr-jars/$EMR_JAR" --profile "$PROFILE" --region "$REGION" >/dev/null 2>&1; then
  info "EMR S3Tables jar already present."
else
  curl -sSL -o "/tmp/$EMR_JAR" "https://repo1.maven.org/maven2/software/amazon/s3tables/s3-tables-catalog-for-iceberg-runtime/${EMR_JAR_VERSION}/$EMR_JAR" \
    && aws s3 cp "/tmp/$EMR_JAR" "s3://$SCRIPTS_BUCKET/emr-jars/$EMR_JAR" --profile "$PROFILE" --region "$REGION" >/dev/null \
    && info "EMR S3Tables jar uploaded." \
    || info "WARNING: EMR S3Tables jar provisioning failed — EMR reading S3 Tables will error."
fi

# (b) Flink SQL runner jars —— MSAF 应用从脚本桶 flink/ 读 runner(基础 + s3table sink 用的 s3t 版)。
# ⚠️ 根因治理: jar 是 mvn 构建产物,且 flink-sql-runner{,-s3t}/.gitignore 排除了 target/ 与 *.jar,
#    所以【git clone 不带 jar】。此前注释误以为"jar 已随 repo 带来",全新账号从 GitHub 干净部署时
#    走"not found"分支只 WARNING 不构建 → S3 无 jar → 所有 Flink 作业启动即 error(取不到 fileKey)。
#    修法: 缺 jar 时若有 mvn 则【自动构建】再上传;无 mvn 才 WARNING。与从零部署对齐。
# Bug#5:flink-sql-runner-s3t-kafka = Kafka/MSK 源 → S3Tables 组合包(s3t + kafka + msk-iam-auth + relocation)。
# 装配路由对"kafka源+iceberg sink"选它(FLINK_S3T_KAFKA_CODE_KEY);同其它 runner 缺 jar 现构建再上传。
for pair in "flink-sql-runner:flink/flink-sql-runner.jar" \
            "flink-sql-runner-s3t:flink/flink-sql-runner-s3t.jar" \
            "flink-sql-runner-s3t-kafka:flink/flink-sql-runner-s3t-kafka.jar"; do
  MOD="${pair%%:*}"; KEY="${pair##*:}"; SRCDIR="$ROOT/$MOD"; SRC="$SRCDIR/target/$(basename "$KEY")"
  if aws s3 ls "s3://$SCRIPTS_BUCKET/$KEY" --profile "$PROFILE" --region "$REGION" >/dev/null 2>&1; then
    info "Flink jar already present ($KEY)."; continue
  fi
  if [ ! -f "$SRC" ] && [ -f "$SRCDIR/pom.xml" ] && command -v mvn >/dev/null 2>&1; then
    info "Flink jar missing — building $MOD via mvn (git clone omits target/*.jar; ~2-5min)..."
    ( cd "$SRCDIR" && mvn -q -B -DskipTests package ) \
      || info "WARNING: mvn build failed ($MOD) — Flink $KEY unavailable."
  fi
  if [ -f "$SRC" ]; then
    aws s3 cp "$SRC" "s3://$SCRIPTS_BUCKET/$KEY" --profile "$PROFILE" --region "$REGION" >/dev/null \
      && info "Flink jar uploaded ($KEY)." \
      || info "WARNING: Flink jar upload failed ($KEY)."
  else
    info "WARNING: Flink jar not found & not built ($SRC) — install Maven+JDK17 or Flink jobs will fail to start."
  fi
done

# (c) Flink 连接器模块 jar(flink/modules/)—— MSK/Kafka 源【强制走模块化拼装】(两个胖包均未打 kafka
#     connector),启动时 assembleModularUberJar 从 flink/modules/ 读 base + 按 SQL 解析的模块(kafka/
#     msk-iam-auth/files/json/kinesis/iceberg-s3tables)合并成 uber jar。
#     ⚠️ 根因治理(同 (b)):这些 jar 是 mvn 构建产物且 .gitignore 排除 target/*.jar,git clone 不带;
#        此前 deploy 无上传步骤 → S3 flink/modules/ 为空 → 所有 MSK/Kafka 源作业启动即 error
#        (assembleModularUberJar 的 s3GetBuffer 抛 "The specified key does not exist")。
#        修法:遍历 flink-connector-modules/*,缺 jar 则 mvn 构建,幂等上传到 flink/modules/。
for MDIR in "$ROOT"/flink-connector-modules/*/; do
  [ -d "$MDIR" ] || continue
  MID="$(basename "$MDIR")"; MJAR="flink-module-${MID}.jar"; MSRC="$MDIR/target/$MJAR"; MKEY="flink/modules/$MJAR"
  if aws s3 ls "s3://$SCRIPTS_BUCKET/$MKEY" --profile "$PROFILE" --region "$REGION" >/dev/null 2>&1; then
    info "Flink module jar already present ($MKEY)."; continue
  fi
  if [ ! -f "$MSRC" ] && [ -f "$MDIR/pom.xml" ] && command -v mvn >/dev/null 2>&1; then
    info "Flink module jar missing — building $MID via mvn (~1-3min)..."
    ( cd "$MDIR" && mvn -q -B -DskipTests package ) \
      || info "WARNING: mvn build failed ($MID) — Flink module $MKEY unavailable."
  fi
  if [ -f "$MSRC" ]; then
    aws s3 cp "$MSRC" "s3://$SCRIPTS_BUCKET/$MKEY" --profile "$PROFILE" --region "$REGION" >/dev/null \
      && info "Flink module jar uploaded ($MKEY)." \
      || info "WARNING: Flink module jar upload failed ($MKEY)."
  else
    info "WARNING: Flink module jar not found & not built ($MSRC) — MSK/Kafka source Flink jobs will fail to start."
  fi
done

###############################################################################
say "11) Cognito groups + initial users"
###############################################################################
# 🔴 受限账号(WSParticipantRole / Event Engine 之类)常把 cognito-idp 的 Admin* 写权限裁掉,
# 此步会失败。**不再中止整个部署**(基础设施已就绪,造数与接线体检必须继续跑);
# 失败记账、收尾非零退出,补跑方式见 docs/DEPLOY-RUNBOOK.md §3(绕法)+ §4(补跑)。
run_step "11) Cognito 建组建号" "$HERE/10-bootstrap-cognito.sh" "$PROFILE" "$REGION"

###############################################################################
say "11.5) Seed the home execution target (registry row for tgt_home)"
###############################################################################
# 🔴 根治 K-4(2026-09-06 新账号真撞):执行环境注册表里**没有 home 条目**,页面 🏠 卡是空壳、每个组件都显示 ✗
#   (用户以为 MWAA 没装)。50 SPEC §1.1 早定「home seed 时机定死在部署期,平台读路径只读、绝不自愈写库」,
#   但 deploy-all 从未做这一步(旧账号是管理员手点「初始化 home 环境」)。
#   做法 = 用 admin IdToken 调同一个显式管理动作 POST /api/admin/exec-envs/seed-home(服务端真探 13 项全绿才落库;
#   幂等:已存在按位置比对,不重复写)。依赖 admin 口令 BGP_ADMIN_PASSWORD(与第 11 步同源;未设则本步记账失败并给出补跑方式)。
seed_home() {
  local client token pw resp
  client=$(out BgpAuthStack ClientId)
  # 🔴 口令来源顺序:显式 env → 第 11 步落盘的 JSON(见 10-bootstrap-cognito.sh 里那段注释)。
  #   原来只看 env ⇒ 随机口令生成在子进程里,这一步**必然**读不到(全新账号首装每次都栽在这)。
  pw="${BGP_ADMIN_PASSWORD:-}"
  if [ -z "$pw" ]; then
    pw="$(python3 - "${BGP_PW_FILE:-/tmp/bgp-cognito-pw-${PROFILE}.json}" <<'PYPW'
import json, sys
try:
    print(json.load(open(sys.argv[1]))["admin"])
except Exception:
    pass
PYPW
)"
    [ -n "$pw" ] && info "  admin 口令取自 ${BGP_PW_FILE:-/tmp/bgp-cognito-pw-${PROFILE}.json}(第 11 步落盘)"
  fi
  [ -n "$client" ] && [ "$client" != "None" ] || { echo "❌ 读不到 BgpAuthStack ClientId"; return 1; }
  [ -n "$pw" ] || { echo "❌ 拿不到 admin 口令:env BGP_ADMIN_PASSWORD 未设,且 ${BGP_PW_FILE:-/tmp/bgp-cognito-pw-${PROFILE}.json} 里也没有(第 11 步是不是没跑成?)—— 补跑:export BGP_ADMIN_PASSWORD=… 后重跑本步,或登录「执行环境」页点「初始化 home 环境」"; return 1; }
  token=$(aws cognito-idp initiate-auth --profile "$PROFILE" --region "$REGION" --auth-flow USER_PASSWORD_AUTH \
            --client-id "$client" --auth-parameters USERNAME=admin,PASSWORD="$pw" \
            --query 'AuthenticationResult.IdToken' --output text 2>/dev/null)
  [ -n "$token" ] && [ "$token" != "None" ] || { echo "❌ admin 取 IdToken 失败"; return 1; }
  # 平台刚滚动完可能还在预热:重试 6 次
  local i
  for i in 1 2 3 4 5 6; do
    resp=$(curl -sS --max-time 180 -H "Authorization: Bearer $token" -H "Content-Type: application/json" \
             -X POST "${PLATFORM_URL%/}/api/admin/exec-envs/seed-home" 2>/dev/null || true)
    if printf '%s' "$resp" | grep -q '"success":true'; then
      info "  home 已 seed:$(printf '%s' "$resp" | python3 -c 'import json,sys; d=json.load(sys.stdin)["data"]; print(d.get("targetId"), (d.get("outcome") or {}).get("outcome"), "probe", len((d.get("probe") or {}).get("items", [])), "items")' 2>/dev/null)"
      return 0
    fi
    echo "  (第 $i 次)seed-home 未成功:$(printf '%s' "$resp" | head -c 300)"
    sleep 20
  done
  return 1
}
run_step "11.5) home seed(执行环境注册表 tgt_home)" seed_home

###############################################################################
say "12) Seed the golden e-commerce dataset (optional)"
###############################################################################
# Loads products=50 / fx_rates=70 / orders=100000 / order_items=~299778 into the
# source MySQL via an in-VPC Glue job, so sync / compute / GenBI demos have data.
# 🔴 生产上线批次 A:缺省跟随部署模式(demo ⇒ 造数;production ⇒ 不造,而且也没有演示源库可造)。
SEED_DEFAULT=0; [ "$BGP_DEPLOY_MODE" = "demo" ] && SEED_DEFAULT=1
if [ "$BGP_DEPLOY_MODE" = "production" ] && [ "${SEED_DATA:-0}" = "1" ]; then
  info "⚠️ 生产模式不造数(没有演示源库):已忽略 SEED_DATA=1"
  SEED_DATA=0
fi
if [ "${SEED_DATA:-$SEED_DEFAULT}" = "1" ]; then
  # 造数本就标注 optional(SEED_DATA=0 可跳),它失败**不该**把必跑的第 13 步接线体检带走。
  run_step "12) 电商造数" "$HERE/20-seed-data.sh" "$PROFILE" "$REGION"
else
  info "Data seeding skipped (SEED_DATA=0). Run scripts/20-seed-data.sh later to load it."
fi

###############################################################################
say "13) Post-deploy wiring gate — 接线体检 + 自动自愈(防无声降级)"
###############################################################################
# 防回归根治(自愈层3):部署收尾核对平台容器实际生效的接线 env。若发现异常(如被后续
# 连带部署冲回 inprocess/空),【自动调 redeploy-platform.sh 重接线一次并复检】,而非
# 只报警等人工。这样即便前两层(export AWS_PROFILE / app.ts 自愈)有遗漏,收尾也保证
# 最终状态正确 —— 全球用户零感知。仍失败才提示人工介入。
# 体检函数:返回异常项数(0=全绿)。$1=可选静默标记。
# 🔴🔴 2026-09-17:这个体检**曾经会 fail-open** —— `2>/dev/null` + 「查不到就 return 0」
#   把三件事压成一件:①接线正常 ②真没有 TaskDef ③**我没有权限看**。
#   在受限账号里(实测某空账号 `ecs:*` 全拒)它会打印「跳过体检」然后**报全绿**,
#   而平台的 AI 接线到底是不是空的**没有任何人看过**。三态必须分开(见记忆 gate-must-separate-crash-from-fail)。
WIRING_BLIND=0
wiring_check() {
  local td bad=0 var want val err
  err="$(mktemp)"
  td=$(aws ecs list-task-definitions --profile "$PROFILE" --region "$REGION" \
    --query 'taskDefinitionArns' --output text 2>"$err" | tr '\t' '\n' | grep -i BgpPlatformStackBgpServiceTaskDef | tail -1)
  if [ -z "$td" ] && grep -qiE 'AccessDenied|not authorized|explicit deny' "$err"; then
    WIRING_BLIND=1
    rm -f "$err"
    [ "${1:-}" = "quiet" ] || printf '   \033[1;33m⚠️ 接线体检**无法执行**:这个身份没有 ecs 读权限(不是「正常」,是「没看过」)\033[0m\n'
    return 0
  fi
  rm -f "$err"
  [ -n "$td" ] || { [ "${1:-}" = "quiet" ] || info "  (未找到 Platform TaskDef,跳过体检)"; return 0; }
  for pair in "OPENMETADATA_URL:https" "GENBI_BACKEND:agentcore" "GENBI_RUNTIME_ARN:runtime/" \
              "NETADVISOR_RUNTIME_ARN:runtime/" "PARAMADVISOR_RUNTIME_ARN:runtime/"; do
    var="${pair%%:*}"; want="${pair##*:}"
    val=$(aws ecs describe-task-definition --task-definition "$td" --profile "$PROFILE" --region "$REGION" \
      --query "taskDefinition.containerDefinitions[0].environment[?name=='$var'].value" --output text 2>/dev/null)
    if printf '%s' "$val" | grep -q "$want"; then
      [ "${1:-}" = "quiet" ] || info "  ✓ $var"
    else
      [ "${1:-}" = "quiet" ] || printf '   \033[1;31m✗ %s 接线缺失/异常(期望含 "%s",实际="%s")\033[0m\n' "$var" "$want" "$val"
      bad=$((bad+1))
    fi
  done
  return $bad
}
# 🔴 执行环境部署机制体检(2026-09-06 根治配套,与第 6.5 步成对):broker Lambda + CodeBuild 项目**必须真在**,
#   否则向导「开始部署」必报 Function not found,而其余步骤全绿。查不到 ⇒ 自愈 = 补发该栈,再核一次;仍缺才记账。
# 🔴 2026-09-17:原版把「权限被拒」当成「对象不存在」⇒ 在受限账号里会**误诊**
#   (报「BgpExecEnvDeployStack 未部署」、白补发一次栈、最后记一笔假失败)。
#   替代真值源用 **CFN 资源清单**(cloudformation 读权限是这类账号唯一稳定有的):
#   栈自己知道它建过哪个 Lambda / 哪个 CodeBuild 项目。
cfn_has_resource() {  # $1=栈 $2=资源类型 $3=物理名
  aws cloudformation describe-stack-resources --stack-name "$1" --profile "$PROFILE" --region "$REGION" \
    --query "StackResources[?ResourceType=='$2'].PhysicalResourceId" --output text 2>/dev/null \
    | tr '\t' '\n' | grep -qx "$3"
}
mechanism_check() {
  local bad=0 proj
  if aws lambda get-function-configuration --function-name bgp-exec-env-broker --profile "$PROFILE" --region "$REGION" >/dev/null 2>&1 \
     || cfn_has_resource BgpExecEnvDeployStack AWS::Lambda::Function bgp-exec-env-broker; then
    [ "${1:-}" = "quiet" ] || info "  ✓ broker Lambda bgp-exec-env-broker"
  else
    [ "${1:-}" = "quiet" ] || printf '   \033[1;31m✗ broker Lambda bgp-exec-env-broker 不存在(BgpExecEnvDeployStack 未部署 ⇒ 新建执行环境必报 Function not found)\033[0m\n'
    bad=$((bad+1))
  fi
  proj=$(aws codebuild batch-get-projects --names bgp-exec-env-deploy --profile "$PROFILE" --region "$REGION" \
           --query 'projects[0].name' --output text 2>/dev/null || true)
  if [ "$proj" != "bgp-exec-env-deploy" ] && cfn_has_resource BgpExecEnvDeployStack AWS::CodeBuild::Project bgp-exec-env-deploy; then
    proj=bgp-exec-env-deploy   # 直连读不了(权限)⇒ 用栈的资源清单坐实
  fi
  if [ "$proj" = "bgp-exec-env-deploy" ]; then
    [ "${1:-}" = "quiet" ] || info "  ✓ CodeBuild 项目 bgp-exec-env-deploy"
  else
    [ "${1:-}" = "quiet" ] || printf '   \033[1;31m✗ CodeBuild 项目 bgp-exec-env-deploy 不存在\033[0m\n'
    bad=$((bad+1))
  fi
  return $bad
}
if mechanism_check; then
  info "执行环境部署机制: 正常 ✅"
else
  printf '   \033[1;33m执行环境部署机制缺失 —— 自动补发 BgpExecEnvDeployStack…\033[0m\n'
  if npx cdk deploy BgpExecEnvDeployStack --require-approval never --profile "$PROFILE" >/dev/null 2>&1 && mechanism_check quiet; then
    info "执行环境部署机制: 自愈成功 ✅(已补发 BgpExecEnvDeployStack)"
  else
    note_failure "13) 执行环境部署机制: 补发 BgpExecEnvDeployStack 后仍缺 broker/CodeBuild —— 手动:(cd infra && npx cdk deploy BgpExecEnvDeployStack --profile $PROFILE)"
  fi
fi
# 🔴 home 条目体检(K-4 配套):注册表里 tgt_home 必须在,否则页面 🏠 卡是空壳(每个组件 ✗)、多区域功能全部无 home 基准。
if aws dynamodb get-item --profile "$PROFILE" --region "$REGION" --table-name bgp-execution-envs \
     --key '{"pk":{"S":"env"},"sk":{"S":"tgt_home"}}' --query 'Item.targetId.S' --output text 2>/dev/null | grep -q '^tgt_home$'; then
  info "home 执行目标: 已在注册表 ✅"
else
  printf '   \033[1;33mhome 执行目标缺失 —— 自动 seed…\033[0m\n'
  if seed_home; then info "home 执行目标: 自愈成功 ✅"; else note_failure "13) home 执行目标缺失且自动 seed 失败 —— 登录后在「执行环境」页点「初始化 home 环境」"; fi
fi
if wiring_check && [ "$WIRING_BLIND" = "1" ]; then
  note_failure "13) 接线体检**没有执行**(ecs 读权限被拒)—— 这不是过关,是没看见:换一个有 ecs:Describe* 的身份复核,或对比 SSM /bgp/wiring/* 与容器实际 env"
elif [ "$WIRING_BLIND" = "0" ] && wiring_check quiet; then
  info "接线体检: 全部正常 ✅"
else
  printf '   \033[1;33m接线体检发现异常 —— 自动调用 redeploy-platform.sh 重接线…\033[0m\n'
  # 🔴 退 3 = 重接线做完了、但 IAM 模拟门**没能执行**(权限/环境)⇒ 不是执行失败,按登记项记账。
  set +e; "$HERE/redeploy-platform.sh" "$PROFILE" "$REGION" >/dev/null 2>&1; RP_RC=$?; set -e
  if [ "$RP_RC" = "3" ]; then
    note_failure "13) 重接线已做,但 IAM 模拟门未执行(权限/环境)—— 换有 ecs:Describe* + iam:SimulatePrincipalPolicy 的身份复核"
  fi
  if [ "$RP_RC" = "0" ] || [ "$RP_RC" = "3" ]; then
    if wiring_check quiet; then
      info "接线体检: 自愈成功,全部正常 ✅(已自动重接线)"
    else
      # 🔴 查出异常 + 自愈也没救回来 ⇒ 平台是**无声降级**状态(页面能开、AI 接线是空的)。
      # 以前这里只打红字然后 exit 0,等于把"脚本成功"和"平台可用"脱钩。现在记账。
      note_failure "13) 接线体检: 自动重接线后仍异常 —— 手动排查 scripts/redeploy-platform.sh + 查 AgentCore Runtime 是否就绪"
    fi
  else
    note_failure "13) 接线体检: 自动重接线执行失败 —— 手动跑 scripts/redeploy-platform.sh $PROFILE $REGION"
  fi
fi

###############################################################################
if [ "${#FAILED_STEPS[@]}" -gt 0 ]; then
  say "部署收尾:有 ${#FAILED_STEPS[@]} 步未成功(基础设施可能已就绪,但本次部署判为失败)"
else
  say "Done."
fi
###############################################################################
info "Platform URL     : $PLATFORM_URL"
info "OpenMetadata URL : $OM_URL"
info "Log in with the admin user created in step 11."
info "接线体检 / 排障: 登录后打开 /settings 页「AI 接线健康」卡片,或 GET /api/system/wiring。"
info "若接线异常(OM 报错 / GenBI skill 不命中 / 顾问退回进程内): scripts/redeploy-platform.sh $PROFILE $REGION"

# 🔴 退出码 = 真实结论(不再"有红字也 exit 0")。判据与补跑见 docs/DEPLOY-RUNBOOK.md §4/§5。
if [ "${#FAILED_STEPS[@]}" -gt 0 ]; then
  printf '\n\033[1;31m未成功的步骤(%d):\033[0m\n' "${#FAILED_STEPS[@]}"
  for s in "${FAILED_STEPS[@]}"; do printf '   - %s\n' "$s"; done
  info "以上失败**不影响**已就绪的栈;按 docs/DEPLOY-RUNBOOK.md §4 单独补跑对应脚本即可。"
  exit 1
fi
info "退出码 0 仍不等于'真就位' —— 跑 scripts/02-postdeploy-truth.sh $PROFILE $REGION(10 条真值判据;docs/DEPLOY-RUNBOOK.md §5)。"
