// @kf-batch 50-WP16-zero-egress
// 执行环境私有子网类型的**唯一真值**(50 SPEC §3.16-A 不变量 2)。
//
// 【为什么要单独一个模块】
//   WP-16 把执行环境底座从 `PRIVATE_WITH_EGRESS`(带 NAT 出网)改成 `PRIVATE_ISOLATED`(零出网)。
//   这个类型此前散在 **5 个**栈里各写一遍(base / core / redshift / mwaa / dms),而 CDK 的
//   `selectSubnets({subnetType})` 在**选不中时返回空集、不报错** ⇒ 漏改一处的症状是
//   「Output 变空串 / subnetIds 传空数组」,报错点离根因极远(实测:core 栈直接 synth 失败,
//   而 mwaa / dms 那种传 `subnetIds: []` 的会一路到部署时才炸)。
//   ⇒ 收成一处,并由 synth 门禁禁止 `infra/lib/exec-env/**` 里再出现 `PRIVATE_WITH_EGRESS`。
import * as ec2 from "aws-cdk-lib/aws-ec2";

/** 🔴 执行环境的私有子网 = **完全隔离**(无 NAT、无 IGW、路由表无 0.0.0.0/0)。 */
export const EXEC_ENV_PRIVATE_SUBNET_TYPE = ec2.SubnetType.PRIVATE_ISOLATED;

/** 取该 VPC 的执行环境私有子网(唯一选择点)。 */
export function execEnvPrivateSubnets(vpc: ec2.IVpc): ec2.SelectedSubnets {
  return vpc.selectSubnets({ subnetType: EXEC_ENV_PRIVATE_SUBNET_TYPE });
}

/** 供各栈直接传给 L2 的 `vpcSubnets` / `subnets`。 */
export const EXEC_ENV_PRIVATE_SUBNET_SELECTION: ec2.SubnetSelection = {
  subnetType: EXEC_ENV_PRIVATE_SUBNET_TYPE,
};
