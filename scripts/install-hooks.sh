#!/usr/bin/env bash
# 一键启用版本化 git hooks(模块 27 / 安全流程加固)。
# 克隆仓库后执行一次即可,使 .githooks/ 下的钩子(含 pre-commit 红线扫描)对本地提交生效。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
git config core.hooksPath .githooks
chmod +x .githooks/* 2>/dev/null || true
echo "✅ 已启用版本化 hooks(core.hooksPath=.githooks)。pre-commit 将自动跑红线扫描。"
