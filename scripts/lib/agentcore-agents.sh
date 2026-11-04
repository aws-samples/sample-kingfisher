#!/usr/bin/env bash
###############################################################################
# scripts/lib/agentcore-agents.sh —— 三个 AgentCore 智能体(问数 genbi · 网络顾问 netadvisor · 参数顾问 paramadvisor)
#   的**唯一事实源**:栈名 / 容器源目录 / 栈输出名 / CDK context 名,以及三个共用函数:
#     agentcore_build_push_images <tag> [agent…]   构建并推送 ARM64 镜像(deploy-all 第 4 步)
#     agentcore_deploy_runtimes   <tag> [agent…]   逐个部署智能体栈,让 Runtime 指向该 tag(deploy-all 第 5 步)
#     agentcore_deployed_tag      <agent>          只读:现网 Runtime 正在用的镜像 tag(读不到 ⇒ 空 + 返回 1)
#
# 🔴 为什么抽出来(B-76,2026-10-14):映射表原来在 deploy-all.sh(全套)与 redeploy-platform.sh(三张)各写一份;
#   而升级路径 redeploy-platform.sh **不重建**智能体镜像、**不部署**智能体栈 ⇒ 改了 infra/agent/** 或
#   platform/src/lib/<cap>/core · lib/cookbook 的版本,按手册升级后智能体仍跑旧代码(10-12 → 10-13 的问数配方就是)。
#   现在 deploy-all.sh 第 4 / 5 步、redeploy-platform.sh 第 1 步、redeploy-agents.sh 三处都 source 本文件,
#   加一个智能体只改这里一处。
#
# 使用约定(source 本文件的一方必须**先**定义好):
#   变量 PROFILE REGION ROOT        —— aws profile / 主控区 / 仓库根(绝对路径)
#   函数 info() die() out()          —— 一行打印 / 失败退出 / 读栈输出 `out <栈> <OutputKey>`(deploy-all 与 redeploy-platform 同形)
#   本文件只定义,不执行:不 set -e、不改 cwd(进 infra/ 的地方都在子 shell 里)。
###############################################################################

# The three AI capabilities share one build/deploy shape (module 28 standard).
AGENTS=(genbi netadvisor paramadvisor)
declare -A A_STACK=(  [genbi]=BgpAgentCoreStack            [netadvisor]=BgpNetAdvisorAgentCoreStack       [paramadvisor]=BgpParamAdvisorAgentCoreStack )
declare -A A_DIR=(    [genbi]=agent/genbi                  [netadvisor]=agent/netadvisor                  [paramadvisor]=agent/paramadvisor )
declare -A A_ECR=(    [genbi]=GenbiEcrRepoUri              [netadvisor]=NetAdvisorEcrRepoUri              [paramadvisor]=ParamAdvisorEcrRepoUri )
declare -A A_RT_CTX=( [genbi]=genbi-runtime                [netadvisor]=netadvisor-runtime                [paramadvisor]=paramadvisor-runtime )
declare -A A_TAG_CTX=([genbi]=genbi-agent-tag              [netadvisor]=netadvisor-agent-tag              [paramadvisor]=paramadvisor-agent-tag )
declare -A A_RT_OUT=( [genbi]=GenbiRuntimeArn              [netadvisor]=NetAdvisorRuntimeArn              [paramadvisor]=ParamAdvisorRuntimeArn )
declare -A A_MEM_OUT=([genbi]=GenbiMemoryId               [netadvisor]=NetAdvisorMemoryId               [paramadvisor]=ParamAdvisorMemoryId )
declare -A A_BACKEND=([genbi]=genbi                        [netadvisor]=netadvisor                        [paramadvisor]=paramadvisor )

# 镜像内容来自哪些源码目录(供 redeploy-agents.sh --check 判断「两版之间智能体有没有变」):
#   容器目录本身 + 共用 runtime 件 + 各能力 core 的 TS 源(由 scripts/core-prebuild.sh 编译进 core-dist;
#   编译侧的目录清单是该脚本的 CAP_CORE_SRC,这里列同一组路径只用来 diff,不参与编译)。
AGENT_SOURCE_PATHS=(
  infra/agent
  platform/src/lib/genbi/core
  platform/src/lib/param-advisor/core
  platform/src/lib/network-advisor/core
  platform/src/lib/cookbook
  platform/src/lib/ai/core
)

# 构建并推送镜像(linux/arm64;AgentCore Runtime 只认 arm64,多数构建机是 x86_64 ⇒ buildx + QEMU)。
# --provenance/--sbom=false:产出单平台 manifest 而不是带 attestation 子清单的 OCI index,
# 后者 Runtime 按 tag 拉取时可能解析失败。tag = $1(git 短哈希);其后可选只构建列出的智能体。
agentcore_build_push_images() {
  local tag="$1"; shift
  local -a list=("$@"); [ ${#list[@]} -gt 0 ] || list=("${AGENTS[@]}")
  docker buildx inspect multiarch >/dev/null 2>&1 || docker buildx create --name multiarch --use >/dev/null
  # One ECR login is enough — all repos are in this account's single registry.
  local sample host
  sample=$(out "${A_STACK[genbi]}" "${A_ECR[genbi]}")
  { [ -n "$sample" ] && [ "$sample" != "None" ]; } \
    || die "读不到 ${A_STACK[genbi]} 的输出 ${A_ECR[genbi]}(智能体基础栈还没部署?先跑 deploy-all.sh)"
  host="${sample%%/*}"
  aws ecr get-login-password --profile "$PROFILE" --region "$REGION" \
    | docker login --username AWS --password-stdin "$host" || die "ECR 登录失败($host)"
  local a uri mt
  for a in "${list[@]}"; do
    uri=$(out "${A_STACK[$a]}" "${A_ECR[$a]}")
    { [ -n "$uri" ] && [ "$uri" != "None" ]; } || die "读不到 ${A_STACK[$a]} 的输出 ${A_ECR[$a]}"
    info "build $a -> $uri:$tag"
    docker buildx build --builder multiarch --platform linux/arm64 --provenance=false --sbom=false \
      -t "$uri:$tag" --push "$ROOT/infra/${A_DIR[$a]}" || die "$a 镜像构建 / 推送失败"
    # Verify a single-platform manifest was pushed (guards against the index trap).
    mt=$(aws ecr batch-get-image --repository-name "${uri#*/}" --image-ids imageTag="$tag" \
      --profile "$PROFILE" --region "$REGION" --query 'images[0].imageManifestMediaType' --output text)
    info "  pushed manifest: $mt"
  done
}

# 逐个部署智能体栈并带上镜像 tag(cdk 不能并发;带 -c <cap>-runtime=1 才会建 / 更新 Runtime)。
agentcore_deploy_runtimes() {
  local tag="$1"; shift
  local -a list=("$@"); [ ${#list[@]} -gt 0 ] || list=("${AGENTS[@]}")
  local a
  for a in "${list[@]}"; do
    info "runtime for $a (${A_STACK[$a]}) image tag=$tag"
    ( cd "$ROOT/infra" && npx cdk deploy "${A_STACK[$a]}" --require-approval never --profile "$PROFILE" \
        -c "${A_RT_CTX[$a]}=1" -c "${A_TAG_CTX[$a]}=$tag" ) || die "${A_STACK[$a]} 部署失败"
  done
}

# 只读:现网某个智能体 Runtime 正在用的镜像 tag。
#   来源 = AgentCore 控制面 get-agent-runtime 的 containerUri(栈输出的 Runtime ARN 末段就是 runtime id)。
#   读不到(栈没建 Runtime / 身份无权)⇒ 打印空并返回 1 —— 调用方要把「读不到」与「不一致」分开说,不许猜。
agentcore_deployed_tag() {
  local a="$1" arn id uri
  arn=$(out "${A_STACK[$a]}" "${A_RT_OUT[$a]}" 2>/dev/null || true)
  { [ -n "$arn" ] && [ "$arn" != "None" ]; } || { echo ""; return 1; }
  id="${arn##*/}"
  uri=$(aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id "$id" \
        --profile "$PROFILE" --region "$REGION" \
        --query 'agentRuntimeArtifact.containerConfiguration.containerUri' --output text 2>/dev/null || true)
  { [ -n "$uri" ] && [ "$uri" != "None" ]; } || { echo ""; return 1; }
  echo "${uri##*:}"
}
