#!/usr/bin/env bash
###############################################################################
# Seed the source MySQL with the GAME ad-analytics dataset — via a Glue job
# (runs inside the VPC, so it never connects to the DB from your laptop).
#
#   ./scripts/22-seed-game.sh <aws-profile> [region]
#
# Idempotent: safe to re-run. Reuses (or creates) the bgp-seed-network Glue
# connection into the RDS subnet + a Glue 5.1 python job (bgp-game-seed). The
# job DROPs+recreates its 7 tables in the `gamedata` database each run, so the
# row counts are always the same (~1.8M rows: ad_channels/ad_campaigns/
# ad_events/players/game_sessions/payments/player_events).
#
# Mirrors scripts/20-seed-data.sh (the ecommerce golden dataset) — same
# connection/subnet-AZ pairing, same secret-from-Secrets-Manager pattern —
# but points at seed_game.py + the gamedata schema.
###############################################################################
set -euo pipefail
PROFILE="${1:-temp-account}"
REGION="${2:-us-east-1}"
HERE="$(cd "$(dirname "$0")" && pwd)"

ACCT=$(aws sts get-caller-identity --profile "$PROFILE" --region "$REGION" --query Account --output text)
SCRIPTS_BUCKET="bgp-glue-scripts-$ACCT"
echo "[game-seed] account=$ACCT bucket=$SCRIPTS_BUCKET"

out() { aws cloudformation describe-stacks --stack-name "$1" --profile "$PROFILE" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text; }

RDS_HOST=$(out BgpRdsStack RdsEndpoint)
RDS_SECRET=$(out BgpRdsStack RdsSecretArn)
[ -n "$RDS_HOST" ] && [ "$RDS_HOST" != "None" ] || { echo "[game-seed] ERROR: BgpRdsStack not deployed"; exit 1; }
echo "[game-seed] rds host=$RDS_HOST"

# --- Glue NETWORK connection into the RDS subnet (correct subnet<->AZ pairing) ---
RDS_SG=$(aws rds describe-db-instances --db-instance-identifier bgp-source-mysql --profile "$PROFILE" --region "$REGION" \
  --query "DBInstances[0].VpcSecurityGroups[0].VpcSecurityGroupId" --output text)
VPC_ID=$(aws ec2 describe-vpcs --filters Name=tag:Name,Values='BgpVpcStack/BgpVpc' --profile "$PROFILE" --region "$REGION" \
  --query 'Vpcs[0].VpcId' --output text)
read -r SUBNET_ID AZ < <(aws ec2 describe-subnets \
  --filters Name=vpc-id,Values=$VPC_ID Name=tag:aws-cdk:subnet-type,Values=Private \
  --profile "$PROFILE" --region "$REGION" \
  --query 'Subnets[0].[SubnetId,AvailabilityZone]' --output text)
echo "[game-seed] connection subnet=$SUBNET_ID az=$AZ sg=$RDS_SG"

aws glue create-connection --profile "$PROFILE" --region "$REGION" --connection-input "{
  \"Name\": \"bgp-seed-network\",
  \"ConnectionType\": \"NETWORK\",
  \"ConnectionProperties\": {},
  \"PhysicalConnectionRequirements\": {
    \"SubnetId\": \"$SUBNET_ID\",
    \"SecurityGroupIdList\": [\"$RDS_SG\"],
    \"AvailabilityZone\": \"$AZ\"
  }
}" >/dev/null 2>&1 && echo "[game-seed] + connection created" || echo "[game-seed] = connection exists (ok)"

# --- upload seed script + create Glue 5.1 job ---
aws s3 cp "$HERE/seed_game.py" "s3://$SCRIPTS_BUCKET/glue-scripts/seed_game.py" \
  --profile "$PROFILE" --region "$REGION" >/dev/null
echo "[game-seed] uploaded seed_game.py"

aws glue create-job --profile "$PROFILE" --region "$REGION" \
  --name bgp-game-seed \
  --role "arn:aws:iam::$ACCT:role/bgp-glue-role" \
  --command "Name=glueetl,ScriptLocation=s3://$SCRIPTS_BUCKET/glue-scripts/seed_game.py,PythonVersion=3" \
  --glue-version "5.1" \
  --worker-type G.1X --number-of-workers 4 --timeout 60 \
  --connections Connections=bgp-seed-network \
  --default-arguments "{
    \"--additional-python-modules\": \"pymysql\",
    \"--secret_arn\": \"$RDS_SECRET\",
    \"--host\": \"$RDS_HOST\",
    \"--database\": \"gamedata\"
  }" >/dev/null 2>&1 && echo "[game-seed] + job created" || {
    # job may already exist — update it so re-runs pick up script/arg changes
    aws glue update-job --profile "$PROFILE" --region "$REGION" --job-name bgp-game-seed \
      --job-update "{
        \"Role\": \"arn:aws:iam::$ACCT:role/bgp-glue-role\",
        \"Command\": {\"Name\":\"glueetl\",\"ScriptLocation\":\"s3://$SCRIPTS_BUCKET/glue-scripts/seed_game.py\",\"PythonVersion\":\"3\"},
        \"GlueVersion\": \"5.1\",
        \"WorkerType\": \"G.1X\", \"NumberOfWorkers\": 4, \"Timeout\": 60,
        \"Connections\": {\"Connections\": [\"bgp-seed-network\"]},
        \"DefaultArguments\": {
          \"--additional-python-modules\": \"pymysql\",
          \"--secret_arn\": \"$RDS_SECRET\",
          \"--host\": \"$RDS_HOST\",
          \"--database\": \"gamedata\"
        }
      }" >/dev/null && echo "[game-seed] = job updated (existed)"; }

# --- run + poll to SUCCEEDED ---
RUN_ID=$(aws glue start-job-run --job-name bgp-game-seed --profile "$PROFILE" --region "$REGION" --query JobRunId --output text)
echo "[game-seed] run=$RUN_ID (this takes ~5-8 min for ~1.8M rows)"
for i in $(seq 1 60); do
  ST=$(aws glue get-job-run --job-name bgp-game-seed --run-id "$RUN_ID" --profile "$PROFILE" --region "$REGION" \
    --query 'JobRun.JobRunState' --output text)
  case "$ST" in
    SUCCEEDED) echo "[game-seed] SUCCEEDED — game dataset loaded into gamedata."; break;;
    FAILED|ERROR|STOPPED|TIMEOUT)
      echo "[game-seed] $ST:"; aws glue get-job-run --job-name bgp-game-seed --run-id "$RUN_ID" \
        --profile "$PROFILE" --region "$REGION" --query 'JobRun.ErrorMessage' --output text; exit 1;;
    *) sleep 20;;
  esac
done
echo "[game-seed] done. run-id=$RUN_ID"
