#!/usr/bin/env node
import "source-map-support/register";
import { execFileSync } from "child_process";
import * as cdk from "aws-cdk-lib";
import { KmsStack } from "../lib/kms-stack";
import { WafStack, CLOUDFRONT_WAF_REGION } from "../lib/waf-stack";
import { modelRegionMismatch, resolveModelId } from "../lib/shared/model";
import { AuditStack } from "../lib/audit-stack";
import { VpcStack } from "../lib/vpc-stack";
import { DatabaseStack } from "../lib/database-stack";
import { FinOpsStack } from "../lib/finops-stack";
import { AuthStack } from "../lib/auth-stack";
import { RedshiftStack } from "../lib/redshift-stack";
import { RdsStack } from "../lib/rds-stack";
import { resolveDeployMode } from "../lib/shared/deploy-mode";
import { MwaaStack } from "../lib/mwaa-stack";
// @kf-batch 50-WP15-airflow-serverless:home 的 MWAA Serverless 入口(经典 MWAA 保留,两者并列)
import { AirflowServerlessStack } from "../lib/airflow-serverless-home-stack";
import { PlatformStack } from "../lib/platform-stack";
import { OmDatabaseStack } from "../lib/om-database-stack";
import { OmSearchStack } from "../lib/om-search-stack";
import { OmServiceStack } from "../lib/om-service-stack";
import { OmIngestionStack } from "../lib/om-ingestion-stack";
import { AgentCoreStack } from "../lib/agentcore-stack";
import { NetAdvisorAgentCoreStack } from "../lib/netadvisor-agentcore-stack";
import { ParamAdvisorAgentCoreStack } from "../lib/paramadvisor-agentcore-stack";
import { RealtimeStack } from "../lib/realtime-stack";
import { FlinkStack } from "../lib/flink-stack";
import { EmrStack } from "../lib/emr-stack";
// 模块 50 P50.2 —— 执行环境栈组(自洽:自建 VPC/CMK,不引用控制面构造)。
import { readExecEnvContext } from "../lib/exec-env/context";
import { homeRegionMismatch } from "../lib/shared/home-region";
import { createExecEnvStackGroup } from "../lib/exec-env/stack-group";
import { ExecEnvDeployStack } from "../lib/exec-env/deploy-stack";

const app = new cdk.App();
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION || "us-east-1" };

// ── 控制面上线加固的两道 synth 期守卫(@kf-batch 50-PROD-A-launch-hardening(h))────────────────
// 🔴 B-103(2026-10-19 客户现网真撞):这两道守卫原来写在模块顶层、排在下面 `readExecEnvContext` 分叉**之前**,
//   于是执行环境栈组的 synth 路径(页面「新建执行环境」触发的 CodeBuild,在主控区跑 `cdk bootstrap` / `cdk deploy
//   BgpExecEnv-*`)也要过它们。CodeBuild 的环境里没有 `BEDROCK_MODEL_ID`(项目定义只注入 EXEC_ENV_SOURCE_REF,broker 只注入
//   EXEC_ENV_*)⇒ `resolveModelId()` 退回出厂 `us.*` 默认 ⇒ 主控区不在美国时「默认大模型地理守卫」必抛 ⇒ 一个栈都不建。
//   执行环境栈组一处 Bedrock / 模型引用都没有(agentcore 归 EXTERNAL_COMPONENTS),这是纯误伤;三个测试账号主控区都是
//   us-east-1 恰好匹配,所以从未撞上。
// ⇒ 守卫**只在控制面分支**调用(见文件末尾的分派),执行环境分支不调。守卫本身一个字未改,控制面裸 `cdk deploy` 照旧被拒;
//   离线判据 scripts/exec-env-synth-gate.mjs §1c:非美主控区 + exec-env-target 的 synth 必过,同条件控制面 `cdk ls` 必以守卫原话失败。
// 🔴 B-134(2026-10-29 客户现网再撞):上面这一刀**不够** —— buildspec 第 3 步 `cdk bootstrap aws://…` 不带任何 -c,CDK CLI 照样执行
//   本文件 ⇒ 仍走控制面分支 ⇒ 守卫照抛。bootstrap 不需要 app,buildspec 改为 `cdk bootstrap --app ''`(唯一真正不执行本文件的形态);
//   离线判据 synth-gate §1d 真跑 buildspec 里那一行。本文件的分叉逻辑与守卫不变。
function assertControlPlaneGuards(): void {
  // CDK 解析出的区 ≠ 部署脚本要的主控区 ⇒ synth 当场拒(理由见 home-region.ts)
  {
    const bad = homeRegionMismatch(env.region, process.env.KF_HOME_REGION);
    if (bad) throw new Error(bad);
  }
  // 默认大模型与主控区地理不匹配 ⇒ synth 当场拒(别等上线后 AI 全哑火)
  {
    const bad = modelRegionMismatch(resolveModelId(), env.region);
    if (bad) throw new Error(bad);
  }
}

// ── 模块 50 P50.2:控制面 synth 主体 ───────────────────────────────────────────
// 原来这一整段是模块顶层直接执行的。P50.2 引入「执行环境栈组模式」(§4.1a-4:传 `-c exec-env-target`
// 时【只】实例化该 target 的栈组、完全不 synth 控制面)后,必须能「整段不执行」⇒ 包成函数。
// 🔴 函数体除缩进外**一个字符未改**;控制面 17 个模板与改造前逐字节相同
//    (由 scripts/exec-env-synth-gate.mjs 拿改造前的基线逐模板 diff 证明)。
function synthControlPlane(): void {
  // ── AI 接线自愈(防回归根治)──────────────────────────────────────────────────
  // 平台栈的 AI 接线(OM URL / genbi / net·param advisor 的 backend+runtime-arn+memory-id)
  // 历史上靠命令行 -c 传入、默认"关闭/空"。任何一次裸 `cdk deploy BgpPlatformStack`(忘带那
  // 一长串 -c)都会把接线【静默冲回默认空值】→ OM 页面报错、GenBI skill 不命中、顾问退回进程内,
  // 而页面不白屏,坏得无声。scripts/redeploy-platform.sh 会把"期望接线"写入 SSM /bgp/wiring/*;
  // 这里在 synth 时【实时读 SSM 补齐 -c 未提供的接线 key】,让裸部署也能自愈,不再冲空。
  //   优先级:命令行 -c(最高) > SSM 持久值 > 各栈内默认(最低)。
  //   读 SSM 失败(离线 synth / 无权限 / 参数不存在)→ 静默跳过,保持原默认行为(零回归)。
  const WIRING_KEYS = [
    "openmetadata-url",
    "genbi-backend", "genbi-runtime-arn", "genbi-memory-backend", "genbi-memory-id",
    "netadvisor-backend", "netadvisor-runtime-arn", "netadvisor-memory-backend", "netadvisor-memory-id",
    "paramadvisor-backend", "paramadvisor-runtime-arn", "paramadvisor-memory-backend", "paramadvisor-memory-id",
  ];
  // 接线自愈根治层2:读 SSM 失败时【区分正常缺失 vs 异常(无凭证/CLI故障)】。
  // 参数不存在(ParameterNotFound)=正常(首次部署尚未写入),静默走默认;
  // 其它错误(无凭证/无 AWS CLI/超时)=异常,打印告警到 stderr —— 不再"坏得无声",
  // 让"自愈本该生效却因环境问题失效"这类故障在 synth 阶段就留下诊断线索。
  function readSsm(name: string): string | undefined {
    const profileArgs = process.env.AWS_PROFILE ? ["--profile", process.env.AWS_PROFILE] : [];
    try {
      const v = execFileSync(
        "aws",
        ["ssm", "get-parameter", "--name", name, "--query", "Parameter.Value", "--output", "text",
          "--region", env.region, ...profileArgs],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 }
      ).trim();
      return v && v !== "None" ? v : undefined;
    } catch (e: any) {
      const stderr = String(e?.stderr || e?.message || "");
      // 参数不存在 = 正常(首次部署),静默;其它(凭证/CLI/超时)= 异常,告警。
      if (!/ParameterNotFound|could not be found.*parameter/i.test(stderr)) {
        const hint = /profile.*could not be found|Unable to locate credentials|NoCredential|ExpiredToken/i.test(stderr)
          ? " ← 疑似无 AWS_PROFILE/凭证:确保调用方 `export AWS_PROFILE`(见 deploy-all.sh)"
          : "";
        console.warn(`[wiring-heal] 读取 SSM ${name} 失败,本次不自愈该接线(将走默认值)。${hint}\n  ${stderr.trim().slice(0, 300)}`);
      }
      return undefined; // 读不到 → 不自愈,走默认(零回归)
    }
  }
  if (process.env.BGP_SKIP_WIRING_HEAL !== "1") {
    let healed = 0;
    for (const key of WIRING_KEYS) {
      if (app.node.tryGetContext(key) !== undefined) continue; // 命令行 -c 显式提供 → 最高优先,不覆盖
      const val = readSsm(`/bgp/wiring/${key}`);
      if (val !== undefined) { app.node.setContext(key, val); healed++; } // 用 SSM 持久值补齐,platform-stack 的 tryGetContext 自动读到
    }
    if (healed > 0) console.warn(`[wiring-heal] 从 SSM /bgp/wiring/* 自愈补齐 ${healed} 项 AI 接线(命令行 -c 未提供的部分)。`);
  }
  // ─────────────────────────────────────────────────────────────────────────────

  // 模块 27 (WS1) — 加密底座先于所有数据栈创建,把数据域 CMK 注入需静态加密的栈。
  const kms = new KmsStack(app, "BgpKmsStack", { env });

  // 模块 27 (WS4b-1) — WAF(CLOUDFRONT scope):WebACL 须先于 Platform 创建(Platform 引用其 ARN)。
  // @kf-batch 50-PROD-A-launch-hardening(h)—— 🔴 CLOUDFRONT scope 的 WebACL **只能建在 us-east-1**(AWS 规则),
  //   与主控区在哪无关。原来它跟着 `env`(= 主控区)⇒ 客户把主控区选在别的区,WAF 栈直接建失败。
  //   ⇒ 固定 us-east-1,ARN 经 CDK 跨区引用交给主控区的 OM / 平台栈(主控区就是 us-east-1 时仍是普通引用)。
  const wafEnv = { account: env.account, region: CLOUDFRONT_WAF_REGION };
  const crossRegion = env.region !== CLOUDFRONT_WAF_REGION;
  const waf = new WafStack(app, "BgpWafStack", { env: wafEnv, crossRegionReferences: crossRegion });

  const vpc = new VpcStack(app, "BgpVpcStack", { env });
  new DatabaseStack(app, "BgpDatabaseStack", { env, dataKey: kms.dataKey });
  // 模块 40 — FinOps 独立栈(3 张按需表,零常驻计费,默认安装;隔离靠独立栈本身)。
  new FinOpsStack(app, "BgpFinOpsStack", { env, dataKey: kms.dataKey });
  const auth = new AuthStack(app, "BgpAuthStack", { env });
  new RedshiftStack(app, "BgpRedshiftStack", { env, vpc: vpc.vpc, dataKey: kms.dataKey });
  // 🔴 生产上线批次 A:演示源库(常驻计费的 Multi-AZ MySQL + 造数的对象)只在**显式** demo 模式部署;
  //   缺省 = production(规则唯一作者 lib/shared/deploy-mode.ts)。没有别的栈依赖它(只有 IAM 名字模式)。
  if (resolveDeployMode(app.node.tryGetContext("deploy-mode")) === "demo") {
    new RdsStack(app, "BgpRdsStack", { env, vpc: vpc.vpc, dataKey: kms.dataKey });
  }

  // OpenMetadata stacks (deployed before Platform so URL is available)
  const omDb = new OmDatabaseStack(app, "BgpOmDatabaseStack", { env, vpc: vpc.vpc, dataKey: kms.dataKey });
  const omSearch = new OmSearchStack(app, "BgpOmSearchStack", { env, vpc: vpc.vpc, dataKey: kms.dataKey });
  new OmServiceStack(app, "BgpOmServiceStack", {
    env, crossRegionReferences: crossRegion, vpc: vpc.vpc, db: omDb.db, searchEndpoint: omSearch.domain.domainEndpoint,
    webAclArn: waf.omWebAclArn, // 🔴 生产上线批次 A:OM 原来没有 WAF
  });

  // OpenMetadata URL is injected via context to avoid a hard cross-stack dependency.
  // The heavy / optional OpenMetadata service must not be able to block the core
  // platform deployment. Once BgpOmServiceStack is up, wire the iframe with:
  //   cdk deploy BgpPlatformStack -c openmetadata-url=http://<om-alb-dns>
  const openMetadataUrl = (app.node.tryGetContext("openmetadata-url") as string) || "";

  const platform = new PlatformStack(app, "BgpPlatformStack", {
    env,
    crossRegionReferences: crossRegion, // h:WAF 固定在 us-east-1
    vpc: vpc.vpc,
    cognitoUserPoolId: auth.userPool.userPoolId,
    cognitoClientId: auth.client.userPoolClientId,
    openMetadataUrl,
    dataKey: kms.dataKey, // WS1: TaskRole 需用此 key 解密 DynamoDB 加密表
    webAclArn: waf.webAclArn, // WS4b-1: CloudFront 前置 WAF
  });
  // @kf-batch 50-WP20-retire-classic-mwaa
  // 🔴🔴 **经典 MWAA 默认不再部署**(用户 2026-09-14:「把 MWAA 的部署版本去掉了…都走 MWAA Serverless,
  //    因为部署非常高效,用法也差不多一样的」)。理由:经典 MWAA 是**常驻**环境(≈$350/月、建栈 ~30 min),
  //    而 serverless 按任务秒计费、建栈分钟级、平台侧调度语义已由 WP-17 统一。
  // 🔴 **栈类还留着**,只是不再默认实例化 —— 存量账号里已经建出来的那一个仍要能被 CFN 认领与删除;
  //    把类删掉会让存量环境的栈变成孤儿(与组件 `RETIRED` 而非从全集删掉是同一条纪律)。
  // 需要它时:`cdk deploy BgpMwaaStack -c classic-mwaa=1`(deploy-all 走 `DEPLOY_CLASSIC_MWAA=1`)。
  if (app.node.tryGetContext("classic-mwaa") === "1") {
    new MwaaStack(app, "BgpMwaaStack", {
      env,
      vpc: vpc.vpc,
      dagBucketArn: platform.dagBucket.bucketArn,
      albSecurityGroup: platform.albSecurityGroup,
      dataKey: kms.dataKey, // WS1: MwaaRole 回写 bgp-* 加密表需解密权限
    });
  }
  // @kf-batch 50-WP15-airflow-serverless —— 用户拍板:新增 serverless 入口,home 是两区验收之一;分钟级栈(桶 + SG + 角色),无环境可建。
  new AirflowServerlessStack(app, "BgpAirflowServerlessStack", { env, vpc: vpc.vpc, dataKey: kms.dataKey });

  // 模块 26 — GenBI on AgentCore 基建（独立栈，不阻塞核心）：ECR + 技能 Lambda + Gateway + GatewayTarget
  // (+ 门控 Runtime)。Runtime 需先推镜像，故第二次部署带 -c genbi-runtime=1 才创建。
  // WS1: 技能 Lambda 读 bgp-genbi-* 加密表需解密权限。
  new AgentCoreStack(app, "BgpAgentCoreStack", { env, dataKey: kms.dataKey, openMetadataUrl });

  // 模块 28 — 网络连通性顾问 on AgentCore(平台标准首个样板)：ECR + 技能 Lambda(esbuild 单源) +
  // Gateway + GatewayTarget + 托管 Memory + 三角色(+ 门控 Runtime)。同 GenBI 两遍部署，第二遍带
  // -c netadvisor-runtime=1 才创建 Runtime。dataKey：技能 Lambda 读 CMK 加密的 bgp-datasources 需解密。
  new NetAdvisorAgentCoreStack(app, "BgpNetAdvisorAgentCoreStack", { env, dataKey: kms.dataKey });

  // 参数辅助顾问 on AgentCore(平台标准第二个实现,照抄网络顾问样板):ECR + 技能 Lambda(esbuild 单源) +
  // Gateway + GatewayTarget + 托管 Memory + 三角色(+ 门控 Runtime)。两遍部署,第二遍带
  // -c paramadvisor-runtime=1 才创建 Runtime。技能只读 Glue/MSAF/DMS 运行历史,无需 dataKey。
  new ParamAdvisorAgentCoreStack(app, "BgpParamAdvisorAgentCoreStack", { env });

  // 模块 27 (WS4b-1) — 审计底座(独立栈):CloudTrail 管理事件 + VPC Flow Logs(均 logs CMK 加密)。
  // CloudTrail 受 -c skip-cloudtrail=1 开关(workshop 账号可能 SCP 禁建)。
  new AuditStack(app, "BgpAuditStack", { env, vpc: vpc.vpc, logsKey: kms.logsKey, vpcImported: vpc.imported });

  // 模块 31 (R2) — 实时数据集成基建(DMS + Kinesis)。**门控创建**:仅 -c enable-realtime=1 时实例化
  // (实时组件常驻计费;不需要时零成本)。验证后 `cdk destroy BgpRealtimeStack` 销毁。
  if (app.node.tryGetContext("enable-realtime") === "1") {
    new RealtimeStack(app, "BgpRealtimeStack", { env, vpc: vpc.vpc, dataKey: kms.dataKey });
  }

  // 模块 32 (实时计算 Flink) — MSAF 引擎门控基建(源 Kinesis 流 + MSAF 服务角色)。**门控创建**:
  // 仅 -c enable-flink=1 时实例化(MSAF KPU / Kinesis shard 常驻计费;不需要时零成本)。
  // 验证后 `cdk destroy BgpFlinkStack -c enable-flink=1` 销毁。Flink 应用本身由后端按需创建/删除。
  if (app.node.tryGetContext("enable-flink") === "1") {
    new FlinkStack(app, "BgpFlinkStack", { env, dataKey: kms.dataKey });
  }

  // 模块 33-A (离线多引擎 EMR Serverless) — 门控「共享底座」栈(执行角色 + 默认 SG)。**门控创建**:
  // 仅 -c enable-emr=1 时实例化。EMR Serverless application 由后端按作业动态 Create/Delete(拍板④⑤:
  // per-作业独立 application,不共享),故本栈无常驻计费资源。接 vpc(application networkConfiguration
  // 需子网+SG)+ dataKey(桶/流 CMK 解密)。
  if (app.node.tryGetContext("enable-emr") === "1") {
    new EmrStack(app, "BgpEmrStack", { env, vpc: vpc.vpc, dataKey: kms.dataKey });
  }

  // 模块 50 P50.2 切片 b — 执行环境**部署机制**栈(home 单份):exec-env 专用 CodeBuild 项目
  // + 窄权 broker(StartBuild 的唯一持有者)+ 源包 asset。部署强权焊在 CodeBuild 服务角色上,
  // 平台 ECS 角色连 StartBuild 都没有(§12.0)。独立栈 ⇒ 不动控制面其余栈的模板(控制面共 23 栈:17 常驻 + 6 按 context 门控)。
  new ExecEnvDeployStack(app, "BgpExecEnvDeployStack", {
    env,
    execEnvTableName: "bgp-execution-envs",
    auditTableName: "bgp-audit",
    dataKey: kms.dataKey, // 表是 CMK 加密的,broker 读表/写锁需 kms:Decrypt(切片 g 真部署撞出)
  });

  // Metadata ingestion into OpenMetadata (design module 10). Optional / independent stack:
  // it is only instantiated when its (env-specific) config context is supplied, so it never
  // blocks synth or deploy of the core stacks. Deploy with:
  //   cdk deploy BgpOmIngestionStack \
  //     -c openmetadata-url=http://<om-alb-dns> \
  //     -c om-bot-secret-arn=<arn> -c rs-admin-secret-arn=<arn>
  if (app.node.tryGetContext("om-bot-secret-arn") && app.node.tryGetContext("rs-admin-secret-arn")) {
    new OmIngestionStack(app, "BgpOmIngestionStack", { env, vpc: vpc.vpc });
  }
}

// ── 模块 50 P50.2:分派(§4.1a-4)────────────────────────────────────────────
// 传了 `-c exec-env-target=<targetId>` ⇒ 本次 synth 只产出 `BgpExecEnv-<slug>-*` 栈组,
// 控制面 23 栈(17 常驻 + 6 门控)**一个都不实例化**(也不跑上面的 SSM 接线自愈 —— 那是控制面专属)。
// 不传 ⇒ 走原路径,行为一个字节不变(`readExecEnvContext` 返回 null)。
const execEnvCtx = readExecEnvContext((k) => app.node.tryGetContext(k), process.env.CDK_DEFAULT_ACCOUNT);
if (execEnvCtx) {
  createExecEnvStackGroup(app, execEnvCtx);
} else {
  // B-103:主控区 / 默认大模型两道守卫只守控制面(执行环境栈组不用大模型、也不由部署脚本的 KF_HOME_REGION 驱动)
  assertControlPlaneGuards();
  synthControlPlane();
}
