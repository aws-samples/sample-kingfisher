#!/usr/bin/env bash
###############################################################################
# @kf-batch 50-WP7pre-region-seed
# 在**某个执行环境自己的 region** 就地造游戏分析数据集(Parquet 落该区数据湖 + 注册该区 Glue Catalog)。
#
#   ./scripts/23-seed-game-region.sh <aws-profile> <targetId> [scale] [region]
#     scale = 玩家数(默认 20000 ⇒ 约 70 万行;给 100000 ⇒ 约 350 万行)
#
# 🔴 为什么不是「把主控区的源库同步过去」:源库只在主控区,跨区去读它就是数据出境;
#   而同步搬运的逐区下推是 **WP-7**(产品现在 fail-closed:任务章不是 home 就 409,绝不偷偷在 home 跑)。
#   ⇒ 在 WP-7 落地前,「那个区要有真实数据」只能**生在那个区**。数据是确定性生成的,两区同构可比。
# 🔴 一切资源都从**执行环境注册表**读(桶 / Glue 角色 / region),零硬编码;它就是落点的单一真值源。
###############################################################################
set -euo pipefail
PROFILE="${1:-temp-account}"
TARGET="${2:?用法: 23-seed-game-region.sh <profile> <targetId> [scale] [region]}"
SCALE="${3:-20000}"
HERE="$(cd "$(dirname "$0")" && pwd)"
HOME_REGION="${KF_HOME_REGION:-us-east-1}"

row=$(aws dynamodb get-item --table-name bgp-execution-envs --profile "$PROFILE" --region "$HOME_REGION" \
        --key "{\"pk\":{\"S\":\"env\"},\"sk\":{\"S\":\"$TARGET\"}}" --output json)
REGION="${4:-$(printf '%s' "$row" | python3 -c 'import json,sys; print((json.load(sys.stdin)["Item"]["region"]["S"]))')}"
read -r LAKE SCRIPTS GLUE_ROLE < <(printf '%s' "$row" | python3 -c '
import json, sys
res = json.load(sys.stdin)["Item"]["resources"]["M"]
g = lambda k: res.get(k, {}).get("S", "")
print(g("datalakeBucket"), g("scriptsBucket"), g("glueRoleArn"))')
[ -n "$LAKE" ] && [ -n "$SCRIPTS" ] && [ -n "$GLUE_ROLE" ] || {
  echo "❌ $TARGET 的描述符缺 datalakeBucket / scriptsBucket / glueRoleArn(先「检测初始化」回写资源袋)"; exit 1; }
echo "[region-seed] target=$TARGET region=$REGION lake=$LAKE scripts=$SCRIPTS role=${GLUE_ROLE##*/} scale=$SCALE"

JOB="bgp-game-seed-$TARGET"
aws s3 cp "$HERE/seed_game_region.py" "s3://$SCRIPTS/scripts/seed_game_region.py" \
  --profile "$PROFILE" --region "$REGION" >/dev/null
echo "[region-seed] uploaded seed_game_region.py"

CMD=$(cat <<JSON
{"Name":"glueetl","ScriptLocation":"s3://$SCRIPTS/scripts/seed_game_region.py","PythonVersion":"3"}
JSON
)
ARGS=$(cat <<JSON
{"--job-language":"python","--enable-glue-datacatalog":"true","--datalake":"$LAKE","--scale":"$SCALE","--db":"gamedata","--TempDir":"s3://$SCRIPTS/tmp/"}
JSON
)
if aws glue get-job --job-name "$JOB" --profile "$PROFILE" --region "$REGION" >/dev/null 2>&1; then
  aws glue update-job --job-name "$JOB" --profile "$PROFILE" --region "$REGION" \
    --job-update "{\"Role\":\"$GLUE_ROLE\",\"GlueVersion\":\"5.1\",\"WorkerType\":\"G.1X\",\"NumberOfWorkers\":4,\"Timeout\":60,\"Command\":$CMD,\"DefaultArguments\":$ARGS}" >/dev/null
  echo "[region-seed] = job updated"
else
  aws glue create-job --name "$JOB" --profile "$PROFILE" --region "$REGION" \
    --role "$GLUE_ROLE" --glue-version 5.1 --worker-type G.1X --number-of-workers 4 --timeout 60 \
    --command "$CMD" --default-arguments "$ARGS" >/dev/null
  echo "[region-seed] + job created"
fi

RUN=$(aws glue start-job-run --job-name "$JOB" --profile "$PROFILE" --region "$REGION" --query JobRunId --output text)
echo "[region-seed] run=$RUN(G.1X ×4;scale=$SCALE 约 3–8 分钟)"
for i in $(seq 1 60); do
  sleep 20
  ST=$(aws glue get-job-run --job-name "$JOB" --run-id "$RUN" --profile "$PROFILE" --region "$REGION" \
        --query 'JobRun.JobRunState' --output text)
  case "$ST" in
    SUCCEEDED) echo "[region-seed] done."; break;;
    FAILED|TIMEOUT|STOPPED|ERROR)
      echo "❌ 造数失败:$ST"
      aws glue get-job-run --job-name "$JOB" --run-id "$RUN" --profile "$PROFILE" --region "$REGION" \
        --query 'JobRun.ErrorMessage' --output text; exit 1;;
    *) [ $((i % 3)) -eq 0 ] && echo "   … $ST";;
  esac
done
echo "[region-seed] 该区 Glue Catalog 里的 gamedata 表:"
aws glue get-tables --database-name gamedata --profile "$PROFILE" --region "$REGION" \
  --query 'TableList[].Name' --output text 2>/dev/null || echo "   (取不到表清单,去 Glue 控制台核)"
