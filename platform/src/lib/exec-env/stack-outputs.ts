// (v2 @ 50--add-components:组件驱动)
// 执行环境栈组的 **CFN Outputs 读取**(finalizeTargetResources 的取数层)。
//
// 【为什么是独立模块 + 顶层 import,而不是在 registry.ts 里动态 import】
// 🔴 实测教训(切片 e):registry 里 `await import("@aws-sdk/client-cloudformation")` 的写法,
// 测试文件的 `vi.mock("@aws-sdk/client-cloudformation")` **没有拦住**(--no-cache 复现),
// 单测直接拿**本机凭证**对真 AWS 发出了 DescribeStacks(只读,但已是"不碰本机 AWS"红线的擦边)。
// ⇒ 一律改**顶层 import**(deploy-control.test.ts 已证明顶层 import 的 vi.mock 可靠),
//   并把取数收进本模块 —— registry 的测试 mock 本模块(@/ 别名 mock 同样已证可靠),零涉网。
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { SecretsManagerClient, DescribeSecretCommand } from "@aws-sdk/client-secrets-manager";
import { toTargetSlug } from "@/lib/exec-env/target-id";
import { OPTIONAL_IMPLEMENTED_COMPONENTS } from "@/lib/exec-env/implemented-components";
// 散建收口到唯一工厂(数据面凭证注入点只有这一处)
import { sdkClient } from "@/lib/aws/clients";

export interface ExecEnvStackOutputs {
  base: Record<string, string>;
  core: Record<string, string>;
  /**
   * 可选组件栈的 Outputs:**读到才有键**(读不到 = 该组件没装,不是错误)。
   * 键 = 组件名(`redshift`/`dms`/`flink`),值 = 该栈的 OutputKey→OutputValue。
   */
  components: Record<string, Record<string, string>>;
}

async function readOne(cfn: CloudFormationClient, stackName: string, region: string): Promise<Record<string, string>> {
  let out;
  try {
    out = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  } catch (e) {
    throw new Error(
      `读不到栈 ${stackName}(region=${region}):${String((e as Error)?.message ?? e)} —— ` +
        `部署未完成或未部署,先 deploy 再回写(§12.7:以 DescribeStacks 探真实资源为权威 SSOT)`
    );
  }
  const outputs: Record<string, string> = {};
  for (const o of out.Stacks?.[0]?.Outputs ?? []) {
    if (o.OutputKey && typeof o.OutputValue === "string") outputs[o.OutputKey] = o.OutputValue;
  }
  return outputs;
}

/**
 * 读一个**可选**组件栈:栈不存在 ⇒ `null`(没装);其它错误 ⇒ **抛**。
 *
 * 🔴 为什么"其它错误必须抛"而不是也当没装:`components` 是按本函数结果**回写**的(observed 语义),
 *    把一次瞬态 `AccessDenied` 当成"没装",就会把注册表里**本来装着**的组件悄悄抹掉 ——
 *    随后探活也不再检查它 = 用一次网络抖动换来永久的假象。宁可整轮 finalize 失败(一个字节都不写)。
 */
async function readOptional(
  cfn: CloudFormationClient,
  stackName: string,
  region: string
): Promise<Record<string, string> | null> {
  try {
    const out = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
    const outputs: Record<string, string> = {};
    for (const o of out.Stacks?.[0]?.Outputs ?? []) {
      if (o.OutputKey && typeof o.OutputValue === "string") outputs[o.OutputKey] = o.OutputValue;
    }
    return outputs;
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (/does not exist/i.test(msg)) return null; // 该组件没装 —— 正常状态
    throw new Error(
      `探组件栈 ${stackName}(region=${region})失败:${msg} —— ` +
        `不把它当成"没装"(那会把已装组件从注册表抹掉),整轮回写中止`
    );
  }
}

/**
 * 读 base/core **必读**两栈 + 全部可选组件栈的 Outputs(OutputKey = 描述符字段名,栈组的合同)。
 * client 按目标 region 现建。
 *
 * 🔴 **刻意不接 `components` 入参**(不按注册表当前声称的组件去读):补充部署刚跑完时,注册表里
 *    还是**旧**的组件集,拿它当过滤器就永远发现不了新装的栈。observed 语义要求"去看真实世界有什么",
 *    所以这里对**每个已实现的可选组件**都探一次(finalize 是管理员触发的低频动作,3 次多余
 *    DescribeStacks 的代价换来的是"新装组件一定会被发现")。
 */
export async function readExecEnvStackOutputs(region: string, targetId: string): Promise<ExecEnvStackOutputs> {
  const slug = toTargetSlug(targetId); // slug 映射由唯一权威提供(SPEC §1.1a:禁散点 replace)
  const cfn = sdkClient("control-plane", CloudFormationClient, { region });
  const [base, core, ...optional] = await Promise.all([
    readOne(cfn, `BgpExecEnv-${slug}-base`, region),
    readOne(cfn, `BgpExecEnv-${slug}-core`, region),
    ...OPTIONAL_IMPLEMENTED_COMPONENTS.map((c) => readOptional(cfn, `BgpExecEnv-${slug}-${c}`, region)),
  ]);
  const components: Record<string, Record<string, string>> = {};
  OPTIONAL_IMPLEMENTED_COMPONENTS.forEach((c, i) => {
    const outs = optional[i];
    if (outs) components[c] = outs;
  });
  if (components.redshift) await resolveRedshiftSecretArn(components.redshift, region);
  return { base, core, components };
}

/**
 * 把 redshift 组件栈吐的 secret **名字**换成真 **ARN**(跨侧接缝收口)。
 *
 * 【为什么栈只吐名字】admin 口令走 `manageAdminPassword`,secret 由 **Redshift 服务自己创建**,
 * ARN 尾部带服务生成的 6 位随机后缀 ⇒ CFN 模板里拼不出来,而 `CfnNamespace` 的 GetAtt 属性表里
 * **没有** AdminPasswordSecretArn(硬写未文档化的 GetAtt = "synth 绿、部署 400" 那一类坑)。
 * ⇒ 栈吐 `redshiftSecretName`(命名 SSOT 预测的服务生成名),平台侧**按名 DescribeSecret** 换真 ARN。
 * 与 home 侧 `seed-home.ts` 的既有做法完全一致。
 *
 * 🔴 **fail-closed**:换不到就抛(整轮 finalize 一个字节都不写)。绝不把名字塞进
 * `resources.redshiftSecretArn` 冒充 ARN —— §3.1a 把该键列进 ARN 形态校验,塞名字要么被拒、
 * 要么(更糟)被某个只看"非空字符串"的下游当成可用凭证句柄。
 */
async function resolveRedshiftSecretArn(outs: Record<string, string>, region: string): Promise<void> {
  if (outs.redshiftSecretArn) return; // 栈将来若直接吐 ARN,这里自动让路
  const name = outs.redshiftSecretName;
  if (!name) {
    throw new Error(
      "redshift 组件栈既没吐 redshiftSecretArn 也没吐 redshiftSecretName —— 栈组合同被改动(§1.1 要求 redshift 袋含 secret)"
    );
  }
  const sm = sdkClient("control-plane", SecretsManagerClient, { region });
  let arn: string | undefined;
  try {
    const out = await sm.send(new DescribeSecretCommand({ SecretId: name }));
    arn = out.ARN;
  } catch (e) {
    throw new Error(
      `按名 DescribeSecret(${name}, region=${region})失败:${String((e as Error)?.message ?? e)} —— ` +
        `Redshift 托管 secret 要么还没生成完,要么平台缺该 region 的 secretsmanager 只读权` +
        `(平台栈的 ExecEnvRedshiftManagedSecretRead 语句 + 执行 region 列表)`
    );
  }
  if (!arn) throw new Error(`DescribeSecret(${name})没返回 ARN —— 不拿名字冒充 ARN(§1.1 要 ARN 形态)`);
  outs.redshiftSecretArn = arn;
}
