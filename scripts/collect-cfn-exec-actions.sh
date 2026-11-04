#!/usr/bin/env bash
# 采集 exec-env 部署链 **cfn-exec-role** 的实际 API 调用集(50 SPEC v3.21 §6.2「先采集后收窄」的采集步)。
#
# 🔴 采集窗口(§6.2 v3.21 订正):只有在角色栈 + residency 栈都**真部署过一次**、且三条路径
#    (部署 / 补组件 / 临时 target 销毁)都跑过之后,采到的集合才完整 —— 本脚本之后执行,
#    本刀只**备**它(不跑)。用既有的 `bgp-management-trail`(多区域管理事件已在记),不新开 trail。
#
# 用法:
#   set -a; . /tmp/kf-creds-new.env; set +a
#   bash scripts/collect-cfn-exec-actions.sh <region> [start-iso] [end-iso] > infra/bootstrap/cfn-exec-actions.<region>.txt
# 输出:每行一个 `service:EventName`(去重排序),供人工映射成 IAM Action 后写进 infra/bootstrap/cfn-exec-policy.json。
# 🔴 CloudTrail 有投递延迟(memory cloudtrail-delivery-lag-not-proof):三路径跑完后至少等 15 分钟再采;
#    采到 0 条一律当「还没投递」,不当「没调用」。
set -euo pipefail
PROFILE="${AWS_PROFILE_OVERRIDE:-temp-account}"
REGION="${1:?用法: $0 <region> [start-iso] [end-iso]}"
START="${2:-$(date -u -d '-24 hours' +%Y-%m-%dT%H:%M:%SZ)}"
END="${3:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
ACCT="$(aws sts get-caller-identity --profile "$PROFILE" --query Account --output text)"
# 默认 bootstrap 的 cfn-exec-role 名(qualifier hnb659fds);exec-env 专用 qualifier 落地后改这里
ROLE_NAME="${CFN_EXEC_ROLE_NAME:-cdk-hnb659fds-cfn-exec-role-${ACCT}-${REGION}}"
ROLE_ARN="arn:aws:iam::${ACCT}:role/${ROLE_NAME}"
echo "# collect: role=$ROLE_ARN region=$REGION window=$START..$END" >&2
NEXT=""
: > /tmp/cfn-exec-events.jsonl
while :; do
  ARGS=(cloudtrail lookup-events --region "$REGION" --profile "$PROFILE" --start-time "$START" --end-time "$END" --max-results 50 --output json)
  [[ -n "$NEXT" ]] && ARGS+=(--next-token "$NEXT")
  OUT="$(aws "${ARGS[@]}")"
  echo "$OUT" | python3 -c '
import json,sys
d=json.load(sys.stdin)
for e in d.get("Events",[]):
    try: ct=json.loads(e.get("CloudTrailEvent","{}"))
    except Exception: continue
    iss=((ct.get("userIdentity") or {}).get("sessionContext") or {}).get("sessionIssuer") or {}
    if iss.get("arn")==sys.argv[1]:
        print(json.dumps({"src":ct.get("eventSource"),"name":ct.get("eventName"),"err":ct.get("errorCode")}))
' "$ROLE_ARN" >> /tmp/cfn-exec-events.jsonl
  NEXT="$(echo "$OUT" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("NextToken",""))')"
  [[ -z "$NEXT" ]] && break
done
python3 - <<'PY'
import json
seen=set(); denied=set()
for l in open("/tmp/cfn-exec-events.jsonl"):
    e=json.loads(l)
    svc=str(e.get("src","")).split(".")[0]
    key=f"{svc}:{e.get('name')}"
    seen.add(key)
    if e.get("err") in ("AccessDenied","UnauthorizedOperation"): denied.add(key)
for k in sorted(seen): print(k)
import sys
print(f"# total={len(seen)} denied-in-window={sorted(denied)}", file=sys.stderr)
PY
