#!/usr/bin/env bash
# @kf-batch 50-WP28-platform-action-node
# 分发 Lambda(infra/lambda/action-dispatcher/index.mjs)的离线判据:node 内置测试框架真跑。
#     bash infra/test/action-dispatcher/test_handler.sh      # 退出码 0 = 全过
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
node --test "$HERE/handler.test.mjs"
