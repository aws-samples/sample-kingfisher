// @kf-batch 50-P50.1a-naming-ssot
// 执行环境资源命名 —— 运行时侧出口(SSOT re-export)。
//
// 唯一真源是 `platform/naming.json`(见其 $comment)。本文件是它在【运行时侧(platform/Next.js)】的出口。
// 部署期侧(infra/CDK)另有 `infra/lib/shared/naming.ts` 读同一 json,二者跨构建边界物理隔离、
// 但同源同值,并由 `npm run test:naming-parity` **真执行**逐条比对(两份手写实现必然漂移,
// 唯一钉得住的办法是拿同一 fixture 矩阵跑两侧、逐字节比)。
//
// 为什么 import json 而非 readFileSync:照 `lib/ai/model.ts` 先例 —— resolveJsonModule 已开,
// bundler 把 json 内联进 bundle,零运行时文件读取(Next standalone 下无 __dirname/cwd 漂移风险)。
//
// 【本文件的三条承重】
// ① **零派生**:名字只来自模板表,函数自己不拼字符串、不做 `isHome ? A : B` 之外的任何分支;
// ② **fail-closed**:未登记的 kind、缺变量、插值后仍残留 `{`、超长 —— 一律抛错,**绝不返回猜的名字**
//    (裂缝B 教训:带占位符的字面量流进真实资源名比报错难查一个量级);
// ③ **home 判定不接受调用方传参**:`isHome` 一律由 `targetId` 经 exec-env/target-id 的唯一权威函数导出。
//    50 SPEC §6.5 的旧签名 `resourceName(kind,{account,region,targetId,cellId?,isHome})` 收了 `isHome`,
//    那是**可伪造的旁路**(调用方传 `isHome:true` 就能让非 home target 拿到 home 存量资源名 =
//    跨 target 串资源);registry.ts:321 已对描述符双向钉住 home 不变量,这里同理收紧。
//    🔴 合同已随本批订正(50 SPEC §6.5 / DESIGN §3.2),不是"代码不照合同写"。
import { isHome, toTargetSlug } from "@/lib/exec-env/target-id";
import namingConfig from "../../../naming.json";

/** 模板里允许出现的变量 —— 封闭集合。新增变量必须同时改两侧出口 + parity fixture。 */
const ALLOWED_VARS = ["account", "region", "slug", "component"] as const;
type VarName = (typeof ALLOWED_VARS)[number];

interface KindRule {
  scope: string;
  vars: string[];
  home: string;
  target: string;
  maxLength: number;
  homeSource?: string;
}

const KINDS = namingConfig.kinds as unknown as Record<string, KindRule>;

/** 已登记的资源类别。 */
export type ResourceKind = keyof typeof namingConfig.kinds;

/** 全部 kind 名(反向覆盖门禁与 parity fixture 都按此枚举,避免手抄清单漂移)。 */
export const RESOURCE_KINDS = Object.keys(KINDS).sort() as ResourceKind[];

/** naming.json 的版本(改规则必升;两侧出口断言同版本)。 */
export const NAMING_VERSION: number = namingConfig.version;

/** non-home 资源名的区分维度(合同:50 SPEC §6.5 Q-2 —— 按 targetId 派生,不是 region/cellId)。 */
export const NON_HOME_DIMENSION: string = namingConfig.nonHomeDimension.key;

export interface ResourceNameVars {
  /** 必填:目标身份。home 判定与 slug 都由它导出,**不接受调用方另传 isHome**。 */
  targetId: string;
  /** 12 位账号 id;仅 S3 全局命名空间的 kind 需要。 */
  account?: string;
  /** 组件名;仅 `stackName` 需要。 */
  component?: string;
  /** region;当前无 kind 消费(见 naming.json 的 nonHomeDimension.$rationale),保留以便将来登记 region 维 kind。 */
  region?: string;
}

// ——————————————————————————————————————————————————————————————
// 加载期自检:模板表本身不合法就**在导入时**炸,而不是等某个 region 部署到一半才炸
// ——————————————————————————————————————————————————————————————
{
  const varSet: ReadonlySet<string> = new Set<string>(ALLOWED_VARS);
  for (const [kind, rule] of Object.entries(KINDS)) {
    for (const v of rule.vars) {
      if (!varSet.has(v)) throw new Error(`naming.json 非法:kind=${kind} 声明了未知变量 ${v}`);
    }
    for (const which of ["home", "target"] as const) {
      const tpl = rule[which];
      if (typeof tpl !== "string" || tpl.length === 0) {
        throw new Error(`naming.json 非法:kind=${kind} 的 ${which} 模板为空`);
      }
      // 模板里出现的变量必须都在 vars 里声明(否则 requireVars 检查不到它 ⇒ 会残留 `{x}`)。
      // Array.from:tsconfig 未开 downlevelIteration,直接 for..of 一个 matchAll 迭代器过不了 tsc。
      for (const m of Array.from(tpl.matchAll(/\{([a-zA-Z]+)\}/g))) {
        if (!rule.vars.includes(m[1])) {
          throw new Error(`naming.json 非法:kind=${kind} 的 ${which} 模板用了未声明变量 {${m[1]}}`);
        }
      }
    }
    if (!Number.isInteger(rule.maxLength) || rule.maxLength <= 0) {
      throw new Error(`naming.json 非法:kind=${kind} 缺合法 maxLength`);
    }
  }
}

const ACCOUNT_RE = /^\d{12}$/;
const COMPONENT_RE = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * 生成执行环境资源的**权威名字**。
 *
 * @param kind 已登记的资源类别(未登记 ⇒ 抛错,不猜)
 * @param vars 变量袋;函数只接受该 kind **声明过**的变量,缺一个就抛
 *
 * home 走存量实名(豁免:存量资源不改名),non-home 走带 `{slug}` 的派生名。
 */
export function resourceName(kind: ResourceKind | string, vars: ResourceNameVars): string {
  const rule = KINDS[kind as string];
  if (!rule) {
    throw new Error(
      `命名 SSOT 未登记的资源类别:${String(kind)}(已登记:${RESOURCE_KINDS.join(", ")})—— ` +
        `新资源必须先进 platform/naming.json,不许在调用处拼名字`
    );
  }
  if (typeof vars?.targetId !== "string" || vars.targetId.length === 0) {
    throw new Error(`命名 SSOT:kind=${String(kind)} 缺 targetId(home 判定与 slug 都由它导出)`);
  }

  const home = isHome(vars.targetId);
  // toTargetSlug 自带"结果必须是合法 DNS label"断言(target-id.ts),非法 targetId 在这里就炸。
  const slug = toTargetSlug(vars.targetId);

  const supplied: Record<VarName, string | undefined> = {
    account: vars.account,
    region: vars.region,
    slug,
    component: vars.component,
  };

  if (rule.vars.includes("account")) {
    if (!supplied.account || !ACCOUNT_RE.test(supplied.account)) {
      throw new Error(`命名 SSOT:kind=${String(kind)} 需要 12 位 account(收到 ${String(supplied.account)})`);
    }
  }
  if (rule.vars.includes("component")) {
    if (!supplied.component || !COMPONENT_RE.test(supplied.component)) {
      throw new Error(`命名 SSOT:kind=${String(kind)} 需要合法 component(收到 ${String(supplied.component)})`);
    }
  }

  const tpl = home ? rule.home : rule.target;
  let out = tpl;
  for (const v of ALLOWED_VARS) {
    const value = supplied[v];
    if (value === undefined) continue;
    out = out.split(`{${v}}`).join(value);
  }

  // 🔴 残留占位符一律抛错 —— 宁可部署失败,也不要建出名字里带 `{` 的真实资源。
  if (out.includes("{") || out.includes("}")) {
    throw new Error(`命名 SSOT:kind=${String(kind)} 插值后仍有未填变量:${out}`);
  }
  if (out.length > rule.maxLength) {
    throw new Error(`命名 SSOT:kind=${String(kind)} 生成名超长(${out.length} > ${rule.maxLength}):${out}`);
  }
  return out;
}

/**
 * 序 72 B-140 —— 某类资源**名字的形态**(home / target 两模板都认),用来判定一个物理名「是不是平台建的这类资源」
 * (如依赖库 URI 的桶是不是平台脚本桶,才许在提交到别的区时换成该区的桶);**不**用来生成名字(生成走 `resourceName`)。
 * 变量形态:account = 12 位数字;slug / component = 小写字母数字连字符;region = 形如 us-east-1。
 */
export function resourceNamePattern(kind: ResourceKind | string): RegExp {
  const rule = KINDS[kind as string];
  if (!rule) {
    throw new Error(`命名 SSOT 未登记的资源类别:${String(kind)}(已登记:${RESOURCE_KINDS.join(", ")})`);
  }
  const VAR_PATTERN: Record<VarName, string> = {
    account: "\\d{12}",
    region: "[a-z]{2}(?:-gov)?-[a-z]+-\\d",
    slug: "[a-z0-9-]+",
    component: "[a-z0-9-]+",
  };
  const escape = (tpl: string) => tpl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const toSource = (tpl: string) =>
    escape(tpl).replace(/\\\{(account|region|slug|component)\\\}/g, (_m, v: VarName) => `(?:${VAR_PATTERN[v]})`);
  return new RegExp(`^(?:${toSource(rule.home)}|${toSource(rule.target)})$`);
}

/**
 * 执行环境 CFN 栈名(`BgpExecEnv-<slug>-<component>`)。
 * 单独给一个出口是因为它的调用方(§3.5 栈组)只关心组件,不该自己记得 kind 名叫 `stackName`。
 */
export function execEnvStackName(targetId: string, component: string): string {
  return resourceName("stackName", { targetId, component });
}

/** 该 kind 在 home 上的存量实名出处(供反向覆盖门禁与人工核对用)。 */
export function homeSourceOf(kind: ResourceKind | string): string | undefined {
  return KINDS[kind as string]?.homeSource;
}
