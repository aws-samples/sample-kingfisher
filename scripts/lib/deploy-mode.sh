#!/usr/bin/env bash
# scripts/lib/deploy-mode.sh —— 部署模式(production / demo)在 shell 侧的**唯一作者**(只定义函数,不执行)。
#
# 规则与 infra/lib/shared/deploy-mode.ts 同一条:SSM /bgp/deploy-mode 有值 ⇒ 以它为准;env BGP_DEPLOY_MODE 给了**别的**值 ⇒ 拒绝(exit 2);
#   SSM 读不到(未写 / 无权 / 回字面 None)⇒ 按 env,缺省 production,并把依据打到 stderr。
# 🔴 为什么要有这一份:deploy-all 定下模式后不许换 —— 否则在生产环境上手敲 BGP_DEPLOY_MODE=demo 单独重跑建号 / 造数脚本,
#   就会在生产里冒出测试账号 / 演示成员。原来这段逻辑只住在 10-bootstrap-cognito.sh 里,第二个要按模式分流的脚本
#   (11-seed-demo-memberships.sh)一出现就会有第二份副本,所以抽成 lib(单一作者,两边 source)。
#   离线判据:infra/test/cognito-mode-guard/test_mode_guard.sh(假 aws 驱动每条分支)。
#
# 用法(调用方先设好 PROFILE / REGION;可设 DEPLOY_MODE_LOG_PREFIX 改日志前缀):
#   source "$HERE/lib/deploy-mode.sh"
#   DEPLOY_MODE="$(resolve_deploy_mode)" || exit 2
resolve_deploy_mode() {  # stdout = 生效模式;冲突时 exit 2(stderr 已说明)
  local prefix="${DEPLOY_MODE_LOG_PREFIX:-[deploy-mode]}"
  local ssm_mode env_mode="${BGP_DEPLOY_MODE:-}"
  ssm_mode="$(aws ssm get-parameter --name /bgp/deploy-mode --query Parameter.Value --output text \
                --profile "$PROFILE" --region "$REGION" 2>/dev/null || true)"
  [ "$ssm_mode" = "None" ] && ssm_mode=""
  if [ -n "$ssm_mode" ]; then
    if [ -n "$env_mode" ] && [ "$env_mode" != "$ssm_mode" ]; then
      echo "$prefix ❌ 本环境已按 $ssm_mode 模式部署(SSM /bgp/deploy-mode),这次给的是 BGP_DEPLOY_MODE=$env_mode —— 拒绝按别的模式继续" >&2
      exit 2
    fi
    echo "$prefix 部署模式 = $ssm_mode(SSM /bgp/deploy-mode)" >&2
    printf '%s' "$ssm_mode"
    return 0
  fi
  echo "$prefix SSM /bgp/deploy-mode 读不到(未写或无权)⇒ 按 BGP_DEPLOY_MODE=${env_mode:-production}(缺省 production)" >&2
  printf '%s' "${env_mode:-production}"
}
