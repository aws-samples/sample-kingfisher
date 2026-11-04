// **"哪些组件的栈已经真的实现了"** —— 平台侧的单一事实源(SSOT)。
//
// 【为什么必须单独一个模块】这条知识本批有 4 个消费者:组件栈 Outputs 读取(stack-outputs)、
// add-components 入参校验(route)、向导的可勾选项、详情页的「补充部署」按钮。各写一份 = 4 处定义,
// 迟早漂移(change-safety A1;本仓 `targetType` 三处漂移那次的教训)。
// 🔴 本文件**零依赖**:因此服务端 route 与客户端组件都能 import,不会把 AWS SDK 拖进浏览器 bundle。
//
// 【与其它枚举的关系(别搞混三份东西)】
//   · `TARGET_COMPONENTS`(registry.ts)= SPEC §1.1 的**合法组件全集**(注册表能存什么);
//   · 本文件 = 全集里**栈组已实现**的子集(部署得出来的是哪些);
//   · `infra/lambda/exec-env-broker/validate.mjs` 的 `COMPONENTS` **不再是副本**:部署期由 deploy-stack.ts 从 context.ts 的
//     EXEC_ENV_COMPONENTS 注入 env EXEC_ENV_COMPONENT_ENUM 派生(真环境撞过副本漂移:broker 拒 airflow-serverless「未知组件」)
//     (那道边界无法共享常量,靠测试锚点钉;本文件不去 import 它)。
// 所以"合法但未实现"是一个**真实存在的状态**:注册表允许存 `mwaa`,而栈组会显式报错 ——
// 本文件就是把这条差异写成代码,让界面与 API 都按同一份判断说话。

// ②:target-id.ts 同样零依赖(客户端可 import),不破坏本文件「零依赖」的承诺
import { isHome } from "./target-id";

/** 栈组已实现的组件(含恒装的 core)。:core/redshift/dms/flink;:residency-api;:mwaa。 */
// mwaa 落地(每个 target 自己的 Airflow;SPEC v3.26 §3.14)
export const IMPLEMENTED_COMPONENTS = ["core", "redshift", "dms", "flink", "residency-api", "mwaa", "airflow-serverless"] as const;
export type ImplementedComponent = (typeof IMPLEMENTED_COMPONENTS)[number];

/**
 * 已实现且**可选**的组件(= 可以"补充部署"的清单)。
 * core 不在此列:它恒装,没有"补充"语义。
 */
export const OPTIONAL_IMPLEMENTED_COMPONENTS = ["redshift", "dms", "flink", "residency-api", "mwaa", "airflow-serverless"] as const;

/**
 * 🔴🔴 **已停止提供**的组件(用户 2026-09-11 拍板:「后面也不部署普通版本的 mwaa 了。」)。
 *
 * 与 `PENDING_COMPONENTS`(还没实现)是**两回事**,别混:
 *   · pending  = 栈组不存在 ⇒ 勾了会被显式拒;
 *   · retired  = 栈组**还在、存量环境照旧可用**,只是**不再新装**(向导不给勾、注册/补充部署带它一律拒)。
 * 🔴 为什么必须区分这两种:`mwaa` 从**合法组件全集**里删掉会连带把**存量已装的那些环境**判成非法
 *   (它们的描述符里就写着 `mwaa`)⇒ 探活 / 详情页 / 下线路径一起崩。所以类型仍认它,只是不再**提供**。
 * 收口条件 = 存量环境迁完 serverless 后另开一刀删栈(破坏性动作,用户没要求 ⇒ 现在不做)。
 */
export const RETIRED_COMPONENTS = ["mwaa"] as const;
export type RetiredComponent = (typeof RETIRED_COMPONENTS)[number];

export function isComponentRetired(component: string): component is RetiredComponent {
  return (RETIRED_COMPONENTS as readonly string[]).includes(component);
}

/** 停供组件的人话拒因(向导 / 注册 / 补充部署三处共用一份,不各写一遍)。 */
export function retiredComponentMessage(components: readonly string[]): string {
  return (
    `组件 ${components.join("、")} 已停止提供:调度与编排统一走 airflow-serverless` +
    `(按任务秒计费、零常驻;经典 MWAA 是常驻 ≈$350/月)。` +
    `已装的执行环境**照旧可用**,只是不再新装 —— 请改勾 airflow-serverless。`
  );
}

/** 可**新装**的可选组件(= 向导可勾 / 注册可带)= 已实现且未停供。 */
export const OFFERED_OPTIONAL_COMPONENTS = OPTIONAL_IMPLEMENTED_COMPONENTS.filter((c) => !isComponentRetired(c));

/**
 * 🔴🔴 **由平台自己的栈部署**的组件 —— 描述符可以如实声称它,但它**不属于 exec-env 栈组的部署面**。
 *
 * 为什么必须把这一维显式化(2026-09-14 真环境撞到):`components` 一直被当成**两件事**用 ——
 *   ① 「这个执行环境**有**哪些能力」(描述符事实);
 *   ② 「exec-env 栈组该**部署**哪些组件」(喂给 broker、再落成 `EXEC_ENV_COMPONENTS` 的那个集合)。
 * `agentcore` 正落在夹缝里:`seed-home` 探到 AgentCore Runtime 就**如实**声称它(它真的装了,由
 * `BgpAgentCoreStack` 部署),而它没有 exec-env 组件栈 ⇒ 以前挂在 `PENDING_COMPONENTS` 里。
 * 于是「补充部署」的两条约束一夹:「全集必须 ⊇ 已装」+「全集里每项都必须已实现」
 * ⇒ **home 永远补装不了任何组件**,而拒因说的还是 `agentcore`(与请求无关,把人引去查错方向)。
 *
 * 🔴 修法**不是**给校验加一个条件就完事:broker 收到的集合会原样变成 `EXEC_ENV_COMPONENTS`,
 * 栈组对不认识的组件是**显式报错**的(刻意 fail-closed)⇒ 只放行校验会把失败从「诚实拒绝」
 * 推到「CodeBuild 中途炸」,更坏。所以这一维要**两侧都认**:
 *   · 本侧(控制面):已装的 external 组件**不算**「尚未实现」、也不算「被减掉」;
 *     **没装**的 external 组件仍然拒(它不能靠执行环境的补充部署装出来);
 *   · infra 侧(`stack-group.ts`):external 组件**跳过**(不建栈、不报错)。两侧名单由 parity 门禁钉住。
 *
 * 🔴 **过滤只发生在 infra 侧,平台侧不要再造一个 `componentsForStackGroup`**:喂给 broker 的那个数组
 * 同时也是它写回描述符的 `components` 投影(`validate.mjs` 的 `plan.projection.components`)——
 * 在平台侧先滤掉 external,描述符就会**丢掉 agentcore 这个事实**(组件列表里看不见它了)。
 */
export const EXTERNAL_COMPONENTS = ["agentcore"] as const;
export type ExternalComponent = (typeof EXTERNAL_COMPONENTS)[number];

export function isComponentExternal(component: string): component is ExternalComponent {
  return (EXTERNAL_COMPONENTS as readonly string[]).includes(component);
}

/** external 组件被当成「新装」时的人话拒因(它由平台自己的栈部署,不走执行环境这条路)。 */
export function externalComponentMessage(components: readonly string[]): string {
  return (
    `组件 ${components.join("、")} 由平台自己的栈部署,不能通过执行环境的「补充部署」装` +
    `(它不属于执行环境栈组的部署面)。已经装了的执行环境会**如实**在组件列表里显示它。`
  );
}

/**
 * 合法但**栈组尚未实现**的组件(勾了会被栈组显式报错 —— 那是刻意的 fail-closed,不是 bug)。
 * 🔴 这份名单只许**缩短**(实现一个就从这里搬去上面),不许悄悄变长。
 */
// residency-api 片 1 已落地(区域审计 / 结果存储),从待办移到已实现
// mwaa 已实现,从待办移出
// 🔴 agentcore **不是「待后续批次」** —— 它已经装了(由
//   `BgpAgentCoreStack` 部署),只是不由 exec-env 栈组建 ⇒ 归 `EXTERNAL_COMPONENTS`。
//   挂在这里的后果:装了它的 home **永远补装不了任何组件**,且拒因说「待后续批次」= 让人等一个
//   永远不会来的批次。
export const PENDING_COMPONENTS = ["kafka"] as const;

export function isComponentImplemented(component: string): component is ImplementedComponent {
  return (IMPLEMENTED_COMPONENTS as readonly string[]).includes(component);
}

/**
 * 按 `IMPLEMENTED_COMPONENTS` 的固定次序归一(去重 + 排序)。
 * 为什么要归一:同一勾选集必须产生**同一份** `components` 数组,否则注册表里的顺序抖动会造出
 * 无意义的 item 变更与 diff 噪声(与 broker 侧 `validateInput` 的归一同一理由)。
 */
export function orderComponents(components: readonly string[]): string[] {
  const set = new Set(components);
  const known = (IMPLEMENTED_COMPONENTS as readonly string[]).filter((c) => set.has(c));
  // 未实现/未知的组件保留在尾部(调用方各自校验;这里只负责稳定次序,不悄悄丢字段)
  const rest = Array.from(set).filter((c) => !(IMPLEMENTED_COMPONENTS as readonly string[]).includes(c)).sort();
  return [...known, ...rest];
}

// ——————————————————————————————————————————————————————————————
// 补充部署(add-components)的**纯判定**
//
// 【为什么拆成纯函数】仓内没有单测 Next route 的先例(要造 NextRequest/app-router 上下文),
// 而这几条判定是安全承重的(尤其"只增不减":减组件意味着销毁有状态资源)。照 broker 侧
// `validate.mjs` 的先例——**不碰 IO 的判定全部拆出来**,route 只做"取数 → 调这里 → 发调用"的接线,
// 于是判定可以被无头单测真执行。
// ——————————————————————————————————————————————————————————————

/** 判定结果:要么给出可下发的全集与新增项,要么给出**面向用户**的拒因。 */
export type ComponentPlan =
  | { ok: true; wanted: string[]; added: string[] }
  | { ok: false; message: string };

/**
 * 校验一次"补充部署"请求。
 * @param installed 注册表里**当前已装**的组件(observed)
 * @param rawWanted 客户端给的**全集**(不是增量)
 *
 * 判定顺序即优先级:形状 → 必含 core → 只许已实现 → 只增不减 → 必须真有新增。
 */
/**
 * `allowNoAddition`:**升级预演**(SPEC §2.1 v3.21)—— 已启用 target 传「与已装相同的全集」= 只想看这次源包对既有栈会改什么。
 * 🔴 只有 `preview` 传它;`add-components` 照旧要求真有新增(它的语义就是加组件),`deploy` 不经本函数。
 */
export function planComponentAddition(
  installed: readonly unknown[],
  rawWanted: unknown,
  // ② —— 必填(不给默认):判「补齐到完整集」必须知道它是谁(主控区?哪个法域?)
  //   路由直接传描述符(含 targetId);单测可直接给 { isHome, jurisdiction }。
  subject: RequiredComponentsSubject | { targetId: string; jurisdiction?: unknown },
  opts: { allowNoAddition?: boolean } = {}
): ComponentPlan {
  if (!Array.isArray(rawWanted) || rawWanted.length === 0 || rawWanted.some((c) => typeof c !== "string")) {
    return { ok: false, message: "components 必须是非空字符串数组(语义 = 部署完成后想要的**组件全集**)" };
  }
  const wanted = orderComponents(rawWanted as string[]);
  if (!wanted.includes("core")) {
    return { ok: false, message: "components 必须含 core(core 恒装;全集语义下不许省略它)" };
  }
  const cur = installed.filter((c): c is string => typeof c === "string");
  // 🔴 external 组件(由平台自己的栈部署)**已装**的:既不算「尚未实现」也不算「被减掉」——
  //    它必须能跟着全集一路带过去,否则装了 agentcore 的 home 连补装别的组件都做不到(病根)。
  //    **没装**的 external 组件仍要拒:它不能靠执行环境的补充部署装出来,且拒因要说清出路。
  const newExternal = wanted.filter((c) => isComponentExternal(c) && !cur.includes(c));
  if (newExternal.length > 0) {
    return { ok: false, message: externalComponentMessage(newExternal) };
  }
  const notImplemented = wanted.filter(
    (c) => !isComponentImplemented(c) && !(isComponentExternal(c) && cur.includes(c))
  );
  if (notImplemented.length > 0) {
    return {
      ok: false,
      message:
        `组件 ${notImplemented.join(", ")} 的栈尚未实现,不能部署(已实现:${IMPLEMENTED_COMPONENTS.join(", ")};` +
        `待后续批次:${PENDING_COMPONENTS.join(", ")})—— 这里如实拒绝,而不是让栈组在部署中途报错`,
    };
  }
  // 停供组件:**只有已装的才允许出现在全集里**。
  // 🔴 这里的 `wanted` 是**全集**语义、且下面明令「不许减组件」⇒ 存量装了 mwaa 的环境**必须**继续带着它,
  //   否则它连「补装别的组件」都做不了。所以判据不能是「全集里不许有 mwaa」,而是
  //   「**不在已装里**却出现 ⇒ 那就是新装 ⇒ 拒」。两者差一个字,行为差很远。
  const newRetired = wanted.filter((c) => isComponentRetired(c) && !cur.includes(c));
  if (newRetired.length > 0) {
    return { ok: false, message: retiredComponentMessage(newRetired) };
  }
  const removed = cur.filter((c) => !wanted.includes(c));
  if (removed.length > 0) {
    return {
      ok: false,
      message:
        `不允许用补充部署减少组件(缺了已装的 ${removed.join(", ")})—— 组件下线要走删除流程` +
        `(drain → 审批 → 销毁,§4.6),不能靠少传一个组件顺手发生`,
    };
  }
  // ② —— 🔴🔴 不提供精简形态(用户 2026-10-10):
  //   ① 下发后的全集必须**装齐**要求集(补一半 = 仍是精简形态;升级预演也一样 —— 不完整的环境先补齐再升级);
  //   ② 新增项只许是要求集里**缺的**那些(补装 = 补齐,不是挑一个额外的装)。
  const required = "targetId" in subject ? requiredComponentsForTarget(subject) : requiredComponentsFor(subject);
  const stillMissing = required.filter((c) => !wanted.includes(c));
  if (stillMissing.length > 0) {
    return { ok: false, message: incompleteEnvMessage(stillMissing) };
  }
  const added = wanted.filter((c) => !cur.includes(c));
  const outside = added.filter((c) => !required.includes(c));
  if (outside.length > 0) {
    return {
      ok: false,
      message:
        `组件 ${outside.join(", ")} 不在该执行环境的完整组件集 [${required.join(", ")}] 里 ——` +
        `补充部署只用来补齐缺失组件,不能另装要求集以外的组件`,
    };
  }
  if (added.length === 0 && !opts.allowNoAddition) {
    return {
      ok: false,
      message: `没有要新增的组件(已装:${cur.join(", ") || "无"})—— 若只是想重跑一次部署,请用「重新部署」`,
    };
  }
  return { ok: true, wanted, added };
}

// ——————————————————————————————————————————————————————————————
// ② —— 🔴🔴 **执行环境的完整组件集**(用户 2026-10-10 拍板,不许精简)
//
// 用户原话:「一个区域只有一个执行环境,而且,不做精简区域,所有区域都必须要完整,不允许做这类的
// 功能设计,一定要完整功能和服务」。⇒ 组件不再是「可选」:每个执行环境的组件集由**它是谁**
// (是不是主控区、是哪个法域)唯一决定,没有人可以挑。
//
// 本函数是这条知识的**唯一作者**,消费者:注册(必须逐字等于它)· 向导(只读展示它)·
// 补充部署(只能补齐到它)· deploy 路由(下发集必须 ⊇ 它)· 下线组件(不许摘它里面的)·
// 详情页(缺了就显示「环境不完整,请补齐」)。infra 侧 `infra/lib/exec-env/context.ts` 有同名副本,
// 由 parity 门禁逐字节钉住(那道边界无法 import 平台代码)。
//
//   · core / redshift / dms / flink / airflow-serverless —— **每个区都必装**;
//   · agentcore —— 只主控区(用户拍板「一个 AgentCore」;它由平台自己的栈部署,属 EXTERNAL);
//   · residency-api —— 法域 ≠ home 的执行环境必装(区域审计 / 区域结果 / 驻留桶;同法域的区用不上它);
//   · mwaa 已停供、kafka 未实现 ⇒ 都不在要求集里。
// ——————————————————————————————————————————————————————————————

/** 每个执行环境(无论哪个区)都必须有的组件。 */
export const BASE_REQUIRED_COMPONENTS = ["core", "redshift", "dms", "flink", "airflow-serverless"] as const;

/** 法域口径与 `residency.ts` 的 `jurisdictionOf` 一致(非字符串 / 空串 ⇒ home);本文件零依赖,不能 import 它。 */
export type RequiredComponentsSubject = { isHome: boolean; jurisdiction?: unknown };

export function requiredComponentsFor(t: RequiredComponentsSubject): string[] {
  const req: string[] = [...BASE_REQUIRED_COMPONENTS];
  if (t.isHome) req.push("agentcore");
  const j = typeof t.jurisdiction === "string" && t.jurisdiction.length > 0 ? t.jurisdiction : "home";
  if (j !== "home") req.push("residency-api");
  return orderComponents(req);
}

/** 已装集相对要求集**缺了**哪些(空 = 完整)。 */
export function missingRequiredComponents(
  installed: readonly unknown[],
  t: RequiredComponentsSubject
): string[] {
  const cur = new Set(installed.filter((c): c is string => typeof c === "string"));
  return requiredComponentsFor(t).filter((c) => !cur.has(c));
}

/**
 * 按**描述符**求完整组件集(服务端各入口共用;主控区判定只在这一处,不让每个路由各写一个 isHome 分支)。
 * 🔴 这里的主控区判定是**身份**(AgentCore 只属主控区),不是「没给 = 主控区」那类缺省回落。
 */
export function requiredComponentsForTarget(t: { targetId: string; jurisdiction?: unknown }): string[] {
  return requiredComponentsFor({ isHome: isHome(t.targetId), jurisdiction: t.jurisdiction });
}

/** 「环境不完整」的人话(降级防御分支 / 详情页 / 拒因共用一份)。 */
export function incompleteEnvMessage(missing: readonly string[]): string {
  return (
    `执行环境不完整:缺少 ${missing.join("、")}。每个执行环境都必须装齐全部组件` +
    `(不提供精简形态)—— 请在「执行环境」详情页点〔补齐缺失组件〕。`
  );
}
