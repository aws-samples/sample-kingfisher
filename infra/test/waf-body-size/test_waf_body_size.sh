#!/usr/bin/env bash
# 平台边缘「请求体大小」规则的离线判据(CDK assertions,零凭证)
#     bash infra/test/waf-body-size/test_waf_body_size.sh      # 退出码 0 = 全过
set -euo pipefail
cd "$(dirname "$0")/../.."
env -u AWS_PROFILE -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN \
  npx ts-node --prefer-ts-exts test/waf-body-size/check.ts
