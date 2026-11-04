#!/usr/bin/env bash
###############################################################################
# Seed the source MySQL with the golden e-commerce dataset — via a Glue job
# (runs inside the VPC, so it never connects to the DB from your laptop).
#
#   ./scripts/20-seed-data.sh <aws-profile> [region]
#
# Idempotent: safe to re-run. Creates (if absent) a Glue NETWORK connection into
# the RDS subnet + a Glue 5.1 python job, then runs it. The job DROPs+recreates
# the 4 tables each run, so the row counts are always the golden totals:
#   products=50  fx_rates=70  orders=100000  order_items=~299778
#
# Root-cause note: this used to be a manual, error-prone set of CLI steps (build
# the connection with the RIGHT subnet-AZ pairing, attach pymysql, poll the run).
# It is now a first-class, idempotent deploy step so every fresh account gets the
# same seeded data with one command — no more hand-rolled Glue jobs.
###############################################################################
set -euo pipefail
PROFILE="${1:-temp-account}"
REGION="${2:-us-east-1}"
HERE="$(cd "$(dirname "$0")" && pwd)"

ACCT=$(aws sts get-caller-identity --profile "$PROFILE" --region "$REGION" --query Account --output text)
SCRIPTS_BUCKET="bgp-glue-scripts-$ACCT"
echo "[seed] account=$ACCT bucket=$SCRIPTS_BUCKET"

out() { aws cloudformation describe-stacks --stack-name "$1" --profile "$PROFILE" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text; }

RDS_HOST=$(out BgpRdsStack RdsEndpoint)
RDS_SECRET=$(out BgpRdsStack RdsSecretArn)
[ -n "$RDS_HOST" ] && [ "$RDS_HOST" != "None" ] || { echo "[seed] ERROR: BgpRdsStack not deployed"; exit 1; }
echo "[seed] rds host=$RDS_HOST"

# --- Glue NETWORK connection into the RDS subnet (correct subnet<->AZ pairing) ---
# Root-cause fix for the AZ mismatch trap: read subnet + its OWN AvailabilityZone
# from the SAME describe call, so they always correspond.
RDS_SG=$(aws rds describe-db-instances --db-instance-identifier bgp-source-mysql --profile "$PROFILE" --region "$REGION" \
  --query "DBInstances[0].VpcSecurityGroups[0].VpcSecurityGroupId" --output text)
VPC_ID=$(aws ec2 describe-vpcs --filters Name=tag:Name,Values='BgpVpcStack/BgpVpc' --profile "$PROFILE" --region "$REGION" \
  --query 'Vpcs[0].VpcId' --output text)
read -r SUBNET_ID AZ < <(aws ec2 describe-subnets \
  --filters Name=vpc-id,Values=$VPC_ID Name=tag:aws-cdk:subnet-type,Values=Private \
  --profile "$PROFILE" --region "$REGION" \
  --query 'Subnets[0].[SubnetId,AvailabilityZone]' --output text)
echo "[seed] connection subnet=$SUBNET_ID az=$AZ sg=$RDS_SG"

aws glue create-connection --profile "$PROFILE" --region "$REGION" --connection-input "{
  \"Name\": \"bgp-seed-network\",
  \"ConnectionType\": \"NETWORK\",
  \"ConnectionProperties\": {},
  \"PhysicalConnectionRequirements\": {
    \"SubnetId\": \"$SUBNET_ID\",
    \"SecurityGroupIdList\": [\"$RDS_SG\"],
    \"AvailabilityZone\": \"$AZ\"
  }
}" >/dev/null 2>&1 && echo "[seed] + connection created" || echo "[seed] = connection exists (ok)"

# --- upload seed script + create Glue 5.1 job ---
aws s3 cp "$HERE/seed_ecommerce.py" "s3://$SCRIPTS_BUCKET/glue-scripts/seed_ecommerce.py" \
  --profile "$PROFILE" --region "$REGION" >/dev/null
echo "[seed] uploaded seed_ecommerce.py"

aws glue create-job --profile "$PROFILE" --region "$REGION" \
  --name bgp-ecom-seed \
  --role "arn:aws:iam::$ACCT:role/bgp-glue-role" \
  --command "Name=glueetl,ScriptLocation=s3://$SCRIPTS_BUCKET/glue-scripts/seed_ecommerce.py,PythonVersion=3" \
  --glue-version "5.1" \
  --worker-type G.1X --number-of-workers 2 --timeout 60 \
  --connections Connections=bgp-seed-network \
  --default-arguments "{
    \"--additional-python-modules\": \"pymysql\",
    \"--secret_arn\": \"$RDS_SECRET\",
    \"--host\": \"$RDS_HOST\",
    \"--database\": \"ecommerce\"
  }" >/dev/null 2>&1 && echo "[seed] + job created" || echo "[seed] = job exists (ok)"

# --- run + poll to SUCCEEDED ---
RUN_ID=$(aws glue start-job-run --job-name bgp-ecom-seed --profile "$PROFILE" --region "$REGION" --query JobRunId --output text)
echo "[seed] run=$RUN_ID (this takes ~3-5 min)"
for i in $(seq 1 40); do
  ST=$(aws glue get-job-run --job-name bgp-ecom-seed --run-id "$RUN_ID" --profile "$PROFILE" --region "$REGION" \
    --query 'JobRun.JobRunState' --output text)
  case "$ST" in
    SUCCEEDED) echo "[seed] SUCCEEDED — golden dataset loaded."; break;;
    FAILED|ERROR|STOPPED|TIMEOUT)
      echo "[seed] $ST:"; aws glue get-job-run --job-name bgp-ecom-seed --run-id "$RUN_ID" \
        --profile "$PROFILE" --region "$REGION" --query 'JobRun.ErrorMessage' --output text; exit 1;;
    *) sleep 20;;
  esac
done
echo "[seed] done."
