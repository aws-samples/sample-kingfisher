// 执行环境**部署机制**栈(控制面侧、home 单份;50 DESIGN §12.0 / §12.3 / §12.5)。
//
// 【它买到的是什么 —— 用 §12.0 拍板的措辞,不夸大】
//   CodeBuild 隔离真正买到的是「**最小化常驻攻击面**」:常驻的平台 ECS 角色不再持有部署强权
//   (它连 `codebuild:StartBuild` 都没有,只有 `lambda:InvokeFunction` 到 broker),
//   平台 Web 进程被攻破也只能触发**预定义流水线**。
//   🔴 但它**不代表 account 里不存在强权**:CDK 默认 bootstrap 的 `cfn-exec-role` 挂 AdministratorAccess,
//   实际部署身份是 admin-equivalent。**不宣称「部署路径最小权限」**。
//   兜底三件套:StartBuild-only(且经 broker)+ buildspec/项目定义与部署权同级保护 + 全程 audit。
//
// 【三个"同级保护"的具体落地(§12.0 的 T3 要求,不能停在口号)】
//   ① buildspec **随 IaC 走 git**:`fromSourceFilename` 指向源包里的 `infra/buildspec/exec-env-deploy.yml`,
//      而 source 是**按内容哈希不可变的 CDK asset**(平台角色无写权)⇒ 改 buildspec 必须重部署控制面;
//   ② 项目定义只由本栈管理:平台角色**没有** `codebuild:UpdateProject`(synth-gate 逐条断);
//   ③ 平台角色只有 `lambda:InvokeFunction`(broker)+ `BatchGetBuilds` + 日志 + 目标 region 的
//      `cloudformation:Describe*`(§12.4 逐栈进度)。
//
// 🔴 源获取(§12.5 P0-H)定案 = **CDK asset 源包**(用户 2026-09-01 拍板):
//   控制面部署时把 repo 打成一个 asset(按内容哈希),buildspec 从该 S3 对象取源。
//   优点:零外部凭证(不需要 GitHub 连接)、离线可验、**"同一 commit" 由部署时刻天然锁定**。
import * as cdk from "aws-cdk-lib";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as s3assets from "aws-cdk-lib/aws-s3-assets";
import { Construct } from "constructs";
import * as path from "path";
// broker 的组件全集从这里注入(唯一真源 context.ts;validate.mjs 不再手抄)
import { EXEC_ENV_COMPONENTS, EXEC_ENV_REQUIRED_BASE_COMPONENTS } from "./context";

/** CodeBuild 项目名 / broker 函数名:控制面单份、无 target 维(已登记在 naming.json 的 notCovered)。 */
export const EXEC_ENV_PROJECT_NAME = "bgp-exec-env-deploy";
export const EXEC_ENV_BROKER_NAME = "bgp-exec-env-broker";

/**
 * 源包排除清单。
 * 🔴 只排"体积大且部署用不到"的:`.git`(94M)/`docs`(45M)/`qa-game`(440M)/各处 node_modules /
 *    cdk.out / Next 产物。**留下 `platform/*.json`** —— `infra/lib/shared/{naming,model}.ts`
 *    经 `readFileSync(__dirname/../../../platform/...)` 读它们,漏了 build 起步就炸。
 */
const SOURCE_EXCLUDE = [
  // 🔴 **必须写裸目录名**才会剪枝。实测教训:只写 `docs/**` / `**/node_modules/**` 时
  //    staged asset 是 **509MB**(node_modules / docs / qa-game 全在里面)—— CDK 的 glob
  //    排除对"只给 `dir/**`"不剪目录。写了裸名之后才降到 ~2MB。
  //    这条不靠人记住:synth-gate 断言源包体积上限 + 关键文件在位 + 禁忌目录不在。
  ".git",
  "node_modules",
  "**/node_modules",
  // 🔴 用 `cdk.out*` 通配,不是逐个列名。实测:门禁把输出写成 `infra/cdk.out.synth-gate-cp/`,
  //    而源包打的是**仓根** ⇒ asset 把自己的输出目录一层层打进去,路径无限加深、synth 直接失败。
  //    任何 `cdk.out.<后缀>` 目录都会复现,所以这里必须通配。
  "cdk.out*",
  "**/cdk.out*",
  "dist",
  "docs",
  "qa-game",
  "audit-results",
  "suggestions",
  ".claude",
  "flink-connector-modules",
  "flink-sql-runner",
  "flink-sql-runner-s3t",
  "flink-sql-runner-s3t-kafka",
  "coverage",
  "**/coverage",
  "__pycache__",
  "**/__pycache__",
  ".next",
  "**/.next",
  "core-dist",
  "**/core-dist",
  "*.log",
  "*.zip",
  "*.jar",
];

export interface ExecEnvDeployStackProps extends cdk.StackProps {
  /** 注册表表名(broker 读 target、写部署锁)。 */
  execEnvTableName: string;
  /** 审计表名(broker 留痕)。 */
  auditTableName: string;
  /**
   * 数据域 CMK(`alias/bgp-data`)。bgp-* DynamoDB 表全部用它做 CUSTOMER_MANAGED 加密
   * (database-stack.ts),而 DDB 对客户管理键的解密是**拿调用方凭证**做的(FAS)——
   * broker 的第一次 `GetItem` 就需要 `kms:Decrypt`。
   * 🔴 切片 g 真部署撞出:synth/单测全绿,StartBuild 前的 readTarget 直接 KMS AccessDenied
   * (与 app.ts:124 TaskRole 同一根因;kms-stack.ts 头注释「调用方无需 kms 权限」对 DDB 不成立)。
   */
  dataKey: kms.IKey;
}

export class ExecEnvDeployStack extends cdk.Stack {
  public readonly brokerFunctionArn: string;
  public readonly projectArn: string;

  constructor(scope: Construct, id: string, props: ExecEnvDeployStackProps) {
    super(scope, id, props);

    // ── 源包(CDK asset:按内容哈希不可变)──────────────────────────────────
    const sourceBundle = new s3assets.Asset(this, "ExecEnvSourceBundle", {
      path: path.join(__dirname, "..", "..", ".."), // repo 根
      exclude: SOURCE_EXCLUDE,
    });

    // ── CodeBuild 服务角色:部署强权焊在这里(§12.0)────────────────────────
    // 🔴 诚实登记:`cdk bootstrap` 与 `cdk deploy` 经 bootstrap 角色链落地,
    //    这条链在默认 bootstrap 下是 admin-equivalent。是否用
    //    `--cloudformation-execution-policies` 把 `cfn-exec-role` 从 Admin 收窄
    //    = **开工前决策**(§12.0),沿用默认、靠上面三件套兜底;
    //    收窄所需的"实际 API 调用集"由真部署时开 CloudTrail 采集(SPEC §6.2)。
    const buildRole = new iam.Role(this, "ExecEnvBuildRole", {
      assumedBy: new iam.ServicePrincipal("codebuild.amazonaws.com"),
      // 🔴 IAM Role description 只收 Latin-1(中文 400,真部署才暴露;synth 不校验)⇒ 英文,中文注释留这行
      // 语义:部署强权只在本角色;平台 ECS 角色不持有。
      description: "BGP exec-env deploy role (deployment privileges live ONLY here; platform ECS role has none)",
    });
    // bootstrap / deploy 都要假定目标 region 的 bootstrap 角色(§12.3)
    buildRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "AssumeCdkBootstrapRoles",
        actions: ["sts:AssumeRole"],
        resources: [`arn:${this.partition}:iam::${this.account}:role/cdk-*`],
      })
    );
    // `cdk bootstrap` 自己要建/改 bootstrap 栈(CFN + IAM + S3 + ECR + SSM)
    buildRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "CdkBootstrapAndDeploy",
        actions: [
          "cloudformation:*",
          "s3:*",
          "ecr:*",
          "ssm:GetParameter",
          "ssm:GetParameters",
          "ssm:PutParameter",
          "iam:CreateRole",
          "iam:AttachRolePolicy",
          "iam:PutRolePolicy",
          "iam:GetRole",
          "iam:GetRolePolicy",
          "iam:PassRole",
          "iam:TagRole",
          "sts:GetCallerIdentity",
        ],
        resources: ["*"],
      })
    );
    // 🔴 孤儿表桶清理(buildspec 1b)用的四个动作**一直没授权**。
    // `s3tables` 是**独立服务前缀**,不被上面的 `s3:*` 覆盖;而 buildspec 那几行写的是
    // `... 2>/dev/null || echo None` ⇒ **AccessDenied 被吞成「没有孤儿桶」** ⇒ 那个「防首次失败
    // 毒化所有重试」的清理其实从未生效(bug #6 会原样复发)。synth-gate §11d 抓出来的。
    // 窄授:只给清理真正需要的四个,不给 `s3tables:*`。
    buildRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "OrphanTableBucketCleanup",
        actions: [
          "s3tables:ListTableBuckets",
          "s3tables:ListNamespaces",
          "s3tables:ListTables",
          "s3tables:DeleteTableBucket",
        ],
        resources: ["*"],
      })
    );
    // AZ preflight(buildspec 第 1 步 + 🆕 第二层 1d)
    // 🔴 第二层 preflight(端点服务 × AZ 交集)新增三个只读调用。
    // 血的教训(2026-09-11,当天第二次犯同一类错):我加了 `aws ec2 describe-vpc-endpoint-services`
    // 却**没在同一笔提交里授权** ⇒ build 以 `exit status 254`(CLI 服务错)中止,而报错离
    // 「preflight 逻辑」很远,看起来像交集算错。同 memory manifest-gate-coverage-is-the-criterion:
    // **新增 AWS 调用必须与授权同笔落地**;并由 synth-gate §11d 把「buildspec 里每个 aws 调用都有授权」钉住。
    buildRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "AzPreflight",
        actions: [
          "ec2:DescribeAvailabilityZones",
          // 第二层:每个接口端点服务支持哪些 AZ(账号级差异,必须真查)
          "ec2:DescribeVpcEndpointServices",
          // 存量守卫:沿用现有 VPC 的 AZ ⇒ 要读它的子网(换 AZ 会替换子网,N0 判据禁止)
          "ec2:DescribeSubnets",
          // 存量守卫第二条 —— 现网 VPC 的 **CidrBlock** 不许被换
          //   (换网段 ⇒ 所有子网 CidrBlock 变化 ⇒ 子网被替换,N0-10 禁止)⇒ buildspec 要 describe-vpcs
          "ec2:DescribeVpcs",
        ],
        resources: ["*"],
      })
    );
    // 🔴 下线销毁(buildspec 3.9 → scripts/exec-env-destroy.sh)要的**托管服务**动作。
    //   删栈本身走上面的 `cloudformation:*`(CFN 用 bootstrap 的执行角色删资源);这里只给「托管服务先走」那一步:
    //   它们由平台运行期创建或带 RETAIN,占着子网 / 安全组 ⇒ 不先删,base 栈删 VPC 必卡(N-5 的血教训)。
    //   🔴 与 §11d 同一条纪律:脚本里每个 aws 调用都必须在这里有授权(synth-gate 把脚本也扫进去了)。
    //   🔴 资源只能 `*`:这些动作要先**列举**才能按「执行角色 / 子网是本 target 的」认出要删的那几个(脚本里逐个比对,
    //      别人的同区资源一律不碰);列举类动作本身不支持资源级权限。
    buildRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "DecommissionManagedServicesFirst",
        actions: [
          // Flink(Managed Service for Apache Flink;IAM 前缀 kinesisanalytics)
          "kinesisanalytics:ListApplications",
          "kinesisanalytics:DescribeApplication",
          "kinesisanalytics:StopApplication",
          "kinesisanalytics:DeleteApplication",
          // MWAA Serverless 工作流(CLI 名 mwaa-serverless,IAM 前缀 airflow-serverless)
          "airflow-serverless:ListWorkflows",
          "airflow-serverless:GetWorkflow",
          "airflow-serverless:DeleteWorkflow",
          // Glue 作业 / 连接
          "glue:GetJobs",
          "glue:DeleteJob",
          "glue:GetConnections",
          "glue:DeleteConnection",
          // EMR Serverless 应用
          "emr-serverless:ListApplications",
          "emr-serverless:GetApplication",
          "emr-serverless:StopApplication",
          "emr-serverless:DeleteApplication",
          // DMS 复制实例 / 任务(挂在本 target 复制子网组上的)
          "dms:DescribeReplicationInstances",
          "dms:DescribeReplicationTasks",
          "dms:StopReplicationTask",
          "dms:DeleteReplicationTask",
          "dms:DeleteReplicationInstance",
          // 经典 MWAA 环境(CLI 名 mwaa,IAM 前缀 airflow;存量双装目标才有)
          "airflow:GetEnvironment",
          "airflow:DeleteEnvironment",
          // Redshift Serverless:工作组 → 命名空间(带最终快照删 ⇒ 服务以调用者身份建快照,要 CreateSnapshot)
          "redshift-serverless:GetWorkgroup",
          "redshift-serverless:DeleteWorkgroup",
          "redshift-serverless:GetNamespace",
          "redshift-serverless:DeleteNamespace",
          "redshift-serverless:GetSnapshot",
          "redshift-serverless:CreateSnapshot",
          // 收尾「列出已保留的数据资源」(只读确认它们还在)
          "dynamodb:DescribeTable",
          "kms:ListAliases",
        ],
        resources: ["*"],
      })
    );
    // 🔴 「重试销毁不重复删快照」做成**结构性**的:build 角色连删快照的权限都没有(显式 Deny,任何后加的 Allow 都压不过)。
    //   最终快照 = 被删环境数仓数据的唯一留存,删它要用户指名、人工去做,平台不代决。
    buildRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "DecommissionNeverDeletesSnapshots",
        effect: iam.Effect.DENY,
        actions: ["redshift-serverless:DeleteSnapshot", "redshift:DeleteClusterSnapshot"],
        resources: ["*"],
      })
    );
    sourceBundle.grantRead(buildRole);

    // ── CodeBuild 项目 ────────────────────────────────────────────────────
    const project = new codebuild.Project(this, "ExecEnvDeployProject", {
      projectName: EXEC_ENV_PROJECT_NAME,
      description: "BGP 执行环境部署(只由 broker StartBuild;buildspec 随 IaC 走 git)",
      role: buildRole,
      timeout: cdk.Duration.hours(2), // MWAA 单栈可达 ~30min,留足
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL,
        privileged: false, // 栈组不建镜像 ⇒ 不需要 docker-in-docker
        environmentVariables: {
          // 🔴 P0-E ④(SPEC §3.5c):本次 build 用的**源包身份** = asset 的内容哈希对象键。
          //    它必须来自**项目定义**(受 §12.0 同级保护:平台角色没有 UpdateProject),
          //    而不是 broker 的 override —— 否则"我用的是哪份源"这个基线判定的输入就可被调用方左右。
          //    换 commit ⇒ asset 内容变 ⇒ 键变 ⇒ 该 target 的 baselineRef 与它不等 ⇒ 漂移必须撞审批闸。
          EXEC_ENV_SOURCE_REF: { value: sourceBundle.s3ObjectKey },
        },
      },
      source: codebuild.Source.s3({
        bucket: sourceBundle.bucket,
        path: sourceBundle.s3ObjectKey,
      }),
      // 🔴 buildspec 来自**源包里的文件**(= git 里的那一份),不是项目里 inline 的一段可改字符串。
      buildSpec: codebuild.BuildSpec.fromSourceFilename("infra/buildspec/exec-env-deploy.yml"),
    });
    this.projectArn = project.projectArn;

    // ── broker:StartBuild 的**唯一**持有者(§12.0 修法②)───────────────────
    const brokerRole = new iam.Role(this, "ExecEnvBrokerRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      // 语义:StartBuild 的独家持有者(Latin-1 限制同上)。
      description: "BGP exec-env deploy broker (sole holder of codebuild:StartBuild)",
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole")],
    });
    brokerRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "StartOnlyExecEnvProject",
        actions: ["codebuild:StartBuild"],
        resources: [project.projectArn], // 🔴 资源限定到这一个项目
      })
    );
    // 陈锁接管要核查持锁者的 build 是否已终止 —— 只读、同样限定到这一个项目。
    brokerRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "ReadOwnProjectBuildsForStaleLock",
        actions: ["codebuild:BatchGetBuilds"],
        resources: [project.projectArn],
      })
    );
    brokerRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "DeployLockAndTargetRead",
        actions: ["dynamodb:GetItem", "dynamodb:UpdateItem"],
        resources: [
          `arn:${this.partition}:dynamodb:${this.region}:${this.account}:table/${props.execEnvTableName}`,
          `arn:${this.partition}:dynamodb:${this.region}:${this.account}:table/${props.auditTableName}`,
        ],
      })
    );
    // 两张表都是 bgp-data CMK 加密(CUSTOMER_MANAGED),DDB 用**调用方凭证**做 kms:Decrypt(FAS)
    // ⇒ 没有这条,上面 DeployLockAndTargetRead 形同虚设(GetItem 直接 KMS AccessDenied)。
    // 动作集与 platform-stack.ts 的 TaskRole 授权逐字一致(最小集:读写表 + 描述键)。
    props.dataKey.grant(brokerRole, "kms:Decrypt", "kms:GenerateDataKey", "kms:DescribeKey");

    // §12.0 **修法①**(额外纵深,切片 g 收口):即使 broker 代码被攻破,带**危险 override** 的
    // StartBuild 也被 IAM 显式 Deny。键名 2026-09-01 按 AWS 权威数据核实(awspolicygen serviceMap
    // 的 CodeBuild conditionKeys;设计期刻意不凭记忆写死 —— DESIGN §12.0 的开工前核实要求)。
    //   · `Null: { key: "false" }` = 请求**带了**该字段 ⇒ Deny;正常路径(不带危险 override)零影响,
    //     若某键将来对 StartBuild 不生效,该 Deny 惰性存在也不会误伤 —— 两个方向都安全;
    //   · **逐键独立语句**:同一 condition 块内多键是 AND(合并会变成"全带才拒"= 形同虚设);
    //   · `environment.environmentVariables` **刻意不拦**:那是 broker 注入 EXEC_ENV_* 的合法参数通道。
    const DANGEROUS_OVERRIDE_KEYS = [
      "codebuild:source.buildspec", // buildspecOverride:改执行内容 = 借强权角色跑任意命令
      "codebuild:source.location", // sourceLocationOverride:换源包 = 同上
      "codebuild:serviceRole", // serviceRoleOverride:换更强的角色
      "codebuild:environment.image", // imageOverride:换恶意镜像
      "codebuild:environment.privilegedMode", // privileged 提权(项目本身 false)
    ];
    for (const key of DANGEROUS_OVERRIDE_KEYS) {
      brokerRole.addToPolicy(
        new iam.PolicyStatement({
          sid: `DenyOverride${key.replace(/[^A-Za-z0-9]/g, "")}`,
          effect: iam.Effect.DENY,
          actions: ["codebuild:StartBuild"],
          resources: [project.projectArn],
          conditions: { Null: { [key]: "false" } },
        })
      );
    }

    const broker = new lambda.Function(this, "ExecEnvBroker", {
      functionName: EXEC_ENV_BROKER_NAME,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "..", "..", "lambda", "exec-env-broker")),
      role: brokerRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      description: "执行环境部署 broker:白名单入参 + 部署锁 + fencing epoch + StartBuild(无 override)",
      environment: {
        EXEC_ENV_TABLE: props.execEnvTableName,
        EXEC_ENV_PROJECT: EXEC_ENV_PROJECT_NAME,
        AUDIT_TABLE: props.auditTableName,
        // 🔴 P0-E ④:broker 把它**转录**进 `observed.operation.sourceRef`(成功栅栏据此提升 baselineRef)。
        //    与 CodeBuild 项目级同一个值、同一份 asset ⇒ "这次部署用的哪份源"两侧一致。
        //    broker **不**把它作为 override 传给 build(那会遮蔽项目定义里的那份,见 index.mjs 注释)。
        EXEC_ENV_SOURCE_REF: sourceBundle.s3ObjectKey,
        // 组件全集 = context.ts 枚举(validate.mjs 加载期解析;缺即抛)。
        //   加组件只改 context.ts 一处 ⇒ 栈组 / broker 同步;synth-gate §7c 钉模板值 == 枚举。
        EXEC_ENV_COMPONENT_ENUM: EXEC_ENV_COMPONENTS.join(","),
        // ②:完整组件集(不提供精简形态);broker 判「下发集 ⊇ 它」
        EXEC_ENV_REQUIRED_COMPONENTS: EXEC_ENV_REQUIRED_BASE_COMPONENTS.join(","),
      },
    });
    this.brokerFunctionArn = broker.functionArn;

    new cdk.CfnOutput(this, "brokerFunctionArn", { value: broker.functionArn });
    new cdk.CfnOutput(this, "execEnvProjectArn", { value: project.projectArn });
    new cdk.CfnOutput(this, "sourceBundleS3Uri", {
      value: `s3://${sourceBundle.s3BucketName}/${sourceBundle.s3ObjectKey}`,
      description: "本次控制面部署锁定的源包(exec-env build 就从它取源;换 commit = 换哈希)",
    });
  }
}
