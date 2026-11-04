#!/usr/bin/env bash
# genbi-core-prebuild — 【模块47 L2 起为薄 wrapper】。
# core-dist 编译机制已泛化到通用 scripts/core-prebuild.sh(capability 驱动,支持多能力)。
# 本脚本保留仅为兼容既有调用点(deploy-all.sh 等),等价于 `core-prebuild.sh genbi`。
# 新增/维护能力请改通用脚本的能力注册表,不要再在这里堆逻辑。
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$HERE/core-prebuild.sh" genbi
