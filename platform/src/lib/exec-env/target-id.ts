// @kf-batch 50-G1   ← 审核用批次标签(可 grep:`grep -rn "@kf-batch" platform/src infra`)
// G1(模块 50)—— `targetId` / `targetSlug` / `isHome()` 的**唯一权威**。
//
// 设计合同:docs/design/50-multi-region-execution/SPEC.md §1.1a(格式定稿 + 出口清单)、§1.1(home target)。
// 本文件属 **G 共享地基批**:只建函数与常量,**不改任何现有行为**(无损、可回滚)。
//
// ── 为什么需要不可变的 `targetId`,而不是直接用 region ────────────────────────────
// DESIGN §20.1-1 的地基订正:早期方案把 region 当主键,导致三个同根缺陷 ——
// ① `bgp-task-runs` 的 `(taskId, runId)` 在多 region 下碰撞(同 cron 的 Airflow runId 确定性相同);
// ② 运行锁缺作用域;③ 身份被绑死在"位置"上。改成不可变身份 `targetId`(位置/账号降为属性)后三者同解。
//
// ── `targetSlug` 为什么必须存在 ────────────────────────────────────────────────
// CFN 栈名 / DNS / ACM / APIGW 域名 / IAM 角色名**都不允许 `_`**。若只有 `targetId`
// (含 `_`),部署第一步建栈就失败。故定义 `targetSlug = targetId.replace(/_/g,"-")`,
// 并且**双向可逆**(因为 targetId 禁 `-`)。
//
// 🔴 **出口清单(SPEC §1.1a,禁想当然)**:
//   · 锁属性名 / FQN·OM service 段 / 审计分片键 / DDB 键值 → 用 **targetId 原值**
//   · CFN 栈名 / DNS / ACM / APIGW 域名 / IAM 角色名        → 用 **targetSlug**
//   · cost 签名 → **不喂 targetId**(`costSignature` 会强制大写并折叠 `__`),改喂哈希短码
//   · GenBI 检索 token → **不喂 targetId 字面量**(`tokenize` 把 `_` 变空格,会被切成多 token),
//     改按 targetId 精确等值过滤
// slug 与 id 的映射**只许经本文件**,禁在散点写 `replace(/_/g,"-")`。

/** home target 的固定常量。**不是** region 字面量 —— 消 DESIGN §2.1 两种 sk 写法的对撞。 */
export const HOME_TARGET_ID = "tgt_home";

export const TARGET_ID_PREFIX = "tgt_";

/**
 * `tgt_` 之后的正文最大长度。
 *
 * 🔴 **由下面 `PER_TARGET_NAME_BUDGETS` 反推,不是拍脑袋**(外部审核 P1-6:"targetId 合同
 * 无资源长度预算")。SPEC §1.1a **原写 `{1,40}`**(总长 44),而 `bgp-paramadvisor-runtime-role-` + 44 = 74
 * **超过 IAM RoleName 的 64**;实测更紧的是 S3 桶名(`bgp-glue-scripts-<12位账号>` 已占 29,上限 63)。
 * 取 16(总长 20)留出余量,SPEC 的示例 `tgt_usw2_a`(10)/`tgt_euw1_prod`(13)都在内。
 *
 * 🔴 **v3.4:合同已统一到 16**(外部审核 v2 P1-2:"不能用未同步合同的 16 替代权威 40")。
 * 从此**两边不许再各说各话** —— `__tests__/contract-drift.test.ts` 直接 **parse SPEC §1.1a 的正则**
 * 与本文件核对。**改这个数之前**先跑 `target-id.test.ts` 的预算断言 + 那条漂移测试。
 */
export const TARGET_ID_BODY_MAX = 16;

/** targetId 总长上限(含 `tgt_` 前缀)。`targetSlug` 长度与之相同(逐字符替换)。 */
export const TARGET_ID_MAX_LEN = TARGET_ID_PREFIX.length + TARGET_ID_BODY_MAX;

/**
 * 正文中间段的最大长度(首尾各占 1 个 alnum)。
 * 单字符正文(如 `tgt_a`)靠可选分组表达,不需要第二条正则。
 */
const TARGET_ID_MIDDLE_MAX = TARGET_ID_BODY_MAX - 2;

/**
 * 格式:`^tgt_[a-z0-9](?:[a-z0-9_]{0,14}[a-z0-9])?$`(SPEC §1.1a v3.4)。
 *
 * 禁 `#`(它是复合 runId 的分隔符,SPEC §1.2)、禁 `-`(留给 slug 做可逆映射)、禁大写、禁点。
 *
 * 🔴 **正文首尾必须 `[a-z0-9]`、`_` 只许在内部**(v3.4 新增;外部审核 v2 P1-2 实测):
 * 旧正则 `[a-z0-9_]{1,16}` 允许正文以 `_` 收尾 ⇒ `tgt_a_` 合法,而它的 slug `tgt-a-`
 * **不是合法 DNS label**(DNS/ACM/APIGW 要求 label 以字母数字结束)。这种错不会在校验时暴露,
 * 会拖到"建证书 / 建自定义域名"那一步才炸 —— 离根因极远。同理 `tgt__` → `tgt--` 也被挡掉。
 */
const TARGET_ID_RE = new RegExp(`^tgt_[a-z0-9](?:[a-z0-9_]{0,${TARGET_ID_MIDDLE_MAX}}[a-z0-9])?$`);

/** slug 形态:与 id 同构(逐字符 `_`→`-`),首尾同样必须 alnum。 */
const TARGET_SLUG_RE = new RegExp(`^tgt-[a-z0-9](?:[a-z0-9-]{0,${TARGET_ID_MIDDLE_MAX}}[a-z0-9])?$`);

/**
 * 正则字面(给**契约漂移测试**用)。
 * 🔴 `__tests__/contract-drift.test.ts` 直接 parse SPEC §1.1a 的"格式"行并与本值逐字符比对 ——
 * 这是"拿实现常量和自己比"(外部审核 v2 P1-2 的根因之一)的对策:比对对象必须是**权威合同**。
 */
export const TARGET_ID_PATTERN = TARGET_ID_RE.source;

// ——————————————————————————————————————————————————————————————
// 出口形态断言(P1-2:"预算测试应再覆盖 DNS label / S3 名称,而不只是长度算术")
// ——————————————————————————————————————————————————————————————

/** DNS label(RFC 1123):小写 alnum 开头结尾,中间可含 `-`,≤63。ACM/APIGW/ALB 主机名段同此。 */
const DNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** S3 通用桶名:3–63、小写 alnum 开头结尾,中间可含 `-`/`.`;这里额外禁 `.`(禁虚拟托管式证书坑)。 */
const S3_BUCKET_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

/** CFN 栈名:字母开头,只允许字母数字与 `-`,≤128。 */
const CFN_STACK_RE = /^[A-Za-z][-A-Za-z0-9]{0,127}$/;

export function isDnsLabel(v: string): boolean {
  return DNS_LABEL_RE.test(v);
}

export function isS3BucketName(v: string): boolean {
  return S3_BUCKET_RE.test(v);
}

export function isCfnStackName(v: string): boolean {
  return CFN_STACK_RE.test(v);
}

// ——————————————————————————————————————————————————————————————
// 资源名长度预算(P1-6)——**编码成数据,好让单测机械校验**
// ——————————————————————————————————————————————————————————————

export interface PerTargetNameBudget {
  /** 资源类别,报错信息里用 */
  kind: string;
  /** AWS 对该名字的硬上限 */
  awsLimit: number;
  /** per-target 命名里 targetId/slug **之前**已占用的字符数(含账号号等展开后的真实长度) */
  prefixLen: number;
  /** 分隔符长度(通常 1 个 `-`) */
  separatorLen: number;
  /**
   * targetId/slug **之后**还要预留的字符数。
   * 主要是 DESIGN §3.2 的 `-<cellId>`:同 region 第二个及以后的 target 要追加 cell 后缀,
   * 否则同区两 target 在全局命名空间(如 S3 桶)撞名。
   */
  suffixReserve: number;
  /** 这个前缀是从哪儿量出来的 —— 便于以后核对,而不是相信这里的数字 */
  measuredFrom: string;
}

/**
 * 🔴 各出口的真实预算。`prefixLen` 全部是**量出来的**(见 `measuredFrom`),不是估的。
 * 新增一类 per-target 资源时**必须同步加一行**,否则长度风险重新变成隐性。
 */
export const PER_TARGET_NAME_BUDGETS: PerTargetNameBudget[] = [
  {
    kind: "s3-bucket",
    awsLimit: 63,
    // `bgp-glue-scripts-`(17)+ 12 位账号 = 29,是全仓最长的 per-target 桶基名。
    prefixLen: 29,
    separatorLen: 1,
    suffixReserve: 9, // `-` + cellId(≤8)
    measuredFrom: "infra/lib/platform-stack.ts: bucketName `bgp-glue-scripts-${accountId}`",
  },
  {
    kind: "iam-role-name",
    awsLimit: 64,
    // `bgp-paramadvisor-runtime-role` = 29(agentcore 是可选组件,故它确实会 per-target)。
    prefixLen: 29,
    separatorLen: 1,
    suffixReserve: 9,
    measuredFrom: "infra/lib: roleName `bgp-paramadvisor-runtime-role`(全仓最长 per-target 角色基名)",
  },
  {
    kind: "redshift-workgroup",
    awsLimit: 64,
    prefixLen: 13, // `bgp-workgroup`
    separatorLen: 1,
    suffixReserve: 9,
    measuredFrom: "infra/lib/redshift-stack.ts: workgroupName `bgp-workgroup`",
  },
  {
    kind: "mwaa-environment",
    awsLimit: 80,
    prefixLen: 8, // `bgp-mwaa`
    separatorLen: 1,
    suffixReserve: 9,
    measuredFrom: "infra/lib/mwaa-stack.ts: environmentName `bgp-mwaa`",
  },
  {
    kind: "cfn-stack-name",
    awsLimit: 128,
    prefixLen: 10, // `BgpExecEnv`
    separatorLen: 1,
    // 栈组后面还要接组件段(如 `-redshift-writer`),留 32。
    suffixReserve: 32,
    measuredFrom: "50 SPEC §3.5: 栈组名 `BgpExecEnv-<targetSlug>-*`",
  },
];

/** 单个出口允许的 targetId 最大长度。 */
export function allowedTargetIdLenFor(b: PerTargetNameBudget): number {
  return b.awsLimit - b.prefixLen - b.separatorLen - b.suffixReserve;
}

/**
 * 全部出口共同允许的 targetId 最大长度(取最小)。
 * `TARGET_ID_MAX_LEN` 必须 ≤ 本值 —— 由单测断言,不靠人记。
 */
export function maxAllowedTargetIdLen(): number {
  return Math.min(...PER_TARGET_NAME_BUDGETS.map(allowedTargetIdLenFor));
}

/** 哪些出口最紧(报错信息里指名道姓,便于直接去改那个命名)。 */
export function tightestNameBudgets(): PerTargetNameBudget[] {
  const min = maxAllowedTargetIdLen();
  return PER_TARGET_NAME_BUDGETS.filter((b) => allowedTargetIdLenFor(b) === min);
}

// ——————————————————————————————————————————————————————————————
// 校验 / 判定 / 映射
// ——————————————————————————————————————————————————————————————

export function isValidTargetId(v: unknown): v is string {
  return typeof v === "string" && TARGET_ID_RE.test(v);
}

/**
 * 校验并原样返回。不合法**抛错**。
 *
 * 🔴 用在"targetId 来自外部输入"的所有入口(API 参数、DDB 读回、DAG spec)。
 * 理由见 SPEC §2.2:非法/未知 target **绝不允许回落 home** —— 回落 home 等于把 A 区任务
 * 静默打到 home 数据面,跨法域时就是数据出境。
 */
export function assertTargetId(v: unknown): string {
  if (!isValidTargetId(v)) {
    throw new Error(
      `非法 targetId:${JSON.stringify(v)};要求 ${TARGET_ID_RE.source}` +
        `(正文 1–${TARGET_ID_BODY_MAX} 字符、**首尾必须 [a-z0-9]**、'_' 只许在内部;` +
        `禁 '#'、禁 '-'、禁大写;总长 ≤ ${TARGET_ID_MAX_LEN})`
    );
  }
  return v;
}

// @kf-batch 50-WP31-place-first-class
/**
 * 记录上的执行区章(run 的 `targetId`、数据源的 `ownerTargetId` …)⇒ targetId —— **唯一作者**(WP-31 序 3)。
 * 🔴 无章 = 多区之前写下的存量记录(当年只有主控区一条执行路径)⇒ 主控区:这是**历史事实**,
 *    与数据源存量归属迁移(placement.ts)同一条理由;新记录一律显式盖章,不走这条推理。
 * 🔴 章非法 ⇒ 抛(不许让非法值流到解析层再变成「查不到 = 主控区」)。零 import,前后端共用。
 */
export function targetOfStamp(stamp: unknown): string {
  if (stamp === undefined || stamp === null || stamp === "") return HOME_TARGET_ID;
  return assertTargetId(stamp);
}

/**
 * 是否 home target。
 *
 * 🔴 判据是**字面等于 `tgt_home`**,别用"没传就是 home""region 等于 home region"之类的推断
 * —— 那正是外部审核 P0-4 抓到的 fail-open(`registry.getTarget(id) ?? homeTarget`)的同款错误。
 */
export function isHome(target: string | { targetId?: string } | null | undefined): boolean {
  if (!target) return false;
  const id = typeof target === "string" ? target : target.targetId;
  return id === HOME_TARGET_ID;
}

/**
 * @kf-batch 50-WP6-cost-by-region —— targetId → **成本签名用的哈希短码**(出口清单第 3 条的唯一实现)。
 *
 * 🔴 为什么不能直接把 targetId 塞进签名:`costSignature` 的 key 段要求 `[A-Z0-9_]`,而 targetId 小写带 `_`,
 *    大写化 + 折叠 `__` 后 `tgt_a_b` 与 `tgt_ab` 这类会撞成同一段 —— 两个区的成本事件被归并进同一个知识库主档。
 * 实现:FNV-1a 32 位 → 8 位大写十六进制。纯 JS、零依赖(本文件会被前端 bundle 引用,不许 import node:crypto)。
 * 8 位 = 2^32 空间;一个账号的执行环境个位数到几十个,碰撞概率可忽略,且碰撞的后果仅是两区事件同档(不丢数据)。
 */
export function targetSignatureCode(targetId: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < targetId.length; i++) {
    h ^= targetId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).toUpperCase().padStart(8, "0");
}

/**
 * targetId → targetSlug(CFN 栈名 / DNS / ACM / IAM 角色名等禁 `_` 的出口专用)。
 *
 * 🔴 **不只是 `replace`**:产物还要过 DNS label 断言(v3.4)。正则已经保证首尾 alnum,
 * 这一道是 defense-in-depth —— 万一以后有人放宽了 `TARGET_ID_RE`,炸点会落在**这里**
 * (带着"哪个 targetId 生成了非法 slug"的信息),而不是几十分钟后在 ACM 建证书时。
 */
export function toTargetSlug(targetId: string): string {
  const slug = assertTargetId(targetId).replace(/_/g, "-");
  if (!isDnsLabel(slug)) {
    throw new Error(
      `targetId ${JSON.stringify(targetId)} 生成的 targetSlug ${JSON.stringify(slug)} 不是合法 DNS label ` +
        `(须小写 alnum 开头结尾)—— DNS / ACM 证书 / APIGW 自定义域名会在部署期拒绝它(SPEC §1.1a)`
    );
  }
  return slug;
}

/** targetSlug → targetId。可逆的前提是 targetId 禁 `-`(见 §1.1a 禁用字符)。 */
export function fromTargetSlug(slug: string): string {
  if (!TARGET_SLUG_RE.test(slug)) {
    throw new Error(`非法 targetSlug:${JSON.stringify(slug)};要求 ${TARGET_SLUG_RE.source}`);
  }
  return assertTargetId(slug.replace(/-/g, "_"));
}

/** home 的 slug,常量化避免各处重复调用。 */
export const HOME_TARGET_SLUG = HOME_TARGET_ID.replace(/_/g, "-");
