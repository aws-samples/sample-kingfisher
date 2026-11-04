#!/usr/bin/env bash
# core-prebuild — 平台级 Agent 框架层 ①core-build 件(模块47 L2 泛化)。
# 把某个 AI 能力的 core(platform/src/lib/<cap>/core, TS 单一来源)编译成 CJS 产物,
# copy 进该能力的【消费方包目录】(容器 agent / 技能 Lambda)。
#
# 【为什么泛化】原 genbi-core-prebuild.sh 硬编码 genbi;模块47 要给每个 AI 能力(genbi/paramadvisor/
# netadvisor/…)同一套 core-dist 机制。此脚本 capability 驱动:关联数组声明各能力的 tsconfig +
# core 源 + core-dist 目标,加一个能力只加数组一行(呼应 FRAMEWORK-LAYER.md ①core-build 件)。
#
# 【为什么容器/Lambda 都需预编译】Lambda(fromAsset raw-dir)与容器(Dockerfile COPY)都无 bundling,
# 故 core 须预编译成可直接 require/import 的 CJS,作为目录内文件被一起打包(零 CDK 改造)。
#
# 【幂等】每次先清 core-dist 再全量生成;产物提交入库(保证部署时在位),可随时重生成。
# 改了 core/*.ts 后重跑本脚本刷新副本。
#
# 用法:
#   bash scripts/core-prebuild.sh <capability>   # 单个能力(genbi | paramadvisor | netadvisor | cookbook | ai;
#                                                #   单跑一个父目录能力时会连带重建落在它 core-dist 子目录里的能力,见 CAP_AFTER)
#   bash scripts/core-prebuild.sh all            # 全部能力(显式顺序)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLATFORM="$ROOT/platform"
TMP_OUT="$PLATFORM/.tmp-core-build"

# ── 能力注册表(加一个 AI 能力只加下面三行)───────────────────────────────────
#   CAP_TSCONFIG : 该能力的独立 CJS 编译配置(platform/ 下,含 rootDir+include)
#   CAP_CORE_SRC : core TS 源目录(存在性校验)
#   CAP_DESTS    : core-dist 目标目录(空格分隔;可多个消费方——容器 + Lambda)
declare -A CAP_TSCONFIG=(
  [genbi]="tsconfig.core.json"
  [paramadvisor]="tsconfig.paramadvisor-core.json"
  [netadvisor]="tsconfig.netadvisor-core.json"
  [cookbook]="tsconfig.cookbook-core.json"
  [ai]="tsconfig.ai-core.json"
)
declare -A CAP_CORE_SRC=(
  [genbi]="$PLATFORM/src/lib/genbi/core"
  [paramadvisor]="$PLATFORM/src/lib/param-advisor/core"
  [netadvisor]="$PLATFORM/src/lib/network-advisor/core"
  # cookbook(P45.5b):源目录是 lib/cookbook 本身(非 /core 子目录),tsconfig 只 include 纯子集
  [cookbook]="$PLATFORM/src/lib/cookbook"
  # ai(模块 51 v2.0 多厂商模型通道):厂商档案 vendors.ts + 请求整形 converse-shape.ts,零 @/ 零 SDK
  [ai]="$PLATFORM/src/lib/ai/core"
)
declare -A CAP_DESTS=(
  # genbi:Lambda 技能(阶段2)+ 容器 agent(阶段3)两个消费方
  [genbi]="$ROOT/infra/lambda/genbi-skills/core-dist $ROOT/infra/agent/genbi/core-dist"
  # paramadvisor:仅容器 agent(其技能 Lambda 是 esbuild 单源,无需 core-dist)
  [paramadvisor]="$ROOT/infra/agent/paramadvisor/core-dist"
  # netadvisor(L3):仅容器 agent(其技能 Lambda 是 esbuild 单源,无需 core-dist)
  [netadvisor]="$ROOT/infra/agent/netadvisor/core-dist"
  # cookbook(P45.5b):方言 guard 纯子集 → GenBI 容器 core-dist 的 cookbook 子目录(容器 agent.js
  # import ./core-dist/cookbook/core-guard.js);与 genbi/core-dist 并列不混。
  [cookbook]="$ROOT/infra/agent/genbi/core-dist/cookbook"
  # ai(模块 51 v2.0,51 SPEC §7.6):三个容器 core-dist 的 ai 子目录(genbi agent.js 与 _runtime/agent-runner.js
  # import ./core-dist/ai/converse-shape.js);容器与平台读**同一份**厂商档案(用户 2026-10-14「全部走同一个模型通道」)。
  [ai]="$ROOT/infra/agent/genbi/core-dist/ai $ROOT/infra/agent/netadvisor/core-dist/ai $ROOT/infra/agent/paramadvisor/core-dist/ai"
)
# 🔴 子目录依赖:某能力的 DEST 是另一能力 core-dist 的**子目录**时,父能力 build 的 `rm -rf core-dist` 会把子目录连带删掉
#   (2026-09 genbi 删 cookbook ⇒ 镜像启动 ERR_MODULE_NOT_FOUND 的教训)。单跑父能力必须连带重建这些子能力;
#   `all` 的显式顺序也由此而来(父在前、子在后)。
declare -A CAP_AFTER=(
  [genbi]="cookbook ai"
  [paramadvisor]="ai"
  [netadvisor]="ai"
)
# ②runtime 件分发(模块47 L2):走 agent-runner 的能力容器,需把平台级共享源 infra/agent/_runtime
# 分发进容器目录内的 _runtime/(同 core-dist 机制——Docker 构建上下文=容器目录,COPY 不能出上下文)。
# genbi 不在此列(它有自己的 agent.js + retrieval,不走 agent-runner);paramadvisor/netadvisor(L3)走。
RUNTIME_SRC="$ROOT/infra/agent/_runtime"
declare -A CAP_RUNTIME_DEST=(
  [paramadvisor]="$ROOT/infra/agent/paramadvisor/_runtime"
  [netadvisor]="$ROOT/infra/agent/netadvisor/_runtime"
)

build_one() {
  local CAP="$1"
  local TSCONFIG="${CAP_TSCONFIG[$CAP]:-}"
  local CORE_SRC="${CAP_CORE_SRC[$CAP]:-}"
  local DESTS_STR="${CAP_DESTS[$CAP]:-}"
  [ -n "$TSCONFIG" ] || { echo "ERROR: 未知能力 '$CAP'(注册表无 tsconfig)"; exit 1; }
  [ -d "$CORE_SRC" ] || { echo "ERROR: core 源目录不存在: $CORE_SRC"; exit 1; }

  echo "[core-prebuild:$CAP] core 源: $CORE_SRC"
  echo "[core-prebuild:$CAP] 编译 core → CJS (tsconfig=$TSCONFIG) ..."
  rm -rf "$TMP_OUT"
  ( cd "$PLATFORM" && npx tsc -p "$TSCONFIG" )
  # B-120 守卫(2026-10-25):记下这次编译**真正吃进去**的源(tsc --listFilesOnly 的 platform/src 子集,被 import 带进来的也算)
  #   及其 sha256,写成每个 core-dist 的 .source-manifest.json;单测 platform/src/lib/__tests__/core-dist-source-manifest.test.ts
  #   重算比对 ⇒ 改了源不重跑本脚本就红。缺陷原形:序 46 给 vendors.ts 加的 probeTimeoutMs 从没回写进入库产物,
  #   用入库副本部署的智能体按旧档案探测模型,而 tsc / vitest / 红线全绿 —— 产物只是构建快照,此前没有「与源同步」的守卫。
  local SOURCES
  SOURCES="$( cd "$PLATFORM" && npx tsc -p "$TSCONFIG" --listFilesOnly | grep -F "/platform/src/" || true )"
  [ -n "$SOURCES" ] || { echo "ERROR: tsc --listFilesOnly 没列出任何 platform/src 源(tsconfig=$TSCONFIG)"; exit 1; }

  # 幂等重建每个 core-dist:先全清再 copy .js/.d.ts(不带 .ts 源,包最小)。
  local DEST
  for DEST in $DESTS_STR; do
    echo "[core-prebuild:$CAP] 刷新 core-dist: $DEST"
    rm -rf "$DEST"
    mkdir -p "$DEST"
    # 递归 copy 全部产物(含子目录,如 cookbook 的 seed/*.js)。genbi/param/net 是扁平无子目录,
    # cp -r 行为与原 `cp *.js` 一致(仅多带 .d.ts,本就在带);cookbook(P45.5b)有 seed/ 子目录须递归。
    cp -r "$TMP_OUT"/. "$DEST"/
    # 标记 core-dist 为 CommonJS:产物是 CJS(tsconfig module:commonjs)。容器 agent 的 package.json
    # 是 type:module,不加此标记则该目录 .js 被当 ESM 解析致 import 失败。Lambda 侧加了也无害。
    echo '{"type":"commonjs"}' > "$DEST/package.json"
    cat > "$DEST/README.md" <<EOF
# core-dist (generated build output, do not edit by hand)

This directory is build output, not source. It holds the CommonJS compilation of the
shared core TypeScript sources that live under \`platform/src/lib/\`, copied here so that
the package that contains it (an AgentCore agent container or the GenBI skills Lambda)
can \`require\` or \`import\` them without a bundling step.

Generated by: \`bash scripts/core-prebuild.sh $CAP\`

## Why the output is committed

The Lambda is packaged from its directory as a raw asset and each agent container copies
\`core-dist\` into its image, so neither consumer has a build step of its own. The compiled
files must therefore exist in the repository at deploy time. They are a snapshot of the
sources at the moment the script last ran, nothing more.

## How to change it

1. Edit the TypeScript sources under \`platform/src/lib/\` (never the \`.js\` or \`.d.ts\` files here).
2. Run \`bash scripts/core-prebuild.sh $CAP\` (or \`all\`) from the repository root.
3. Commit the regenerated output together with the source change.

The script deletes and recreates this directory on every run, so manual edits are lost.
The capability table at the top of the script (\`CAP_CORE_SRC\` / \`CAP_DESTS\`) is the single
place that maps each capability to its source directory and its output directories.

## Drift guard

\`.source-manifest.json\` records every source file the compiler consumed, as a path relative
to the repository root with its SHA-256. The unit test
\`platform/src/lib/__tests__/core-dist-source-manifest.test.ts\` recomputes those hashes and
checks that every included source has a matching \`.js\` file here. A source change that is not
followed by a rebuild fails that test; rerunning the script is the only supported fix.

\`package.json\` in this directory only marks it as CommonJS so that the ESM agent packages
resolve these files correctly.
EOF
    # B-120:源清单(路径相对仓库根 → sha256,按键排序,逐字节可重现;容器 / Lambda 打包带上它无害)
    MANIFEST_CAP="$CAP" MANIFEST_TSCONFIG="platform/$TSCONFIG" MANIFEST_ROOT="$ROOT" MANIFEST_DEST="$DEST" MANIFEST_SOURCES="$SOURCES" node - <<'NODE'
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const root = fs.realpathSync(process.env.MANIFEST_ROOT);
const sources = {};
for (const line of process.env.MANIFEST_SOURCES.split("\n").map((s) => s.trim()).filter(Boolean)) {
  const abs = fs.realpathSync(line);
  sources[path.relative(root, abs).split(path.sep).join("/")] = crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
}
const sorted = Object.fromEntries(Object.keys(sources).sort().map((k) => [k, sources[k]]));
const manifest = {
  "$comment": "Drift guard: this core-dist was compiled by scripts/core-prebuild.sh from the sources listed below (paths relative to the repository root, values are SHA-256). The unit test platform/src/lib/__tests__/core-dist-source-manifest.test.ts recomputes the hashes; a source change without a rebuild fails it. Generated output, do not edit by hand.",
  capability: process.env.MANIFEST_CAP,
  tsconfig: process.env.MANIFEST_TSCONFIG,
  sources: sorted,
};
fs.writeFileSync(path.join(process.env.MANIFEST_DEST, ".source-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
NODE
  done

  rm -rf "$TMP_OUT"

  # ②runtime 件分发:copy 共享 _runtime/*.js 进容器目录内 _runtime/(纯 JS,非 TS 编译,直接 copy)。
  local RT_DEST="${CAP_RUNTIME_DEST[$CAP]:-}"
  if [ -n "$RT_DEST" ]; then
    [ -d "$RUNTIME_SRC" ] || { echo "ERROR: _runtime 共享源不存在: $RUNTIME_SRC"; exit 1; }
    echo "[core-prebuild:$CAP] 分发 ②runtime 件: $RUNTIME_SRC → $RT_DEST"
    rm -rf "$RT_DEST"
    mkdir -p "$RT_DEST"
    cp "$RUNTIME_SRC"/*.js "$RT_DEST"/
    cat > "$RT_DEST/README.md" <<EOF
# _runtime (distributed copy, do not edit by hand)

This directory is a copy, not the source. It holds the shared runtime of the advisor-style
AgentCore containers: \`agent-runner.js\`, the Strands agent assembly loop that every advisor
agent runs, and \`mcp.js\`, a minimal MCP Streamable HTTP client that signs its calls to the
AgentCore Gateway with SigV4.

Distributed by: \`bash scripts/core-prebuild.sh $CAP\`
Single source of truth: \`infra/agent/_runtime/*.js\`

## Why a copy exists

The Docker build context of each agent is its own directory and \`COPY\` cannot reach outside
it, so the shared runtime is copied in by the prebuild script, exactly like \`core-dist\`.
The container entry point \`agent.js\` imports \`./_runtime/agent-runner.js\`, and the runner
in turn imports \`../core-dist/ai/*.js\` for the shared model vendor profile, so the two copies
are expected to move together.

## How to change it

1. Edit the files under \`infra/agent/_runtime/\` (never the copies here).
2. Run \`bash scripts/core-prebuild.sh $CAP\` (or \`all\`) from the repository root.
3. Commit the refreshed copies of every container together with the source change.

The script deletes and recreates this directory on every run, so manual edits are lost.
The files are plain JavaScript and are copied as they are; no compilation is involved.
EOF
  fi

  echo "[core-prebuild:$CAP] 完成。产物示例:"
  ls -1 ${DESTS_STR%% *}
}

TARGET="${1:-all}"
if [ "$TARGET" = "all" ]; then
  # 【显式顺序,非关联数组遍历(顺序不定)】关键:cookbook 的 DEST 是 genbi/core-dist 的【子目录】
  # (genbi/core-dist/cookbook),ai 的三个 DEST 是三个容器 core-dist 的【子目录】,而父能力 build 会
  # `rm -rf <容器>/core-dist` 清空(连带删子目录)。故 cookbook 必须在 genbi 之后、ai 必须在三个容器能力之后。
  for CAP in genbi paramadvisor netadvisor cookbook ai; do build_one "$CAP"; done
else
  build_one "$TARGET"
  for CAP in ${CAP_AFTER[$TARGET]:-}; do
    echo "[core-prebuild:$TARGET] 其 core-dist 子目录能力 $CAP 刚被连带清掉,重建"
    build_one "$CAP"
  done
fi
