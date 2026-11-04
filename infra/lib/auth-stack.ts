import * as cdk from "aws-cdk-lib";
import { resolveDeployMode, rosterForMode } from "./shared/deploy-mode";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as path from "path";
import { Construct } from "constructs";

/**
 * 初始名册(用户名 → RBAC 组;空串 = 不入组的业务 viewer)。
 *
 * 🔴 **必须与 `scripts/10-bootstrap-cognito.sh` 完全一致** —— 它是同一份合同的两侧:
 * 脚本负责生成口令并挑路径(直连 / 回落 invoke),本文件负责把名册**写死进函数**,
 * 使得调用方**只能提供口令、不能指定"谁进哪个组"**(否则 invoke 权限 = 造管理员权限,
 * 见 `infra/lambda/cognito-bootstrap/index.py` 文件头「收窄①」)。
 * 两侧漂移的后果是"脚本要建的人建不出来",不是静默错授权 —— 但仍应同批改。
 */
const BOOTSTRAP_ROSTER: Record<string, string> = {
  admin: "bgp-admin",
  "pm-tester": "bgp-manager",
  "rbac-tester": "bgp-developer",
  "ops-analyst": "bgp-analyst",
  "biz-tester": "",
};

export class AuthStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool;
  public readonly client: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    // 🔴 生产上线批次 A:生产模式只引导 admin(其余四个是测试账号);名单规则唯一作者 = shared/deploy-mode。
    const roster = rosterForMode(BOOTSTRAP_ROSTER, resolveDeployMode(this.node.tryGetContext("deploy-mode")));

    this.userPool = new cognito.UserPool(this, "BgpUserPool", {
      userPoolName: "bgp-user-pool",
      selfSignUpEnabled: false,
      signInAliases: { username: true, email: true },
      // (WS4b-1): 强化密码策略(min12 + 大小写 + 数字 + 符号)。仅对【新设】密码生效,
      // 不影响现有用户登录(故零功能风险)。MFA + 禁 USER_PASSWORD_AUTH 属 WS4b-2(会断无头
      // 登录,需先改造测试登录流),此处不动 authFlows。
      passwordPolicy: {
        minLength: 12,
        requireDigits: true,
        requireLowercase: true,
        requireUppercase: true,
        requireSymbols: true,
      },
      // WS3/WS4b: 用户池保留(原 DESTROY 会随 cdk destroy 丢失所有账号)。
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.client = this.userPool.addClient("BgpWebClient", {
      // userPassword 暂留(WS4b-2 再关并改走 SRP);SRP 已启用。
      authFlows: { userPassword: true, userSrp: true },
      preventUserExistenceErrors: true,
    });

    new cdk.CfnOutput(this, "UserPoolId", { value: this.userPool.userPoolId });
    new cdk.CfnOutput(this, "ClientId", { value: this.client.userPoolClientId });

    // ── 受限账号引导通道(2026-08-31 根治「平台在受限账号里装不上」)───────────────
    //
    // 问题:平台的 4 个 RBAC 组 + 5 个初始用户由 `scripts/10-bootstrap-cognito.sh` **直连**
    // Cognito 建。但临时/共用账号(WSParticipantRole、Event Engine 之类)常把
    // `cognito-idp:Admin*` 整片裁掉 ⇒ 基础设施装得上、**一个能登录的用户都没有**。
    // 2026-08-29 在一个 workshop 账号实测栽在这里。
    //
    // 根因不是"某个 API 报错",而是:**平台把"建组建号"压在【调用者的 IAM 权限】上,
    // 而不是压在【部署角色 / 由 AWS 服务代跑】上。** 所以正解是给出一条"由服务代跑"的通道:
    // 本函数由 CDK 创建、**自带**所需 Cognito 写权限;脚本直连被拒时改为 invoke 它。
    //
    // 为什么不用 CFN 自定义资源(部署时自动跑):那样口令必须在部署时可得 ⇒ 会进模板/参数/事件。
    // 现方案让**口令由调用侧生成、只走 invoke payload**,不落模板、不进日志、不落函数环境变量。
    //
    // 🔴 提权面已在函数侧做三道收窄(名册写死 / 已 CONFIRMED 不改口令 / 重置需改环境变量),
    //    详见 `infra/lambda/cognito-bootstrap/index.py` 文件头。生产环境若要彻底不留这个函数:
    //    `-c cognitoBootstrapFn=0`(则回到纯直连路径,受限账号将装不上)。
    if (this.node.tryGetContext("cognitoBootstrapFn") !== "0") {
      const bootstrapFn = new lambda.Function(this, "CognitoBootstrapFn", {
        functionName: "bgp-cognito-bootstrap",
        // 选 python + boto3:boto3 在 python 运行时是**保证自带**的;Node 运行时自带 AWS SDK v3
        // 这件事 AWS 正在收回(新运行时建议自行打包)。引导通道的可靠性优先于与仓内 Node
        // Lambda 的风格统一 —— 它恰恰是"别的路都走不通时"才被调用的那条路。
        runtime: lambda.Runtime.PYTHON_3_12,
        architecture: lambda.Architecture.ARM_64,
        handler: "index.handler",
        // 🔴 排除 __pycache__:离线替身(infra/test/cognito-bootstrap)跑一次就会在函数目录里生成它,
        //    带进资产会让**同一份代码在不同机器上算出不同哈希**(部署时凭空多一次更新)。
        code: lambda.Code.fromAsset(path.join(__dirname, "..", "lambda", "cognito-bootstrap"), {
          exclude: ["__pycache__", "*.pyc"],
        }),
        timeout: cdk.Duration.seconds(60),
        memorySize: 256,
        environment: {
          USER_POOL_ID: this.userPool.userPoolId,
          ROSTER_JSON: JSON.stringify(roster),
          // 置 1 才允许对已 CONFIRMED 的用户重置口令。改它需要 CFN/CDK 权限(≈管理员),
          // 而不是只有 lambda:InvokeFunction —— 这就是"重置"与"引导"的权限边界。
          BOOTSTRAP_ALLOW_RESET: "0",
        },
      });
      // 只授这 5 个动作、且**只对本 user pool**。不用 grant* 便利方法,免得放宽到全账号。
      bootstrapFn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: [
            "cognito-idp:CreateGroup",
            "cognito-idp:AdminCreateUser",
            "cognito-idp:AdminSetUserPassword",
            "cognito-idp:AdminAddUserToGroup",
            "cognito-idp:AdminGetUser",
          ],
          resources: [this.userPool.userPoolArn],
        })
      );
      new cdk.CfnOutput(this, "CognitoBootstrapFnName", { value: bootstrapFn.functionName });

      // ── 路径C:部署期自愈(2026-09-17)──────────────────────────────────────
      //
      // 上面那条路(路径B)还是压在**操作者**身上:它要 `lambda:InvokeFunction`。实测有账号连这个
      // 都没有(某空账号的 IAM 用户 `cognito-idp:*` / `lambda:*` / `secretsmanager:*` / `codebuild:*`
      // 全拒,只剩 `cloudformation` / `s3` / `dynamodb` / `ssm`)⇒ 栈全装好、**一个能登录的用户都没有**。
      // 这就是 2026-08-29 那个病的**同一种**:「建组建号」不能压在操作者的 IAM 权限上。
      //
      // ⇒ 打开 `-c bootstrapUsers=1` 时,由 **CloudFormation**(部署角色 ≈ 管理员)在部署期调本函数。
      //   口令不进模板、不进 CFN 参数、不进自定义资源属性:走一个 SSM SecureString 参数,
      //   函数读完**自己删掉**(见 lambda 文件头「路径C」那段:当年反对 CFN 自定义资源的三条理由
      //   已逐条消掉)。
      // 🔴 没有静默默认值:开了这个开关而参数不存在 ⇒ 自定义资源**响亮失败**(栈回滚),
      //   不会「装完了但没有用户」——那正是这次要根治的病。
      if (this.node.tryGetContext("bootstrapUsers") === "1") {
        const pwParam = String(this.node.tryGetContext("bootstrapPwParam") || "/bgp/bootstrap-passwords");
        bootstrapFn.addToRolePolicy(
          new iam.PolicyStatement({
            actions: ["ssm:GetParameter", "ssm:DeleteParameter"],
            resources: [
              cdk.Stack.of(this).formatArn({
                service: "ssm",
                resource: "parameter",
                resourceName: pwParam.replace(/^\//, ""),
                arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
              }),
            ],
          })
        );
        // SecureString 用 AWS 托管键 `alias/aws/ssm`:托管键不能改键策略,只能靠身份策略 + ViaService 收窄。
        bootstrapFn.addToRolePolicy(
          new iam.PolicyStatement({
            actions: ["kms:Decrypt"],
            resources: ["*"],
            conditions: { StringEquals: { "kms:ViaService": `ssm.${cdk.Stack.of(this).region}.amazonaws.com` } },
          })
        );
        const run = new cdk.CustomResource(this, "CognitoBootstrapRun", {
          serviceToken: bootstrapFn.functionArn,
          properties: {
            PasswordsSsmParameter: pwParam,
            // 名册变了要重跑一次(否则新增用户永远建不出来):把名册本身当版本。
            RosterVersion: JSON.stringify(roster),
          },
        });
        new cdk.CfnOutput(this, "CognitoBootstrapRunUsers", { value: run.getAttString("users") });
        new cdk.CfnOutput(this, "CognitoBootstrapPwParamDeleted", {
          value: run.getAttString("passwordParamDeleted"),
        });
      }
    } else if (this.node.tryGetContext("bootstrapUsers") === "1") {
      // 🔴 两个开关互相矛盾时**当场炸**,不许静默降级成「什么都没建」。
      throw new Error(
        "-c bootstrapUsers=1 需要引导函数,但同时给了 -c cognitoBootstrapFn=0 —— 二者矛盾:" +
          "要部署期自愈就不能不建那个函数(去掉 cognitoBootstrapFn=0)。"
      );
    }
  }
}
