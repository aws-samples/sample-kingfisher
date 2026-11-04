// 执行环境资源命名 —— 部署期侧出口(SSOT re-export)。
//
// 唯一真源是 `platform/naming.json`(见其 $comment)。本文件是它在【部署期侧(infra/CDK)】的出口:
// 执行环境栈组(§3.5)建资源时的每一个名字都必须经这里,不许在栈里拼字面量。
// 运行时侧另有 `platform/src/lib/aws/naming.ts` 读同一 json(import,bundler 内联),
// 二者跨构建边界物理隔离,但同源同值 —— 由 `npm run test:naming-parity`(在 platform 下跑)
// **真执行两侧**、拿同一 fixture 矩阵逐字节比对。
//
// 为什么 readFileSync 而非 import json:照本目录 `model.ts` 先例 —— infra 的 tsconfig rootDir="."
// 会拒绝 import 根目录之外的文件(TS6059);infra 经 ts-node 直跑(cdk.json),__dirname 指向源码目录。
//
// 🔴 为什么这里重复了一份 isHome/toTargetSlug:运行时侧的唯一权威是
//    `platform/src/lib/exec-env/target-id.ts`,但它在 platform 的 tsconfig 里、跨不过构建边界。
//    这是**刻意的、已登记的**第二份实现(change-safety A1),对策 = parity 门禁把两侧输出钉成逐字节相同
//    (含 home / 非 home / 非法 targetId 三类输入),照 `runtime-lib-lock-parity` 先例。
import { readFileSync } from "fs";
import * as path from "path";

// json 在 platform/(而非 repo 根):须与 platform Docker 构建上下文一致(见 platform 侧 model.ts 说明)。
// infra/lib/shared → ../../../platform/naming.json。
const cfg = JSON.parse(
  readFileSync(path.join(__dirname, "..", "..", "..", "platform", "naming.json"), "utf-8"),
) as {
  version: number;
  nonHomeDimension: { key: string };
  kinds: Record<string, { scope: string; vars: string[]; home: string; target: string; maxLength: number; homeSource?: string }>;
};

const ALLOWED_VARS = ["account", "region", "slug", "component"] as const;
type VarName = (typeof ALLOWED_VARS)[number];

/** naming.json 的版本(两侧出口必须同版本 —— parity 门禁断言)。 */
export const NAMING_VERSION: number = cfg.version;

/** non-home 资源名的区分维度(合同:50 SPEC §6.5 Q-2)。 */
export const NON_HOME_DIMENSION: string = cfg.nonHomeDimension.key;

/** 全部已登记 kind(与运行时侧同源同序)。 */
export const RESOURCE_KINDS: string[] = Object.keys(cfg.kinds).sort();

/** home 目标的固定身份(与 platform/src/lib/exec-env/target-id.ts 的 HOME_TARGET_ID 同值,parity 钉住)。 */
export const HOME_TARGET_ID = "tgt_home";

/** 与 target-id.ts 同款正则:`tgt_` + 正文 1–16、首尾必须 alnum、`_` 只许在内部。 */
const TARGET_ID_RE = /^tgt_[a-z0-9](?:[a-z0-9_]{0,14}[a-z0-9])?$/;
const DNS_LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** 只认字面 home(与 target-id.ts#isHome 同语义:不做任何"看起来像 home"的推断)。 */
function isHomeTarget(targetId: string): boolean {
  return targetId === HOME_TARGET_ID;
}

/** targetId → DNS 安全 slug(`_`→`-`);结果必须是合法 DNS label,否则抛。 */
function toSlug(targetId: string): string {
  if (!TARGET_ID_RE.test(targetId)) {
    throw new Error(`非法 targetId:${targetId}(须匹配 ${TARGET_ID_RE.source})`);
  }
  const slug = targetId.replace(/_/g, "-");
  if (!DNS_LABEL_RE.test(slug)) {
    throw new Error(`targetSlug 不是合法 DNS label:${slug}`);
  }
  return slug;
}

export interface ResourceNameVars {
  targetId: string;
  account?: string;
  component?: string;
  region?: string;
}

const ACCOUNT_RE = /^\d{12}$/;
const COMPONENT_RE = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * 生成执行环境资源的**权威名字**(部署期侧)。语义与运行时侧逐字节一致 —— 见 parity 门禁。
 * fail-closed:未登记 kind / 缺变量 / 残留占位符 / 超长,一律抛,绝不返回猜的名字。
 */
export function resourceName(kind: string, vars: ResourceNameVars): string {
  const rule = cfg.kinds[kind];
  if (!rule) {
    throw new Error(
      `命名 SSOT 未登记的资源类别:${kind}(已登记:${RESOURCE_KINDS.join(", ")})—— ` +
        `新资源必须先进 platform/naming.json,不许在栈里拼名字`,
    );
  }
  if (typeof vars?.targetId !== "string" || vars.targetId.length === 0) {
    throw new Error(`命名 SSOT:kind=${kind} 缺 targetId(home 判定与 slug 都由它导出)`);
  }

  const home = isHomeTarget(vars.targetId);
  const slug = toSlug(vars.targetId);

  const supplied: Record<VarName, string | undefined> = {
    account: vars.account,
    region: vars.region,
    slug,
    component: vars.component,
  };

  if (rule.vars.includes("account")) {
    if (!supplied.account || !ACCOUNT_RE.test(supplied.account)) {
      throw new Error(`命名 SSOT:kind=${kind} 需要 12 位 account(收到 ${String(supplied.account)})`);
    }
  }
  if (rule.vars.includes("component")) {
    if (!supplied.component || !COMPONENT_RE.test(supplied.component)) {
      throw new Error(`命名 SSOT:kind=${kind} 需要合法 component(收到 ${String(supplied.component)})`);
    }
  }

  const tpl = home ? rule.home : rule.target;
  let out = tpl;
  for (const v of ALLOWED_VARS) {
    const value = supplied[v];
    if (value === undefined) continue;
    out = out.split(`{${v}}`).join(value);
  }

  if (out.includes("{") || out.includes("}")) {
    throw new Error(`命名 SSOT:kind=${kind} 插值后仍有未填变量:${out}`);
  }
  if (out.length > rule.maxLength) {
    throw new Error(`命名 SSOT:kind=${kind} 生成名超长(${out.length} > ${rule.maxLength}):${out}`);
  }
  return out;
}

/** 执行环境 CFN 栈名(`BgpExecEnv-<slug>-<component>`)。 */
export function execEnvStackName(targetId: string, component: string): string {
  return resourceName("stackName", { targetId, component });
}
