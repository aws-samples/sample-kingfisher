// @kf-batch 50-P50.2f-iam-region-list
// 平台运行时角色的 `aws:RequestedRegion` 条件 —— 从「单 region」到「region 列表」的唯一出口
// (50 DESIGN §12.1;全仓 18 处 condition 全部经此,不许再散点写)。
//
// 【为什么是 context 注入而不是读注册表】IAM 条件在 **synth 期**烘焙进模板;注册表是运行时状态。
// 「开通第二个执行环境」的流程里,更新控制面 IAM = 一次**控制面重部署**(带
// `-c execution-regions=us-east-1,us-west-2`),由运维在维护窗口执行(§12.1 的副作用:控制面
// ECS 会滚动一次)。🔴 这一步**刻意不塞进 exec-env 的 buildspec** —— 那会让 exec-env 部署角色
// 拿到控制面栈的写权,直接违背 §12.0 的部署权隔离(synth-gate 也断了 buildspec 绝不碰控制面)。
// (§12.1 原文「由 CodeBuild 一并做」与 §12.0/切片 a 门禁互撞,已按隔离优先收敛,见台账 §20.19。)
//
// 【零行为变化的保证】不传 context ⇒ 返回**裸 string**(与旧写法逐字节同形);传了且 >1 个 ⇒
// 数组(IAM 的 StringEquals 多值 = OR 语义)。⇒ 存量部署不带 context 重部署时模板零 diff。
//
// 🔴 fail-closed:region 全名逐个过形态校验;含 home 自动去重;**不接受 `*`**(§12.1:不放宽)。
import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d$/;

/**
 * 解析生效的执行 region 列表(含本栈 region,即 home)。
 * @returns 长度 1 ⇒ 裸 string(模板与旧写法逐字节同形);>1 ⇒ 去重排序后的数组。
 */
export function requestedRegionCondition(scope: Construct): string | string[] {
  const homeRegion = cdk.Stack.of(scope).region;
  // 序 48:两条输入通道,**同一处解析**(不是第二个作者)—— ① `-c execution-regions`(最高,平台栈显式传);
  //   ② 进程变量 BGP_EXECUTION_REGIONS(部署脚本 deploy-all / redeploy-platform / redeploy-agents 算好同一份清单后导出,
  //   让同一次部署里**每一条** cdk deploy —— 三个智能体栈 / EMR 栈 / 连带部署的依赖栈 —— 看到同一个值;此前这些栈从没拿到过清单,
  //   网络 / 参数顾问的技能角色因此始终只放行主控区)。两通道同一套校验;都没有 ⇒ 只 home(缺省零行为变化)。
  const ctxRaw = scope.node.tryGetContext("execution-regions");
  const raw = ctxRaw === undefined || ctxRaw === null || ctxRaw === "" ? process.env.BGP_EXECUTION_REGIONS : ctxRaw;
  if (raw === undefined || raw === null || raw === "") return homeRegion;
  if (typeof raw !== "string") {
    throw new Error(`-c execution-regions 须为逗号分隔的 region 全名串(收到 ${typeof raw})`);
  }
  const extra = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  for (const r of extra) {
    // 🔴 全名,不收缩写:缩写(usw2)→全名(us-west-2)的逆映射要维护一张枚举表 = 下一处漂移源;
    //    且 `regionAbbrev` 是单向压缩不可逆。SPEC §12.1 的示例已随本批订正为全名。
    if (r === "*") throw new Error("execution-regions 不接受 `*`(§12.1:不放宽,守最小权限)");
    if (!REGION_RE.test(r)) {
      throw new Error(`execution-regions 含非法 region:${r}(须全名,形如 us-west-2;不收缩写)`);
    }
  }
  const all = [...new Set([homeRegion, ...extra])].sort();
  return all.length === 1 ? all[0] : all;
}

// ══════════════════════════════════════════════════════════════════════════════
// @kf-batch 52-P52.5a-supply
// 🔴 **资源 ARN 的 region 段:唯一出口 + 显式轴声明**(50 DESIGN §12 bug #7/#8/#10 那一整类的根治)
//
// ── 要消掉的是哪一类 bug ────────────────────────────────────────────────────
// 同族已经犯过**三次**(DESIGN §20 原话:「这已经是同族第三次」):
//   #7  region 段写死 ⇒ 第二 region 的表桶访问不到;
//   #8  region 段写死 ⇒ 第二 region 的 Redshift 托管 secret describe 不到(**26 处**,实测已涨到 42 处);
//   #10 资源名按 `bgp-*` 约定写死 ⇒ per-target 角色 `BgpExecEnv-<slug>-*` 不在白名单里。
// 三次的共同形状:**链路每一环都对、只有 IAM 静默拒**,而且每次都要**一整轮真部署**才发现。
//
// 更隐蔽的是:要让一条语句真的跨 region 生效,必须**同时**改对两处 ——
//   ① ARN 的 region 段放成 `*`;② 语句上挂 `aws:RequestedRegion` 条件把范围收回已登记的执行 region。
// 只改①=权限过宽;只改②=ARN 仍然钉在 home,照旧被拒。**这个"必须成对"就是本文件要焊死的东西。**
//
// ── 根治手法 ────────────────────────────────────────────────────────────────
// 不再让任何语句自己拼 region 段:一律经 `regionalStatement()`,并**强制声明轴**:
//   · `axis: "home"`      ⇒ region 段 = 本栈 region(即 home),**不挂**区域条件;
//   · `axis: "execution"` ⇒ region 段 = `*`,**自动挂**区域条件(成对,拆不开)。
// 并且**两轴都必须写 `reason`** —— 50 DESIGN §20 明说门禁「刻意不判定 26 处各自该不该放开:
// 那要逐个看语义」。现在把那个语义判断从"没人记录的口头结论"变成**代码里必须写下来的一行**,
// 且由门禁断言它非空。这样"某处到底为什么还钉在 home"永远有据可查,不必再靠一轮真部署去发现。
//
// 🔴 **刻意不做的事:不顺手放开任何一条**。DESIGN §20 已定「现在给 = 授未用之权」——
// 数据面(glue/airflow/…)在 P50.3 真下推之前保持 home 轴,轴声明里写明"随 P50.3 放"。
// 本批只把 **P52.5a 真正被卡住的那一条**(per-project secret 的写)翻成 execution 轴。
// ══════════════════════════════════════════════════════════════════════════════

/**
 * 资源 ARN 的 region 轴。
 * · `home`      —— 资源只存在于 home(控制面),或数据面下推尚未做(那就写明随哪一批放开);
 * · `execution` —— 资源按执行目标分布在**已登记的执行 region** 里,必须跨 region 可达。
 */
export type RegionAxis = "home" | "execution";

export interface RegionalStatementProps {
  axis: RegionAxis;
  /**
   * 🔴 **必填,两轴都要写**:这条语句为什么是这个轴。
   * home 轴要说清"为什么不需要跨 region"(控制面单份 / 下推随哪一批);
   * execution 轴要说清"什么功能需要它跨 region"。门禁断言非空且有实质长度。
   */
  reason: string;
  actions: string[];
  /** 只写 region 段**之外**的部分;region 由 axis 决定,调用方拿不到也不该猜。 */
  resources: (region: string) => string[];
  sid?: string;
  effect?: iam.Effect;
  /** 额外条件(如 `iam:PassedToService`)。不得自带 `aws:RequestedRegion` —— 那是本函数的职责。 */
  conditions?: Record<string, Record<string, unknown>>;
}

const REQUESTED_REGION_KEY = "aws:RequestedRegion";

/**
 * 造一条 region 轴**显式**的 IAM 语句。
 *
 * 等价性保证:`axis:"home"` 的产物与旧写法(手拼 `${region}`、不挂条件)**逐字节同形**
 * ⇒ 41 处迁移后 synth 模板零 diff(本批用 `cdk synth` 前后逐字节比对坐实)。
 */
export function regionalStatement(scope: Construct, props: RegionalStatementProps): iam.PolicyStatement {
  const { axis, reason, actions, resources, sid, effect, conditions } = props;

  // 🔴 fail-closed:轴的理由不许留空、不许写"TODO"糊过去 —— 这一行是整个根治的可审计面。
  if (typeof reason !== "string" || reason.trim().length < 8) {
    throw new Error(
      `regionalStatement 必须写清 axis 的理由(reason,至少 8 个字符);收到 ${JSON.stringify(reason)}`
    );
  }
  if (/^\s*(todo|tbd|fixme|\?+)\s*$/i.test(reason)) {
    throw new Error(`regionalStatement 的 reason 不接受 TODO/TBD 占位:${JSON.stringify(reason)}`);
  }
  if (conditions?.StringEquals && REQUESTED_REGION_KEY in conditions.StringEquals) {
    throw new Error(
      `regionalStatement 的调用方不得自带 ${REQUESTED_REGION_KEY} 条件(它由 axis 决定,` +
        `自带会造成"轴声明与实际条件不一致"这种正是本函数要消掉的分叉)`
    );
  }
  // 🔴 给 Deny 语句加区域条件会**削弱**它(条件不命中 ⇒ Deny 不生效)⇒ 结构上禁止。
  if (axis === "execution" && effect === iam.Effect.DENY) {
    throw new Error("Deny 语句不得走 execution 轴:给 Deny 挂区域条件会让它在条件不命中时失效(权限反而放宽)");
  }

  const region = axis === "home" ? cdk.Stack.of(scope).region : "*";
  const merged =
    axis === "execution"
      ? {
          ...(conditions ?? {}),
          StringEquals: {
            ...(conditions?.StringEquals ?? {}),
            [REQUESTED_REGION_KEY]: requestedRegionCondition(scope),
          },
        }
      : conditions;

  return new iam.PolicyStatement({
    ...(sid ? { sid } : {}),
    ...(effect ? { effect } : {}),
    actions,
    resources: resources(region),
    ...(merged ? { conditions: merged } : {}),
  });
}
