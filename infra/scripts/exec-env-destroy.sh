#!/usr/bin/env bash
# @kf-batch 50-WP30-decommission
# 执行环境**下线销毁**(WP-30 路 B 施工序 4)—— 只由 buildspec 的 destroy 分支调用(CodeBuild 里跑,build 角色的权限)。
#
# 【顺序是承重】(N-5 的血教训:RETAIN 的托管资源占着 SG / 子网,整条删除链停住)
#   ① 托管服务先走:Flink 应用 → MWAA Serverless 工作流 → Glue 作业 / 连接 → EMR Serverless 应用 → DMS 复制任务 / 实例
#      → 经典 MWAA 环境 → Redshift **工作组** → Redshift **命名空间**(🔴 带最终快照删;快照保留 = 数仓数据不丢)
#   ② 组件栈按反依赖序删(唯一作者 lib/exec-env/destroy-order.ts,经 EXEC_ENV_DESTROY_SUFFIXES 传入)→ core → base
#   ③ 收尾探测:本 slug 的栈一个都不许剩、本 target 的 VPC 不许剩;数据类资源**逐个列出「已保留」**
#   顺序判据在 synth-gate §11f(真跑本脚本 + aws 替身,钉「托管服务全部在第一次 delete-stack 之前」)。
#
# 【绝不删的东西】数据湖桶 / 脚本桶 / 表桶 / 工作流桶 / DAG 桶 / 驻留审计与结果表 / CMK / 任何快照 ——
#   这些在 CFN 里都是 RETAIN(删栈不会带走它们),本脚本也**不发**任何删除它们的调用(synth-gate 逐条负向断言)。
#   删数据要用户指名,平台不代决。
#
# 【幂等 / 可重试】每一步都先查「还在不在」再删;已经没了 ⇒ 记 skipped。最终快照名由平台在审批通过时定死
#   (EXEC_ENV_FINAL_SNAPSHOT),重试时若该快照**已存在** ⇒ 删命名空间时不再要求新快照(数据已在那份快照里,
#   环境早已停止承接),绝不重复建、更不删任何快照。
#
# 【结果怎么回到平台】buildspec 不许写注册表(synth-gate 负向断言)⇒ 本脚本只**打印**一行机器可读报告
#   `EXEC_ENV_DESTROY_REPORT {json}`(与 P0-E 裁决同一条单向日志通道),平台收口时读它 + 自己再真查一遍 AWS。
#   卡住时报告里点名「哪一步 / 哪个资源 / 真因」,页面原样显示(不许假装删完)。
set -euo pipefail

for v in EXEC_ENV_TARGET EXEC_ENV_REGION EXEC_ENV_ACCOUNT EXEC_ENV_FINAL_SNAPSHOT EXEC_ENV_DESTROY_SUFFIXES CODEBUILD_SRC_DIR; do
  if [ -z "${!v:-}" ]; then echo "❌ 缺环境变量 $v —— 销毁入参只能由 broker / buildspec 注入"; exit 1; fi
done
if [ "$EXEC_ENV_TARGET" = "tgt_home" ]; then echo "❌ 主控区执行环境永不可删(destroy 拒 tgt_home)"; exit 1; fi
case "$EXEC_ENV_FINAL_SNAPSHOT" in
  bgp-final-*) ;;
  *) echo "❌ 最终快照名非法:$EXEC_ENV_FINAL_SNAPSHOT(须 bgp-final-<slug>-<时刻>,由平台在审批通过时生成)"; exit 1 ;;
esac

R="$EXEC_ENV_REGION"
SLUG="$(printf '%s' "$EXEC_ENV_TARGET" | tr '_' '-')"
NAMING_JSON="$CODEBUILD_SRC_DIR/platform/naming.json"
# 轮询节奏(只影响等待时长;测试里给 0)。最长等待 = 间隔 × 次数,缺省 15s × 200 ≈ 50min(经典 MWAA 删除最慢)
POLL="${EXEC_ENV_DESTROY_POLL_SECONDS:-15}"
MAX_POLLS="${EXEC_ENV_DESTROY_MAX_POLLS:-200}"
REPORT_LINES="$(mktemp)"
CURRENT_STEP="0-prepare"

# 命名 SSOT(platform/naming.json)现算本 target 的资源名 —— 不在脚本里写第二处字面量
name_of() {
  node -e '
    const n = require(process.argv[1]); const r = n.kinds[process.argv[2]];
    if (!r) throw new Error("naming.json 无 kind " + process.argv[2]);
    process.stdout.write(r.target.split("{slug}").join(process.argv[3]).split("{account}").join(process.argv[4]));
  ' "$NAMING_JSON" "$1" "$SLUG" "$EXEC_ENV_ACCOUNT"
}

# 报告:一行一条「步骤 \t 结果 \t 资源 \t 说明」;退出时(无论成败)汇总成一行 JSON 打到日志 + 落 outputs 文件
record() { printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$(printf '%s' "${4:-}" | tr '\t\n' '  ' | cut -c1-600)" >> "$REPORT_LINES"; }
emit_report() {
  local rc=$?
  node -e '
    const fs = require("fs");
    const [file, target, region, snapshot, rc, out] = process.argv.slice(1);
    const steps = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => {
      const [step, status, resource, detail] = l.split("\t");
      return { step, status, resource, detail: detail || "" };
    });
    const stuck = steps.find((s) => s.status === "stuck");
    const rep = { target, region, finalSnapshot: snapshot, ok: Number(rc) === 0 && !stuck, exitCode: Number(rc), steps, ...(stuck ? { stuck } : {}) };
    console.log("EXEC_ENV_DESTROY_REPORT " + JSON.stringify(rep));
    try { fs.writeFileSync(out, JSON.stringify(rep, null, 2)); } catch {}
  ' "$REPORT_LINES" "$EXEC_ENV_TARGET" "$R" "$EXEC_ENV_FINAL_SNAPSHOT" "$rc" "$CODEBUILD_SRC_DIR/exec-env-outputs.json" || true
  exit "$rc"
}
trap emit_report EXIT

# 卡住:点名资源与真因,立即停(后面的步骤依赖前面的都走干净;带着残留往下删只会把真因埋得更深)
stuck() {
  record "$CURRENT_STEP" stuck "$1" "$2"
  echo "❌ 销毁卡在 [$CURRENT_STEP] $1:$2"
  exit 1
}
is_not_found() {
  printf '%s' "$1" | grep -Eqi 'ResourceNotFound|NotFoundException|NotFoundFault|EntityNotFound|does not exist|could not be found|not found'
}
clean() { [ "$1" = "None" ] && printf '' || printf '%s' "$1"; }
last_line() { printf '%s' "$1" | tail -3 | tr '\n' ' ' | cut -c1-400; }

# 等资源消失:`cmd` 成功 = 还在;失败且是「不存在」= 已消失;其它失败 = 查不清 ⇒ 卡住(看不清不算删完)
wait_gone() {
  local desc="$1"; shift
  local i=0 out
  while :; do
    if out="$("$@" 2>&1)"; then
      i=$((i + 1))
      if [ "$i" -ge "$MAX_POLLS" ]; then stuck "$desc" "等了 ${i} 轮仍未消失(最后:$(last_line "$out"))"; fi
      sleep "$POLL"
    else
      if is_not_found "$out"; then return 0; fi
      stuck "$desc" "查询失败:$(last_line "$out")"
    fi
  done
}
# 等某个状态词出现(`cmd` 的 stdout 就是状态词)
wait_status() {
  local desc="$1" want="$2"; shift 2
  local i=0 out
  while :; do
    if ! out="$("$@" 2>&1)"; then
      if is_not_found "$out"; then return 0; fi
      stuck "$desc" "查询失败:$(last_line "$out")"
    fi
    if printf '%s' "$out" | grep -Eq "^(${want})$"; then return 0; fi
    i=$((i + 1))
    if [ "$i" -ge "$MAX_POLLS" ]; then stuck "$desc" "等 ${want} 等了 ${i} 轮,仍是 $(last_line "$out")"; fi
    sleep "$POLL"
  done
}

echo "destroy: target=$EXEC_ENV_TARGET slug=$SLUG region=$R finalSnapshot=$EXEC_ENV_FINAL_SNAPSHOT stacks=[$EXEC_ENV_DESTROY_SUFFIXES]"

# ── 0. 本 target 的 VPC / 子网(用来认出「平台在这个区为它建的」运行期资源;别人的同区资源一律不碰)──────────
BASE_STACK="BgpExecEnv-$SLUG-base"
if ! VPC_ID="$(aws ec2 describe-vpcs --region "$R" --filters "Name=tag:aws:cloudformation:stack-name,Values=$BASE_STACK" \
                 --query 'Vpcs[0].VpcId' --output text 2>&1)"; then
  stuck "vpc" "查不到本 target 的 VPC:$(last_line "$VPC_ID")"
fi
VPC_ID="$(clean "$VPC_ID")"
SUBNETS=""
if [ -n "$VPC_ID" ]; then
  if ! SUBNETS="$(aws ec2 describe-subnets --region "$R" --filters "Name=vpc-id,Values=$VPC_ID" --query 'Subnets[].SubnetId' --output text 2>&1)"; then
    stuck "vpc:$VPC_ID" "列子网失败:$(last_line "$SUBNETS")"
  fi
  SUBNETS="$(clean "$SUBNETS" | tr '[:space:]' ' ')"
fi
echo "destroy: vpc=${VPC_ID:-<无>} subnets=[${SUBNETS}]"
in_my_subnets() {
  local s
  for s in $1; do case " $SUBNETS " in *" $s "*) return 0 ;; esac; done
  return 1
}
role_is_mine() { case "$1" in *"/BgpExecEnv-$SLUG-$2") return 0 ;; "BgpExecEnv-$SLUG-$2") return 0 ;; esac; return 1; }

# ══ ① 托管服务先走 ════════════════════════════════════════════════════════════════════════════════════════

# ── 1. Flink(Managed Service for Apache Flink):执行角色是本 target 的 flink 角色 ⇒ 停(force)+ 删 ──
CURRENT_STEP="1-flink"
if ! APPS="$(aws kinesisanalyticsv2 list-applications --region "$R" --query 'ApplicationSummaries[].ApplicationName' --output text 2>&1)"; then
  stuck "kinesisanalyticsv2" "列应用失败:$(last_line "$APPS")"
fi
for app in $(clean "$APPS"); do
  if ! DET="$(aws kinesisanalyticsv2 describe-application --region "$R" --application-name "$app" \
               --query 'ApplicationDetail.[ServiceExecutionRole,ApplicationStatus,CreateTimestamp]' --output text 2>&1)"; then
    is_not_found "$DET" && continue
    stuck "flink:$app" "读应用失败:$(last_line "$DET")"
  fi
  read -r ROLE STATUS CREATED <<<"$DET" || true
  role_is_mine "$ROLE" "flink-role" || continue
  case "$STATUS" in
    RUNNING|STARTING|UPDATING|AUTOSCALING|MAINTENANCE|ROLLING_BACK)
      aws kinesisanalyticsv2 stop-application --region "$R" --application-name "$app" --force >/dev/null
      wait_status "flink:$app" "READY|DELETING" aws kinesisanalyticsv2 describe-application --region "$R" --application-name "$app" --query 'ApplicationDetail.ApplicationStatus' --output text
      ;;
  esac
  aws kinesisanalyticsv2 delete-application --region "$R" --application-name "$app" --create-timestamp "$CREATED" >/dev/null
  wait_gone "flink:$app" aws kinesisanalyticsv2 describe-application --region "$R" --application-name "$app" --query 'ApplicationDetail.ApplicationStatus' --output text
  record "$CURRENT_STEP" deleted "flink:$app" "stopped+deleted"
done

# ── 2. MWAA Serverless 工作流:执行角色是本 target 的 airflow-sls 角色 ⇒ 删 ──
CURRENT_STEP="2-airflow-serverless"
if ! WFS="$(aws mwaa-serverless list-workflows --region "$R" --query 'Workflows[].WorkflowArn' --output text 2>&1)"; then
  if printf '%s' "$WFS" | grep -qi "invalid choice"; then
    stuck "mwaa-serverless" "构建镜像里的 aws CLI 不认识 mwaa-serverless(版本过旧)—— 升级 CodeBuild 镜像的 aws CLI 后点「重试销毁」"
  fi
  stuck "mwaa-serverless" "列工作流失败:$(last_line "$WFS")"
fi
for arn in $(clean "$WFS"); do
  if ! WROLE="$(aws mwaa-serverless get-workflow --region "$R" --workflow-arn "$arn" --query 'RoleArn' --output text 2>&1)"; then
    is_not_found "$WROLE" && continue
    stuck "workflow:$arn" "读工作流失败:$(last_line "$WROLE")"
  fi
  role_is_mine "$WROLE" "airflow-sls-role" || continue
  aws mwaa-serverless delete-workflow --region "$R" --workflow-arn "$arn" >/dev/null
  wait_gone "workflow:$arn" aws mwaa-serverless get-workflow --region "$R" --workflow-arn "$arn" --query 'WorkflowArn' --output text
  record "$CURRENT_STEP" deleted "workflow:${arn##*/}" ""
done

# ── 3. Glue:作业(角色是本 target 的 glue 角色)+ 连接(子网在本 target 的 VPC 里)──
CURRENT_STEP="3-glue"
if ! GJOBS="$(aws glue get-jobs --region "$R" --query 'Jobs[].[Name,Role]' --output text 2>&1)"; then
  stuck "glue" "列作业失败:$(last_line "$GJOBS")"
fi
while read -r JNAME JROLE; do
  [ -n "${JNAME:-}" ] && [ "$JNAME" != "None" ] || continue
  role_is_mine "${JROLE:-}" "glue-role" || continue
  aws glue delete-job --region "$R" --job-name "$JNAME" >/dev/null
  record "$CURRENT_STEP" deleted "glue-job:$JNAME" ""
done <<<"$(clean "$GJOBS")"
if ! GCONNS="$(aws glue get-connections --region "$R" --query 'ConnectionList[].[Name,PhysicalConnectionRequirements.SubnetId]' --output text 2>&1)"; then
  stuck "glue" "列连接失败:$(last_line "$GCONNS")"
fi
while read -r CNAME CSUBNET; do
  [ -n "${CNAME:-}" ] && [ "$CNAME" != "None" ] || continue
  in_my_subnets "${CSUBNET:-}" || continue
  aws glue delete-connection --region "$R" --connection-name "$CNAME" >/dev/null
  record "$CURRENT_STEP" deleted "glue-connection:$CNAME" ""
done <<<"$(clean "$GCONNS")"

# ── 4. EMR Serverless 应用:网络配置的子网在本 target 的 VPC 里 ⇒ 停 + 删 ──
CURRENT_STEP="4-emr-serverless"
if ! EAPPS="$(aws emr-serverless list-applications --region "$R" --query "applications[?state!='TERMINATED'].id" --output text 2>&1)"; then
  stuck "emr-serverless" "列应用失败:$(last_line "$EAPPS")"
fi
for id in $(clean "$EAPPS"); do
  if ! ENET="$(aws emr-serverless get-application --region "$R" --application-id "$id" --query 'application.networkConfiguration.subnetIds' --output text 2>&1)"; then
    is_not_found "$ENET" && continue
    stuck "emr:$id" "读应用失败:$(last_line "$ENET")"
  fi
  in_my_subnets "$(clean "$ENET")" || continue
  if ! ESTATE="$(aws emr-serverless get-application --region "$R" --application-id "$id" --query 'application.state' --output text 2>&1)"; then
    stuck "emr:$id" "读状态失败:$(last_line "$ESTATE")"
  fi
  case "$ESTATE" in
    STARTED|STARTING)
      aws emr-serverless stop-application --region "$R" --application-id "$id" >/dev/null
      wait_status "emr:$id" "STOPPED|CREATED" aws emr-serverless get-application --region "$R" --application-id "$id" --query 'application.state' --output text
      ;;
  esac
  aws emr-serverless delete-application --region "$R" --application-id "$id" >/dev/null
  wait_status "emr:$id" "TERMINATED" aws emr-serverless get-application --region "$R" --application-id "$id" --query 'application.state' --output text
  record "$CURRENT_STEP" deleted "emr-serverless:$id" ""
done

# ── 5. DMS:挂在本 target 复制子网组上的复制实例(连同其上的任务)⇒ 删(子网组是 dms 栈的,实例在就删不掉它)──
CURRENT_STEP="5-dms"
DMS_SG="$(name_of dmsSubnetGroup)"
if ! DINST="$(aws dms describe-replication-instances --region "$R" \
               --query "ReplicationInstances[?ReplicationSubnetGroup.ReplicationSubnetGroupIdentifier=='$DMS_SG'].ReplicationInstanceArn" --output text 2>&1)"; then
  stuck "dms" "列复制实例失败:$(last_line "$DINST")"
fi
for iarn in $(clean "$DINST"); do
  if ! DTASKS="$(aws dms describe-replication-tasks --region "$R" --filters "Name=replication-instance-arn,Values=$iarn" \
                  --query 'ReplicationTasks[].[ReplicationTaskArn,Status]' --output text 2>&1)"; then
    is_not_found "$DTASKS" || stuck "dms:$iarn" "列复制任务失败:$(last_line "$DTASKS")"
    DTASKS=""
  fi
  while read -r TARN TSTATUS; do
    [ -n "${TARN:-}" ] && [ "$TARN" != "None" ] || continue
    case "${TSTATUS:-}" in
      running|starting|resuming)
        aws dms stop-replication-task --region "$R" --replication-task-arn "$TARN" >/dev/null
        wait_status "dms-task:$TARN" "stopped|failed|ready" aws dms describe-replication-tasks --region "$R" --filters "Name=replication-task-arn,Values=$TARN" --query 'ReplicationTasks[0].Status' --output text
        ;;
    esac
    aws dms delete-replication-task --region "$R" --replication-task-arn "$TARN" >/dev/null
    wait_gone "dms-task:$TARN" aws dms describe-replication-tasks --region "$R" --filters "Name=replication-task-arn,Values=$TARN" --query 'ReplicationTasks[0].ReplicationTaskArn' --output text
    record "$CURRENT_STEP" deleted "dms-task:${TARN##*:}" ""
  done <<<"$(clean "$DTASKS")"
  aws dms delete-replication-instance --region "$R" --replication-instance-arn "$iarn" >/dev/null
  wait_gone "dms-instance:$iarn" aws dms describe-replication-instances --region "$R" --filters "Name=replication-instance-arn,Values=$iarn" --query 'ReplicationInstances[0].ReplicationInstanceArn' --output text
  record "$CURRENT_STEP" deleted "dms-instance:${iarn##*:}" ""
done

# ── 6. 经典 MWAA 环境(RETAIN 的有状态托管环境;存量双装目标才有)──
CURRENT_STEP="6-mwaa"
MWAA_ENV="$(name_of mwaaEnvName)"
if MST="$(aws mwaa get-environment --region "$R" --name "$MWAA_ENV" --query 'Environment.Status' --output text 2>&1)"; then
  if [ "$MST" != "DELETING" ]; then aws mwaa delete-environment --region "$R" --name "$MWAA_ENV" >/dev/null; fi
  wait_gone "mwaa:$MWAA_ENV" aws mwaa get-environment --region "$R" --name "$MWAA_ENV" --query 'Environment.Status' --output text
  record "$CURRENT_STEP" deleted "mwaa:$MWAA_ENV" ""
elif is_not_found "$MST"; then
  record "$CURRENT_STEP" skipped "mwaa:$MWAA_ENV" "不存在"
else
  stuck "mwaa:$MWAA_ENV" "读环境失败:$(last_line "$MST")"
fi

# ── 7. Redshift Serverless:工作组(删)→ 命名空间(🔴 带最终快照删)──
CURRENT_STEP="7-redshift"
WG="$(name_of redshiftWorkgroup)"
NS="$(name_of redshiftNamespace)"
SNAP="$EXEC_ENV_FINAL_SNAPSHOT"
if WST="$(aws redshift-serverless get-workgroup --region "$R" --workgroup-name "$WG" --query 'workgroup.status' --output text 2>&1)"; then
  if [ "$WST" != "DELETING" ]; then aws redshift-serverless delete-workgroup --region "$R" --workgroup-name "$WG" >/dev/null; fi
  wait_gone "redshift-workgroup:$WG" aws redshift-serverless get-workgroup --region "$R" --workgroup-name "$WG" --query 'workgroup.status' --output text
  record "$CURRENT_STEP" deleted "redshift-workgroup:$WG" ""
elif is_not_found "$WST"; then
  record "$CURRENT_STEP" skipped "redshift-workgroup:$WG" "不存在"
else
  stuck "redshift-workgroup:$WG" "读工作组失败:$(last_line "$WST")"
fi
NS_EXISTED=0
if NST="$(aws redshift-serverless get-namespace --region "$R" --namespace-name "$NS" --query 'namespace.status' --output text 2>&1)"; then
  NS_EXISTED=1
  if [ "$NST" != "DELETING" ]; then
    if SST="$(aws redshift-serverless get-snapshot --region "$R" --snapshot-name "$SNAP" --query 'snapshot.status' --output text 2>&1)"; then
      # 重试路径:上一轮已经按这个名字拍过最终快照 ⇒ 数据已在快照里(环境早已停止承接),删命名空间不再要求新快照
      echo "destroy: 最终快照 $SNAP 已存在(status=$SST)⇒ 删命名空间时不重复建快照"
      aws redshift-serverless delete-namespace --region "$R" --namespace-name "$NS" >/dev/null
    elif is_not_found "$SST"; then
      aws redshift-serverless delete-namespace --region "$R" --namespace-name "$NS" \
        --final-snapshot-name "$SNAP" --final-snapshot-retention-period -1 >/dev/null
    else
      stuck "redshift-snapshot:$SNAP" "查最终快照失败(查不清就不删命名空间,免得丢数据):$(last_line "$SST")"
    fi
  fi
  wait_gone "redshift-namespace:$NS" aws redshift-serverless get-namespace --region "$R" --namespace-name "$NS" --query 'namespace.status' --output text
  record "$CURRENT_STEP" deleted "redshift-namespace:$NS" "final-snapshot=$SNAP"
elif is_not_found "$NST"; then
  record "$CURRENT_STEP" skipped "redshift-namespace:$NS" "不存在"
else
  stuck "redshift-namespace:$NS" "读命名空间失败:$(last_line "$NST")"
fi
# 最终快照必须真的在(命名空间存在过的话);拍快照是异步的,等到 AVAILABLE
if SST="$(aws redshift-serverless get-snapshot --region "$R" --snapshot-name "$SNAP" --query 'snapshot.status' --output text 2>&1)"; then
  wait_status "redshift-snapshot:$SNAP" "AVAILABLE" aws redshift-serverless get-snapshot --region "$R" --snapshot-name "$SNAP" --query 'snapshot.status' --output text
  record "$CURRENT_STEP" retained "redshift-snapshot:$SNAP" "最终快照(数仓数据)"
elif is_not_found "$SST"; then
  if [ "$NS_EXISTED" = 1 ]; then stuck "redshift-snapshot:$SNAP" "命名空间删了,但最终快照不存在 —— 数仓数据可能没留住,停下来交人工确认"; fi
else
  stuck "redshift-snapshot:$SNAP" "查最终快照失败:$(last_line "$SST")"
fi

# ══ ② 组件栈反依赖序 → core → base ═══════════════════════════════════════════════════════════════════════
CURRENT_STEP="8-stacks"
stack_failure_reason() {
  aws cloudformation describe-stack-events --region "$R" --stack-name "$1" \
    --query "StackEvents[?ResourceStatus=='DELETE_FAILED'].[LogicalResourceId,ResourceType,ResourceStatusReason] | [0]" --output text 2>/dev/null | tr '\t' ' ' | cut -c1-400
}
for suffix in $EXEC_ENV_DESTROY_SUFFIXES; do
  STACK="BgpExecEnv-$SLUG-$suffix"
  if ! SST="$(aws cloudformation describe-stacks --region "$R" --stack-name "$STACK" --query 'Stacks[0].StackStatus' --output text 2>&1)"; then
    if is_not_found "$SST"; then record "$CURRENT_STEP" skipped "stack:$STACK" "不存在"; continue; fi
    stuck "stack:$STACK" "读栈失败:$(last_line "$SST")"
  fi
  if [ "$SST" = "DELETE_COMPLETE" ]; then record "$CURRENT_STEP" skipped "stack:$STACK" "已删"; continue; fi
  if [ "$SST" != "DELETE_IN_PROGRESS" ]; then aws cloudformation delete-stack --region "$R" --stack-name "$STACK"; fi
  i=0
  while :; do
    if ! SST="$(aws cloudformation describe-stacks --region "$R" --stack-name "$STACK" --query 'Stacks[0].StackStatus' --output text 2>&1)"; then
      if is_not_found "$SST"; then break; fi
      stuck "stack:$STACK" "读栈失败:$(last_line "$SST")"
    fi
    case "$SST" in
      DELETE_COMPLETE) break ;;
      DELETE_FAILED) stuck "stack:$STACK" "DELETE_FAILED:$(stack_failure_reason "$STACK")" ;;
    esac
    i=$((i + 1))
    if [ "$i" -ge "$MAX_POLLS" ]; then stuck "stack:$STACK" "删栈等了 ${i} 轮仍是 $SST"; fi
    sleep "$POLL"
  done
  record "$CURRENT_STEP" deleted "stack:$STACK" ""
done

# ══ ③ 收尾探测 + 列出保留的数据资源 ═════════════════════════════════════════════════════════════════════
CURRENT_STEP="9-verify"
for suffix in $EXEC_ENV_DESTROY_SUFFIXES; do
  STACK="BgpExecEnv-$SLUG-$suffix"
  if SST="$(aws cloudformation describe-stacks --region "$R" --stack-name "$STACK" --query 'Stacks[0].StackStatus' --output text 2>&1)"; then
    [ "$SST" = "DELETE_COMPLETE" ] || stuck "stack:$STACK" "收尾探测仍在($SST)"
  elif ! is_not_found "$SST"; then
    stuck "stack:$STACK" "收尾探测查不清:$(last_line "$SST")"
  fi
done
if ! LEFT="$(aws ec2 describe-vpcs --region "$R" --filters "Name=tag:aws:cloudformation:stack-name,Values=$BASE_STACK" --query 'Vpcs[].VpcId' --output text 2>&1)"; then
  stuck "vpc" "收尾探测查不清:$(last_line "$LEFT")"
fi
[ -z "$(clean "$LEFT" | tr -d '[:space:]')" ] || stuck "vpc:$(clean "$LEFT")" "收尾探测:本 target 的 VPC 仍在"

retained_bucket() {
  local b
  b="$(name_of "$1")"
  if aws s3api head-bucket --region "$R" --bucket "$b" >/dev/null 2>&1; then record "$CURRENT_STEP" retained "s3:$b" "$2"; fi
}
retained_bucket datalakeBucket "数据湖桶"
retained_bucket scriptsBucket "脚本桶"
retained_bucket workflowBucket "工作流定义桶"
retained_bucket dagBucket "DAG 桶"
retained_bucket residencyBucket "驻留结果桶"
TB="$(name_of tableBucket)"
if TBA="$(aws s3tables list-table-buckets --region "$R" --query "tableBuckets[?name=='$TB'].arn | [0]" --output text 2>&1)" && [ -n "$(clean "$TBA")" ]; then
  record "$CURRENT_STEP" retained "s3tables:$TB" "表桶"
fi
for kind in residencyAuditTable residencyResultsTable; do
  T="$(name_of "$kind")"
  if aws dynamodb describe-table --region "$R" --table-name "$T" >/dev/null 2>&1; then record "$CURRENT_STEP" retained "dynamodb:$T" "驻留审计 / 结果表"; fi
done
KA="$(name_of dataKeyAlias)"
if KID="$(aws kms list-aliases --region "$R" --query "Aliases[?AliasName=='$KA'].TargetKeyId | [0]" --output text 2>&1)" && [ -n "$(clean "$KID")" ]; then
  record "$CURRENT_STEP" retained "kms:$KA" "数据域 CMK"
fi
record "$CURRENT_STEP" done "target:$EXEC_ENV_TARGET" "本 slug 无栈、无 VPC"
echo "✅ destroy 完成:$EXEC_ENV_TARGET@$R 的栈与托管服务已删;数据类资源保留(见报告)"
