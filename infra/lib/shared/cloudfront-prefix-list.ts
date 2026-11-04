// 50-PROD-A-launch-hardening(h)
// CloudFront **origin-facing 托管前缀列表 id** 的单一作者。
//
// 【为什么单独一个文件】这个 id 原来**抄了两份**(`platform-stack.ts` 与 `om-service-stack.ts`),
// 而且两处的失败语义**不一样**(om-service 那处查不到就静默跳过 ⇒ OM 的 ALB 悄悄少一条入站规则,
// 页面从 CloudFront 打不开而部署一路绿灯)⇒ 收成一处、一种失败语义(fail-loud)。
//
// 【🔴 2026-10-09 改为部署期按名查(生产上线批次 A · h)】
//   原来是一张**只有 3 个区**的硬编码表(us-east-1 / us-east-2 / us-west-2)⇒ 客户把主控区选在
//   任何别的区,synth 当场抛错。用户原话:主控区「让客户自己选择部署的区域」、
//   「根据账号里面所有可用区域」,不许只认几个写死的区。
//   ⇒ 由 CloudFormation 自定义资源在**部署时**调 `ec2:DescribeManagedPrefixLists`
//   (按名字 `com.amazonaws.global.cloudfront.origin-facing` 过滤)取**本区**的真值:
//     · 账号真值、任何区都成立,没有表要维护;
//     · synth 不做 context 查找(synth-gate 钉着「synth 结果不绑定某个账号 / 时刻」那条照旧成立);
//     · 查不到 ⇒ 自定义资源取不到 `PrefixLists.0.PrefixListId` ⇒ **该栈部署失败**(fail-loud,
//       绝不悄悄少一条入站规则)。
import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as cr from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";

export const CLOUDFRONT_ORIGIN_FACING_PL_NAME = "com.amazonaws.global.cloudfront.origin-facing";
const LOOKUP_ID = "CfOriginFacingPrefixListLookup";

/**
 * 取**本栈所在区**的 CloudFront origin-facing 前缀列表 id(部署期解析的 token)。
 * 同一个栈里多次调用复用同一个查找资源。
 */
export function cloudfrontOriginFacingPrefixList(scope: Construct): string {
  const stack = cdk.Stack.of(scope);
  const lookup =
    (stack.node.tryFindChild(LOOKUP_ID) as cr.AwsCustomResource | undefined) ??
    new cr.AwsCustomResource(stack, LOOKUP_ID, {
      // onUpdate 同时覆盖 Create(AwsCustomResource 的约定);物理 id 固定 ⇒ 重查不会替换资源
      onUpdate: {
        service: "EC2",
        action: "describeManagedPrefixLists",
        parameters: { Filters: [{ Name: "prefix-list-name", Values: [CLOUDFRONT_ORIGIN_FACING_PL_NAME] }] },
        physicalResourceId: cr.PhysicalResourceId.of("cf-origin-facing-prefix-list"),
        outputPaths: ["PrefixLists.0.PrefixListId"],
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({ actions: ["ec2:DescribeManagedPrefixLists"], resources: ["*"] }),
      ]),
      installLatestAwsSdk: false,
    });
  return lookup.getResponseField("PrefixLists.0.PrefixListId");
}
