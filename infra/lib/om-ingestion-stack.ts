import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
// 资源 ARN 的 region 段唯一出口 + 显式轴声明。
import { regionalStatement } from "./shared/execution-regions";

interface OmIngestionStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
}

/**
 * BgpOmIngestionStack — OpenMetadata metadata ingestion (design module 10, Phase 1).
 *
 * Runs the official openmetadata/ingestion image as scheduled ECS Fargate tasks
 * (EventBridge Scheduler), one connector per task. No always-on Airflow.
 * Secrets (OM ingestion-bot JWT, source credentials) are injected from Secrets
 * Manager via ECS task secrets and read at runtime through os.environ — they are
 * never written into the image, task definition plaintext, or logs.
 *
 * P1 scope: Redshift connector (metadata). Glue (S3 Tables) and S3 connectors are
 * added next as additional task definitions + schedules following the same pattern.
 *
 * Required context (env-specific):
 *   -c om-bot-secret-arn=<complete ARN of bgp/om/ingestion-bot-token>
 *   -c rs-admin-secret-arn=<complete ARN of redshift! managed admin secret>
 *   -c openmetadata-url=http://<om-alb-dns>   (optional; defaults to current deploy)
 */
export class OmIngestionStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: OmIngestionStackProps) {
    super(scope, id, props);

    const { vpc } = props;
    const region = cdk.Stack.of(this).region;
    const account = cdk.Stack.of(this).account;

    const omHost: string =
      this.node.tryGetContext("openmetadata-url") || "";
    const omBotSecretArn: string = this.node.tryGetContext("om-bot-secret-arn");
    const rsAdminSecretArn: string = this.node.tryGetContext("rs-admin-secret-arn");
    if (!omHost || !omBotSecretArn || !rsAdminSecretArn) {
      throw new Error(
        "BgpOmIngestionStack requires context: -c openmetadata-url=... " +
          "-c om-bot-secret-arn=... -c rs-admin-secret-arn=..."
      );
    }

    const cluster = new ecs.Cluster(this, "IngestCluster", {
      vpc,
      clusterName: "bgp-ingestion-cluster",
    });

    const ingestSg = new ec2.SecurityGroup(this, "IngestSg", {
      vpc,
      description: "OpenMetadata ingestion tasks (egress only)",
      allowAllOutbound: true,
    });

    const logGroup = new logs.LogGroup(this, "IngestLogs", {
      logGroupName: "/bgp/om-ingestion",
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Secrets imported by complete ARN so ECS can extract JSON keys precisely.
    const botSecret = secretsmanager.Secret.fromSecretCompleteArn(this, "OmBotSecret", omBotSecretArn);
    const rsSecret = secretsmanager.Secret.fromSecretCompleteArn(this, "RsAdminSecret", rsAdminSecretArn);

    const image = ecs.ContainerImage.fromRegistry(
      "docker.getcollate.io/openmetadata/ingestion:1.6.1"
    );

    // Render the connector YAML (as JSON, a YAML subset) at runtime from env vars.
    // Secret values come only from os.environ (ECS secrets), never the command text.
    const renderAndIngest = (pyCfg: string): string =>
      [
        "set -euo pipefail",
        "python3 - <<'PY'",
        "import json, os",
        `cfg = ${pyCfg}`,
        "open('/tmp/ingest.yaml', 'w').write(json.dumps(cfg))",
        "PY",
        "metadata ingest -c /tmp/ingest.yaml",
      ].join("\n");

    // ---------------- Redshift connector (P1) ----------------
    const rsHost = `bgp-workgroup.${account}.${region}.redshift-serverless.amazonaws.com`;
    const redshiftCfg = [
      "{",
      "  'source': {",
      "    'type': 'redshift', 'serviceName': 'bgp-redshift',",
      "    'serviceConnection': {'config': {",
      "      'type': 'Redshift',",
      "      'hostPort': os.environ['RS_HOST'] + ':5439',",
      "      'username': os.environ['RS_USER'],",
      "      'password': os.environ['RS_PASSWORD'],",
      "      'database': os.environ['RS_DB'],",
      "      'sslMode': 'require'}},",
      "    'sourceConfig': {'config': {",
      "      'type': 'DatabaseMetadata',",
      "      'schemaFilterPattern': {'excludes': ['information_schema', 'pg_catalog', 'pg_internal', 'pg_automv', 'catalog_history']}}}},",
      "  'sink': {'type': 'metadata-rest', 'config': {}},",
      "  'workflowConfig': {'openMetadataServerConfig': {",
      "    'hostPort': os.environ['OM_HOST'] + '/api',",
      "    'authProvider': 'openmetadata',",
      "    'securityConfig': {'jwtToken': os.environ['OM_JWT']}}}}",
    ].join("\n");

    const redshiftTask = new ecs.FargateTaskDefinition(this, "RedshiftIngestTask", {
      cpu: 512,
      memoryLimitMiB: 1024,
    });
    redshiftTask.addContainer("ingest", {
      image,
      entryPoint: ["/bin/bash", "-c"],
      command: [renderAndIngest(redshiftCfg)],
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "redshift", logGroup }),
      environment: {
        OM_HOST: omHost,
        RS_HOST: rsHost,
        RS_DB: "dev",
        RS_USER: "admin",
      },
      secrets: {
        OM_JWT: ecs.Secret.fromSecretsManager(botSecret),
        RS_PASSWORD: ecs.Secret.fromSecretsManager(rsSecret, "password"),
      },
    });

    new events.Rule(this, "RedshiftIngestSchedule", {
      ruleName: "bgp-om-ingest-redshift",
      description: "Scheduled OpenMetadata Redshift metadata ingestion",
      schedule: events.Schedule.rate(cdk.Duration.hours(6)),
      targets: [
        new targets.EcsTask({
          cluster,
          taskDefinition: redshiftTask,
          subnetSelection: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
          securityGroups: [ingestSg],
          assignPublicIp: false,
        }),
      ],
    });

    // Shared task role for connectors that call AWS APIs (Glue / S3 Tables / S3).
    // Read-only; credentials are picked up by boto3 from the task role.
    const connectorTaskRole = new iam.Role(this, "ConnectorTaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description: "Read-only access for OpenMetadata Glue/S3 ingestion connectors",
    });
    connectorTaskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "glue:GetDatabases", "glue:GetDatabase", "glue:GetTables", "glue:GetTable",
          "glue:GetPartitions", "glue:BatchGetPartition", "glue:GetCatalog",
          "glue:GetCatalogs", "glue:SearchTables",
          "s3tables:GetTableBucket", "s3tables:ListTableBuckets", "s3tables:GetNamespace",
          "s3tables:ListNamespaces", "s3tables:GetTable", "s3tables:ListTables",
          "s3tables:GetTableMetadataLocation",
          "lakeformation:GetDataAccess",
          "s3:ListAllMyBuckets", "s3:GetBucketLocation", "s3:ListBucket", "s3:GetObject",
        ],
        resources: ["*"],
      })
    );

    // ---------------- Glue connector (Glue Data Catalog + S3 Tables) ----------------
    const glueCfg = [
      "{",
      "  'source': {",
      "    'type': 'glue', 'serviceName': 'bgp-glue',",
      `    'serviceConnection': {'config': {'type': 'Glue', 'awsConfig': {'awsRegion': '${region}'}}},`,
      "    'sourceConfig': {'config': {'type': 'DatabaseMetadata'}}},",
      "  'sink': {'type': 'metadata-rest', 'config': {}},",
      "  'workflowConfig': {'openMetadataServerConfig': {",
      "    'hostPort': os.environ['OM_HOST'] + '/api',",
      "    'authProvider': 'openmetadata',",
      "    'securityConfig': {'jwtToken': os.environ['OM_JWT']}}}}",
    ].join("\n");
    const glueTask = new ecs.FargateTaskDefinition(this, "GlueIngestTask", {
      cpu: 512, memoryLimitMiB: 1024, taskRole: connectorTaskRole,
    });
    glueTask.addContainer("ingest", {
      image,
      entryPoint: ["/bin/bash", "-c"],
      command: [renderAndIngest(glueCfg)],
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "glue", logGroup }),
      environment: { OM_HOST: omHost },
      secrets: { OM_JWT: ecs.Secret.fromSecretsManager(botSecret) },
    });
    new events.Rule(this, "GlueIngestSchedule", {
      ruleName: "bgp-om-ingest-glue",
      description: "Scheduled OpenMetadata Glue / S3 Tables metadata ingestion",
      schedule: events.Schedule.rate(cdk.Duration.hours(6)),
      targets: [
        new targets.EcsTask({
          cluster, taskDefinition: glueTask,
          subnetSelection: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
          securityGroups: [ingestSg], assignPublicIp: false,
        }),
      ],
    });

    // ---------------- S3 storage connector (data lake bucket) ----------------
    const s3Cfg = [
      "{",
      "  'source': {",
      "    'type': 's3', 'serviceName': 'bgp-s3',",
      `    'serviceConnection': {'config': {'type': 'S3', 'awsConfig': {'awsRegion': '${region}'}}},`,
      "    'sourceConfig': {'config': {'type': 'StorageMetadata',",
      "      'containerFilterPattern': {'includes': ['bgp-.*']}}}},",
      "  'sink': {'type': 'metadata-rest', 'config': {}},",
      "  'workflowConfig': {'openMetadataServerConfig': {",
      "    'hostPort': os.environ['OM_HOST'] + '/api',",
      "    'authProvider': 'openmetadata',",
      "    'securityConfig': {'jwtToken': os.environ['OM_JWT']}}}}",
    ].join("\n");
    const s3Task = new ecs.FargateTaskDefinition(this, "S3IngestTask", {
      cpu: 512, memoryLimitMiB: 1024, taskRole: connectorTaskRole,
    });
    s3Task.addContainer("ingest", {
      image,
      entryPoint: ["/bin/bash", "-c"],
      command: [renderAndIngest(s3Cfg)],
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "s3", logGroup }),
      environment: { OM_HOST: omHost },
      secrets: { OM_JWT: ecs.Secret.fromSecretsManager(botSecret) },
    });
    new events.Rule(this, "S3IngestSchedule", {
      ruleName: "bgp-om-ingest-s3",
      description: "Scheduled OpenMetadata S3 storage metadata ingestion",
      schedule: events.Schedule.rate(cdk.Duration.hours(24)),
      targets: [
        new targets.EcsTask({
          cluster, taskDefinition: s3Task,
          subnetSelection: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
          securityGroups: [ingestSg], assignPublicIp: false,
        }),
      ],
    });

    // ---------------- S3 Tables (Iceberg) custom ingestion ----------------
    // OM connectors cannot auto-discover S3 Tables because they live in the
    // `s3tablescatalog` federated Glue catalog (not listed by Glue/Athena catalog
    // APIs). This task enumerates them via the s3tables API, reads each table's
    // Iceberg schema via Glue get-table on the federated catalog, and upserts the
    // entities into OM via REST (CustomDatabase service `bgp-s3tables`).
    const s3TablesScript = [
      "set -euo pipefail",
      "python3 -m pip install -q -U boto3 botocore >/dev/null 2>&1 || true",
      "python3 - <<'PY'",
      "import os, json, re, urllib.request, urllib.error, boto3",
      "OM=os.environ['OM_HOST'].rstrip('/'); JWT=os.environ['OM_JWT']; REGION=os.environ['REGION']",
      "SERVICE='bgp-s3tables'",
      "acct=boto3.client('sts',region_name=REGION).get_caller_identity()['Account']",
      "s3t=boto3.client('s3tables',region_name=REGION); s3=boto3.client('s3',region_name=REGION)",
      "def om(method,path,body=None):",
      "    data=json.dumps(body).encode() if body is not None else None",
      "    req=urllib.request.Request(OM+path,data=data,method=method,headers={'Authorization':'Bearer '+JWT,'Content-Type':'application/json'})",
      "    try:",
      "        with urllib.request.urlopen(req,timeout=30) as r: return r.status",
      "    except urllib.error.HTTPError as e: return e.code",
      "TM={'int':'INT','integer':'INT','bigint':'BIGINT','long':'BIGINT','smallint':'SMALLINT','tinyint':'TINYINT','double':'DOUBLE','float':'FLOAT','decimal':'DECIMAL','numeric':'DECIMAL','boolean':'BOOLEAN','timestamp':'TIMESTAMP','timestamptz':'TIMESTAMP','date':'DATE','string':'STRING','varchar':'VARCHAR','char':'CHAR','binary':'BINARY'}",
      "def mt(gt):",
      "    base=re.split(r'[<(]',gt.strip().lower())[0]; return TM.get(base,'STRING')",
      "om('PUT','/api/v1/services/databaseServices',{'name':SERVICE,'serviceType':'CustomDatabase','connection':{'config':{'type':'CustomDatabase','sourcePythonClass':'metadata.ingestion.source.database.customdatabase.CustomDatabaseSource'}}})",
      "buckets=s3t.list_table_buckets().get('tableBuckets',[])",
      "print('table buckets:',[b['name'] for b in buckets])",
      "for b in buckets:",
      "    bn=b['name']; ba=b['arn']",
      "    om('PUT','/api/v1/databases',{'name':bn,'service':SERVICE})",
      "    for nsobj in s3t.list_namespaces(tableBucketARN=ba).get('namespaces',[]):",
      "        ns=nsobj['namespace'][0] if isinstance(nsobj['namespace'],list) else nsobj['namespace']",
      "        om('PUT','/api/v1/databaseSchemas',{'name':ns,'database':SERVICE+'.'+bn})",
      "        for t in s3t.list_tables(tableBucketARN=ba,namespace=ns).get('tables',[]):",
      "            tn=t['name']; cols=[]",
      "            try:",
      "                ml=s3t.get_table_metadata_location(tableBucketARN=ba,namespace=ns,name=tn)['metadataLocation']",
      "                u=ml[5:]; mb,mk=u.split('/',1)",
      "                meta=json.loads(s3.get_object(Bucket=mb,Key=mk)['Body'].read())",
      "                schemas=meta.get('schemas') or ([meta['schema']] if meta.get('schema') else [])",
      "                csid=meta.get('current-schema-id')",
      "                sch=next((s for s in schemas if s.get('schema-id')==csid), schemas[-1] if schemas else {})",
      "                for f in sch.get('fields',[]):",
      "                    ft=f.get('type'); disp=ft if isinstance(ft,str) else (ft.get('type','string') if isinstance(ft,dict) else 'string')",
      "                    cols.append({'name':f['name'],'dataType':mt(disp),'dataTypeDisplay':str(ft)})",
      "            except Exception as e: print('schema fail',tn,e)",
      "            fqn=SERVICE+'.'+bn+'.'+ns+'.'+tn",
      "            exists=(om('GET','/api/v1/tables/name/'+fqn)==200)",
      "            if cols:",
      "                print('schema',fqn,'->',om('PUT','/api/v1/tables',{'name':tn,'databaseSchema':SERVICE+'.'+bn+'.'+ns,'columns':cols}))",
      "            elif not exists:",
      "                ph=[{'name':'_schema_pending','dataType':'STRING','description':'Registered from S3 Tables; columns are populated by the platform sync push (direct metadata read is gated by Lake Formation).'}]",
      "                print('register',fqn,'->',om('PUT','/api/v1/tables',{'name':tn,'databaseSchema':SERVICE+'.'+bn+'.'+ns,'columns':ph}))",
      "            else:",
      "                print('keep',fqn,'(schema unavailable; not overwriting existing columns)')",
      "print('s3tables ingestion done')",
      "PY",
    ].join("\n");
    const s3TablesTask = new ecs.FargateTaskDefinition(this, "S3TablesIngestTask", {
      cpu: 512, memoryLimitMiB: 1024, taskRole: connectorTaskRole,
    });
    s3TablesTask.addContainer("ingest", {
      image,
      entryPoint: ["/bin/bash", "-c"],
      command: [s3TablesScript],
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "s3tables", logGroup }),
      environment: { OM_HOST: omHost, REGION: region },
      secrets: { OM_JWT: ecs.Secret.fromSecretsManager(botSecret) },
    });
    new events.Rule(this, "S3TablesIngestSchedule", {
      ruleName: "bgp-om-ingest-s3tables",
      description: "Scheduled OpenMetadata S3 Tables (Iceberg) custom ingestion",
      schedule: events.Schedule.rate(cdk.Duration.hours(6)),
      targets: [
        new targets.EcsTask({
          cluster, taskDefinition: s3TablesTask,
          subnetSelection: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
          securityGroups: [ingestSg], assignPublicIp: false,
        }),
      ],
    });

    // ---------------- Source databases (MySQL) custom reconciliation ----------------
    // Periodic counterpart to the event-driven push (P2): enumerate the platform's
    // data sources from DynamoDB (`bgp-datasources`), connect to each MySQL source with
    // its Secrets Manager credentials, read INFORMATION_SCHEMA, and upsert the schema
    // into OpenMetadata under the SAME `bgp-sources` CustomDatabase service + FQN
    // (`bgp-sources.<db>.default.<table>`) used by the event push and the cross-system
    // lineage — so it reconciles drift / pre-existing sources with no duplicate entities.
    // A native OM MySQL connector cannot be used here: it would create `bgp-sources` as a
    // `Mysql` service, conflicting with the `CustomDatabase` service the push + lineage use.
    const sourceTaskRole = new iam.Role(this, "SourceConnectorTaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description: "OpenMetadata source-DB reconciliation: read bgp-datasources + datasource secrets",
    });
    sourceTaskRole.addToPolicy(
      regionalStatement(this, {
        axis: "home",
        reason: "控制面单份:数据源注册表 bgp-datasources 按 50 SPEC §1.1 只在 home 存一份",
        actions: ["dynamodb:Scan", "dynamodb:GetItem", "dynamodb:Query"],
        resources: (r) => [`arn:aws:dynamodb:${r}:${account}:table/bgp-datasources`],
      })
    );
    sourceTaskRole.addToPolicy(
      regionalStatement(this, {
        axis: "home",
        reason: "数据源凭证由平台在 home 统一托管(bgp/datasource/*);OM 摄取任务本身也只跑在 home",
        actions: ["secretsmanager:GetSecretValue"],
        resources: (r) => [`arn:aws:secretsmanager:${r}:${account}:secret:bgp/datasource/*`],
      })
    );

    const sourceScript = [
      "set -euo pipefail",
      "python3 -m pip install -q pymysql cryptography >/dev/null 2>&1 || true",
      "python3 - <<'PY'",
      "import os, json, urllib.request, urllib.error, boto3",
      "try:",
      "    import pymysql",
      "except Exception as e:",
      "    print('pymysql unavailable:', e); raise SystemExit(0)",
      "OM=os.environ['OM_HOST'].rstrip('/'); JWT=os.environ['OM_JWT']; REGION=os.environ['REGION']",
      "SERVICE='bgp-sources'",
      "ddb=boto3.resource('dynamodb',region_name=REGION).Table('bgp-datasources')",
      "sm=boto3.client('secretsmanager',region_name=REGION)",
      "def om(method,path,body=None):",
      "    data=json.dumps(body).encode() if body is not None else None",
      "    req=urllib.request.Request(OM+path,data=data,method=method,headers={'Authorization':'Bearer '+JWT,'Content-Type':'application/json'})",
      "    try:",
      "        with urllib.request.urlopen(req,timeout=30) as r: return r.status",
      "    except urllib.error.HTTPError as e: return e.code",
      "    except Exception as e: print('om err',path,e); return 0",
      "TM={'int':'INT','integer':'INT','mediumint':'INT','tinyint':'SMALLINT','smallint':'SMALLINT','bigint':'BIGINT','long':'BIGINT','float':'FLOAT','real':'FLOAT','double':'DOUBLE','decimal':'DECIMAL','numeric':'DECIMAL','date':'DATE','datetime':'TIMESTAMP','timestamp':'TIMESTAMP','timestamptz':'TIMESTAMP','boolean':'BOOLEAN','bool':'BOOLEAN','json':'JSON','jsonb':'JSON','super':'JSON','binary':'BINARY','varbinary':'BINARY','blob':'BINARY','bytea':'BINARY'}",
      "def mt(ct):",
      "    t=(ct or '').strip().lower()",
      "    if t=='tinyint(1)': return 'BOOLEAN'",
      "    # length-requiring types (varchar/char/text/...) fall through to STRING (no dataLength needed), matching the platform event push",
      "    return TM.get(t.split('(')[0].strip(),'STRING')",
      "om('PUT','/api/v1/services/databaseServices',{'name':SERVICE,'serviceType':'CustomDatabase','connection':{'config':{'type':'CustomDatabase','sourcePythonClass':'metadata.ingestion.source.database.customdatabase.CustomDatabaseSource'}}})",
      "items=[]; resp=ddb.scan(); items+=resp.get('Items',[])",
      "while 'LastEvaluatedKey' in resp:",
      "    resp=ddb.scan(ExclusiveStartKey=resp['LastEvaluatedKey']); items+=resp.get('Items',[])",
      "mysql_ds=[d for d in items if (d.get('type') or '')=='mysql']",
      "print('mysql datasources:',[d.get('name') for d in mysql_ds])",
      "for d in mysql_ds:",
      "    try:",
      "        host=d['host']; port=int(d.get('port') or 3306); db=d['database']; user=d.get('username') or 'admin'; arn=d.get('secretArn')",
      "        if not arn: print('skip (no secret):',d.get('name')); continue",
      "        sec=json.loads(sm.get_secret_value(SecretId=arn)['SecretString']); user=sec.get('username',user); pwd=sec.get('password','')",
      "        conn=pymysql.connect(host=host,port=port,user=user,password=pwd,database=db,connect_timeout=10)",
      "        cur=conn.cursor()",
      "        cur.execute(\"SELECT TABLE_NAME,COLUMN_NAME,COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=%s ORDER BY TABLE_NAME,ORDINAL_POSITION\",(db,))",
      "        tabs={}",
      "        for tn,cn,ct in cur.fetchall(): tabs.setdefault(tn,[]).append((cn,ct))",
      "        conn.close()",
      "        om('PUT','/api/v1/databases',{'name':db,'service':SERVICE})",
      "        om('PUT','/api/v1/databaseSchemas',{'name':'default','database':SERVICE+'.'+db})",
      "        for tn,cols in tabs.items():",
      "            omcols=[{'name':cn,'dataType':mt(ct),'dataTypeDisplay':ct or 'string','ordinalPosition':i+1} for i,(cn,ct) in enumerate(cols)] or [{'name':'_row','dataType':'STRING'}]",
      "            sc=om('PUT','/api/v1/tables',{'name':tn,'databaseSchema':SERVICE+'.'+db+'.default','tableType':'Regular','columns':omcols})",
      "            print('table',SERVICE+'.'+db+'.default.'+tn,'cols',len(omcols),'->',sc)",
      "    except Exception as e:",
      "        print('datasource failed:',d.get('name'),e)",
      "print('source reconciliation done')",
      "PY",
    ].join("\n");
    const sourceTask = new ecs.FargateTaskDefinition(this, "SourceIngestTask", {
      cpu: 512, memoryLimitMiB: 1024, taskRole: sourceTaskRole,
    });
    sourceTask.addContainer("ingest", {
      image,
      entryPoint: ["/bin/bash", "-c"],
      command: [sourceScript],
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "sources", logGroup }),
      environment: { OM_HOST: omHost, REGION: region },
      secrets: { OM_JWT: ecs.Secret.fromSecretsManager(botSecret) },
    });
    new events.Rule(this, "SourceIngestSchedule", {
      ruleName: "bgp-om-ingest-sources",
      description: "Scheduled OpenMetadata source-DB (MySQL) reconciliation into bgp-sources",
      schedule: events.Schedule.rate(cdk.Duration.hours(6)),
      targets: [
        new targets.EcsTask({
          cluster, taskDefinition: sourceTask,
          subnetSelection: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
          securityGroups: [ingestSg], assignPublicIp: false,
        }),
      ],
    });

    // ---------------- Redshift data quality + profiler (phase A) ----------------
    // Seeds a small demo data-quality suite on bgp-redshift.dev.public.customers (idempotent),
    // then runs the TestSuite workflow (`metadata test`) to EXECUTE the tests (row/column count,
    // not-null, unique) — these are plain SELECTs and work on Redshift Serverless. The column
    // profiler (`metadata profile`) runs best-effort: Redshift Serverless blocks the STL system
    // tables OM uses for table system metrics, so column profiling is limited there; the task
    // stays green either way. Reuses the metadata connector's Redshift connection.
    const profilerScript = [
      "set -euo pipefail",
      "python3 - <<'PY'",
      "import json, os, urllib.request, urllib.error",
      "OM=os.environ['OM_HOST'].rstrip('/'); JWT=os.environ['OM_JWT']",
      "def om(method,path,body):",
      "    req=urllib.request.Request(OM+path,data=json.dumps(body).encode(),method=method,headers={'Authorization':'Bearer '+JWT,'Content-Type':'application/json'})",
      "    try:",
      "        with urllib.request.urlopen(req,timeout=30) as r: return r.status",
      "    except urllib.error.HTTPError as e: return e.code",
      "    except Exception as e: print('seed err',e); return 0",
      "FQN='bgp-redshift.dev.public.customers'; S=FQN+'.testSuite'",
      "# Demo data-quality suite (idempotent; 409 = already exists).",
      "print('suite ->',om('POST','/api/v1/dataQuality/testSuites/executable',{'name':S,'displayName':'customers quality','executableEntityReference':FQN}))",
      "for tc in [",
      "  {'name':'customers_column_count','entityLink':'<#E::table::'+FQN+'>','testSuite':S,'testDefinition':'tableColumnCountToBeBetween','parameterValues':[{'name':'minColValue','value':'1'},{'name':'maxColValue','value':'50'}]},",
      "  {'name':'customers_row_count','entityLink':'<#E::table::'+FQN+'>','testSuite':S,'testDefinition':'tableRowCountToBeBetween','parameterValues':[{'name':'minValue','value':'1'},{'name':'maxValue','value':'10000000'}]},",
      "  {'name':'customers_id_not_null','entityLink':'<#E::table::'+FQN+'::columns::id>','testSuite':S,'testDefinition':'columnValuesToBeNotNull'},",
      "  {'name':'customers_id_unique','entityLink':'<#E::table::'+FQN+'::columns::id>','testSuite':S,'testDefinition':'columnValuesToBeUnique'},",
      "]:",
      "    print('tc',tc['name'],'->',om('POST','/api/v1/dataQuality/testCases',tc))",
      "omcfg={'hostPort':OM+'/api','authProvider':'openmetadata','securityConfig':{'jwtToken':JWT}}",
      "rsconn={'type':'Redshift','hostPort':os.environ['RS_HOST']+':5439','username':os.environ['RS_USER'],'password':os.environ['RS_PASSWORD'],'database':os.environ['RS_DB'],'sslMode':'require'}",
      "open('/tmp/test.yaml','w').write(json.dumps({'source':{'type':'TestSuite','serviceName':'bgp-redshift','sourceConfig':{'config':{'type':'TestSuite','entityFullyQualifiedName':FQN}}},'processor':{'type':'orm-test-runner','config':{}},'sink':{'type':'metadata-rest','config':{}},'workflowConfig':{'openMetadataServerConfig':omcfg}}))",
      "open('/tmp/profiler.yaml','w').write(json.dumps({'source':{'type':'redshift','serviceName':'bgp-redshift','serviceConnection':{'config':rsconn},'sourceConfig':{'config':{'type':'Profiler','computeMetrics':True}}},'processor':{'type':'orm-profiler','config':{}},'sink':{'type':'metadata-rest','config':{}},'workflowConfig':{'openMetadataServerConfig':omcfg}}))",
      "print('configs written')",
      "PY",
      "echo '=== data quality: metadata test ==='",
      "metadata test -c /tmp/test.yaml",
      "echo '=== profiler: metadata profile (best-effort) ==='",
      "metadata profile -c /tmp/profiler.yaml || echo 'profiler partial/failed (expected on Redshift Serverless: STL system tables are inaccessible)'",
    ].join("\n");
    const profilerTask = new ecs.FargateTaskDefinition(this, "ProfilerIngestTask", {
      cpu: 512, memoryLimitMiB: 2048,
    });
    profilerTask.addContainer("ingest", {
      image,
      entryPoint: ["/bin/bash", "-c"],
      command: [profilerScript],
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "profiler", logGroup }),
      environment: { OM_HOST: omHost, RS_HOST: rsHost, RS_DB: "dev", RS_USER: "admin" },
      secrets: {
        OM_JWT: ecs.Secret.fromSecretsManager(botSecret),
        RS_PASSWORD: ecs.Secret.fromSecretsManager(rsSecret, "password"),
      },
    });
    new events.Rule(this, "ProfilerIngestSchedule", {
      ruleName: "bgp-om-ingest-profiler",
      description: "Scheduled OpenMetadata Redshift profiler + data-quality tests",
      schedule: events.Schedule.rate(cdk.Duration.hours(24)),
      targets: [
        new targets.EcsTask({
          cluster, taskDefinition: profilerTask,
          subnetSelection: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
          securityGroups: [ingestSg], assignPublicIp: false,
        }),
      ],
    });

    new cdk.CfnOutput(this, "IngestClusterName", { value: cluster.clusterName });
    new cdk.CfnOutput(this, "IngestSgId", { value: ingestSg.securityGroupId });
    new cdk.CfnOutput(this, "RedshiftTaskDefArn", { value: redshiftTask.taskDefinitionArn });
    new cdk.CfnOutput(this, "SourceTaskDefArn", { value: sourceTask.taskDefinitionArn });
    new cdk.CfnOutput(this, "ProfilerTaskDefArn", { value: profilerTask.taskDefinitionArn });
  }
}
