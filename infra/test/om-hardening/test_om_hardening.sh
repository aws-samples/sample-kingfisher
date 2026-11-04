#!/usr/bin/env bash
# @kf-batch 50-PROD-A-launch-hardening —— OpenMetadata 加固离线判据(CDK assertions,零凭证)
set -euo pipefail
cd "$(dirname "$0")/../.."
env -u AWS_PROFILE -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN \
  npx ts-node --prefer-ts-exts test/om-hardening/check.ts
