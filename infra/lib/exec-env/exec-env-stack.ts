// 执行环境栈的**公共基类**:唯一职责是让整个栈组的 `cdk synth` **零 context 查找**。
//
// 【为什么需要它 —— 实测踩出来的】
//   目标:§4.1a-5 要求"编译级验收先行:栈组 synth 出正确 region 且零引用控制面构造",且是 **CI 门禁级**。
//   CI 里不会有(也不该有)目标账号的凭证 ⇒ **synth 必须能在零凭证下跑通**。
//
//   第一版用 `ec2.Vpc({ maxAzs: 2 })` ⇒ CDK 触发 `availability-zones` context provider,
//   要**对目标账号 AssumeRole 去查 AZ**。实测报错里带着**本机 AWS 账号号** ——
//   synth 一个"别的账号的栈"竟然会碰本机凭证,这既让门禁没法离线跑,也是不该有的耦合。
//
//   第二版改成 `ec2.Vpc({ availabilityZones: [...] })`,**仍然不行**:CDK 会校验
//   "给的 AZ 必须是 `stack.availabilityZones` 的子集"(`aws-ec2/lib/vpc.js`),
//   而读那个 getter 本身就会请求 provider ⇒ manifest 里照样留下 `missing: availability-zones`。
//
//   ⇒ 定案:**覆写 `Stack.availabilityZones`**(CDK 官方支持的做法),让它返回我们显式给的 AZ 名。
//     于是子集校验拿到的就是同一份列表、通过,且**全程不问 provider**。
//
// 🔴 代价与配套(必须一起做,否则只是把风险从 synth 推到 CFN):AZ 名 `<region>a/b` 在绝大多数 region
//    存在,但 **AZ 可用性是账号级的**(个别账号在某 region 缺某 AZ 或需 opt-in)。
//    ⇒ 部署前必须 preflight `aws ec2 describe-availability-zones` 校验,不可用就报错并提示
//      `-c exec-env-azs=` 换 —— 该 preflight 归 **切片 b** 的 buildspec。
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import type { ExecEnvContext } from "./context";

export interface ExecEnvStackProps extends cdk.StackProps {
  ctx: ExecEnvContext;
}

export abstract class ExecEnvStack extends cdk.Stack {
  /** 显式 AZ 名。**必须在 `super()` 之后、任何构造创建之前**赋值(getter 依赖它)。 */
  private readonly explicitAzs: string[];

  protected constructor(scope: Construct, id: string, props: ExecEnvStackProps) {
    super(scope, id, props);
    this.explicitAzs = props.ctx.azs;
  }

  /**
   * 覆写:不问 `availability-zones` context provider,直接返回入参给的 AZ 名。
   * 🔴 空数组会让 `ec2.Vpc` 静默建出零子网的 VPC,故这里 fail-closed。
   */
  public get availabilityZones(): string[] {
    if (!this.explicitAzs || this.explicitAzs.length === 0) {
      throw new Error(
        `执行环境栈 ${this.stackName} 的 AZ 列表为空 —— 覆写的 availabilityZones 在 explicitAzs 赋值前被读了(构造顺序错)`
      );
    }
    return this.explicitAzs;
  }
}
