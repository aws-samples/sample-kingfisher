#!/usr/bin/env bash
# @kf-batch 50-WP20-retire-classic-mwaa
# 前置检查:**经典 MWAA 栈还在的时候,不许更新平台栈**。
#
# 🔴 为什么必须机械化(2026-09-14 真环境撞过一次,15 分钟白等):
#   WP-20 之后 `BgpMwaaStack` 不再被 CDK 实例化 ⇒ CDK 认为平台栈那个导出
#   (`BgpService/LB SecurityGroup GroupId`)**没有消费者了** ⇒ 新模板把导出删掉;
#   而现网那个 MWAA 栈**还在**(哪怕正在 DELETE_IN_PROGRESS)仍然引用它 ⇒ CFN 拒绝:
#     Cannot delete export …LBSecurityGroup…GroupId as it is in use by BgpMwaaStack
#   ⇒ 平台栈 **UPDATE_ROLLBACK_COMPLETE**。症状离根因很远(看起来像平台栈自己坏了)。
#
# 🔴🔴 2026-09-22 修掉本脚本自己的一个缺陷:原来只用 `case "$ST"` 看**输出文本**,
#   于是「查不了」(ExpiredToken / AccessDenied / 网络不通)会落到 default 分支,
#   打印成 **「经典 MWAA 栈还在(BgpMwaaStack = …ExpiredToken…)」**。
#   拦住部署这个**方向是对的**(fail-closed),但它**把「我判不了」报告成了一个结论**,
#   而那个结论是错的 —— 我照着它去查 MWAA 栈,真相是凭证过期。
#   (本仓纪律:「判不了」绝不许说成结论;段中断 / 少跑判据 / 判据有红必须三态分开。)
#   ⇒ 现在按「调用成功与否」先分层,三态各有各的话与各的下一步:
#       absent  = 真查到了,栈不在  ⇒ 放行(0)
#       present = 真查到了,栈还在  ⇒ 拦住(1),下一步是删栈
#       unknown = **没查成**       ⇒ 拦住(1),下一步是**刷凭证/查权限**,别去删栈
#
# 用法:bash scripts/preflight-classic-mwaa.sh <profile> <region>
#   DEPLOY_CLASSIC_MWAA=1 时跳过(那种情形下栈本来就该在)。
#   --self-test:把三态各跑一遍(不碰 AWS)。🔴 本仓栽过 —— `set -e` 之下除「绿」以外的
#     分支**从来没被打印过**,而文本判据是绿的;三态必须真的各走一次才算有这三态。
set -uo pipefail
# 🔴🔴 **不许把旗标当成 profile 名**(2026-09-22 我自己踩:写成 `--profile temp-account`
#   ⇒ `PROFILE="--profile"` / `REGION="temp-account"`,于是 aws 调用整个畸形,
#   而上层看到的症状是一句「查不了经典 MWAA 栈的状态」—— 离根因很远,白烧一轮)。
#   本脚本收的是**位置参数**;以 `-` 开头的第一个参数一律当成用法错误,当场停。
if [[ "${1:-}" == -* && "${1:-}" != "--self-test" ]]; then
  printf '\033[1;31m✗ 用法错误:本脚本收**位置参数**,不是旗标\033[0m\n'
  printf '   你传的是:%s %s\n' "${1:-}" "${2:-}"
  printf '   正确写法:bash %s <profile> [region]\n' "$0"
  printf '   例:      bash %s temp-account us-east-1\n' "$0"
  exit 2
fi
PROFILE="${1:-temp-account}"
REGION="${2:-us-east-1}"

# 🔴 闭合式判别:唯一允许放行的形态是「调用成功 ∧ 状态是不存在/已删完」。
#   不去枚举「哪些错误算查不了」(那必然漏掉第 N+1 种),而是反过来:
#   调用没成功 ∧ 输出里没有「栈不存在」这句 AWS 的正式回答 ⇒ 一律 unknown。
classify() {
  local rc="$1" out="$2"
  if [[ "$out" == *"does not exist"* ]]; then echo absent; return; fi
  if [[ "$rc" != "0" ]]; then echo unknown; return; fi
  case "$out" in
    DELETE_COMPLETE|"") echo absent ;;
    *) echo present ;;
  esac
}

if [[ "${1:-}" == "--self-test" ]]; then
  fail=0
  check() { # 期待 · rc · 输出
    got=$(classify "$2" "$3")
    if [[ "$got" == "$1" ]]; then printf '  ✅ %-8s ← rc=%s out=%q\n' "$got" "$2" "$3"
    else printf '  🔴 期待 %s 实得 %s ← rc=%s out=%q\n' "$1" "$got" "$2" "$3"; fail=1; fi
  }
  echo "── preflight-classic-mwaa 三态自检"
  check absent  255 "An error occurred (ValidationError) ... Stack with id BgpMwaaStack does not exist"
  # 🔴 2026-09-22 真实观测:新版 AWS CLI 的形态变了 —— 退出码 **254**、首行是**空行**、
  #   错误带 `aws: [ERROR]:` 前缀。闭合判别(认「does not exist」这句话)本来就吃得下它,
  #   但把真实形态留成夹具,免得以后有人把判别改成「按 rc==255」而不自知。
  check absent  254 "$(printf '\naws: [ERROR]: An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id BgpMwaaStack does not exist')"
  check absent  0   "DELETE_COMPLETE"
  check absent  0   ""
  check present 0   "CREATE_COMPLETE"
  check present 0   "DELETE_IN_PROGRESS"
  # 🔴 这四条是这次修的那个缺陷:它们原来全被报成「栈还在」
  check unknown 255 "An error occurred (ExpiredToken) ... The security token included in the request is expired"
  check unknown 255 "An error occurred (AccessDenied) ..."
  check unknown 255 "Could not connect to the endpoint URL"
  check unknown 1   "Unable to locate credentials"
  [[ "$fail" == "0" ]] && echo "  ⇒ 三态齐全" || echo "  ⇒ 🔴 三态判别有错"
  exit "$fail"
fi

[[ "${DEPLOY_CLASSIC_MWAA:-0}" == "1" ]] && exit 0

# 🔴 用 `if` 包住取退出码:本仓记过 `set -e` 之下 `f "$x"; V=$?` 会当场杀掉脚本。
#   本脚本目前没开 errexit,但判别不该依赖这一点。
if ST=$(aws cloudformation describe-stacks --stack-name BgpMwaaStack \
          --profile "$PROFILE" --region "$REGION" \
          --query 'Stacks[0].StackStatus' --output text 2>&1); then RC=0; else RC=$?; fi

case "$(classify "$RC" "$ST")" in
  absent) exit 0 ;;
  unknown)
    printf "\033[1;31m✗ 查不了经典 MWAA 栈的状态(不是「它还在」——是**没查成**)\033[0m\n"
    # 🔴 只回显到第一行、且**不打印账号号**(本仓硬约束:12 位账号号不进输出/受跟踪文件)
    printf '   AWS 回的第一行:%s\n' \
      "$(printf '%s' "$ST" | grep -v '^[[:space:]]*$' | head -1 | sed -E 's/[0-9]{12}/…<acct>/g')"
    cat <<'MSG'
   拦住部署是刻意的(查不了就不许更新平台栈),但**下一步不是删栈**:
     · ExpiredToken / Unable to locate credentials ⇒ 刷新凭证后重跑
     · AccessDenied                                ⇒ 这个 profile 没有 cfn:DescribeStacks
     · Could not connect                           ⇒ 网络/区域参数
MSG
    exit 1 ;;
esac

printf "\033[1;31m✗ 经典 MWAA 栈还在(BgpMwaaStack = %s)\033[0m\n" "$ST"
cat <<'MSG'
  WP-20 之后平台栈的模板不再导出 ALB 安全组给它,而它仍在引用那个导出
  ⇒ **现在更新平台栈必定 UPDATE_ROLLBACK**(CFN:Cannot delete export … as it is in use by BgpMwaaStack)。

  先做完这一步再来:
    aws cloudformation delete-stack --stack-name BgpMwaaStack --profile <profile> --region <region>
    # 等到 DELETE_COMPLETE(MWAA 环境删除约 20–30 分钟)
  确实要保留经典 MWAA 时:DEPLOY_CLASSIC_MWAA=1 重跑本次部署。
MSG
exit 1
