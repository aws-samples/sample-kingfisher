// @kf-batch 50-P50.3-mirror
// 跨地域元数据镜像的**纯函数层**(50 SPEC §3.13 / §1.1 表 / INTERACTION §4quater)。
//
// ── 为什么单独一个 shared 文件 ────────────────────────────────────────────────
// 「这个分面新不新鲜」必须**只有一个作者**:页面要用它上色、服务端要用它决定该不该刷、
// 验收脚本要用它断言。W3-d2 已经被同一件事咬过一次(`CELL_UI` 里那列 `attention` 就是
// 第二个真值源,加一个态就漂)⇒ 这里从第一行起就把判定放在服务端与浏览器**共用**的纯函数里,
// 本文件**不许 import 任何 AWS SDK / node 内置**(否则前端 bundle 会炸,也就用不上了)。
//
// 🔴 本层最要紧的两件事:
//   ① **穷举映射**:`MIRROR_UI_ORDER` / `MIRROR_ATTENTION` 都按 `Record<MirrorState, …>` 写死,
//      新加一个态**编译期**就必须给它定去处 —— `?? "fresh"` 那种兜底会让新态静默变绿(§3.1b ③ 同一条教训);
//   ② **不许信 DDB 的懒删**:TTL 到点后 DynamoDB 最长 48h 才真删,所以读侧**必须自己判 `ttl`**。
//      只靠"item 还在就是有效"会把 9 天前的镜像当成有效数据画出来 —— 那正是 §3.13
//      「过期即视为 stale」要防的事,而它恰好是"看起来一切正常"的形态。

/** 镜像条目的种类。🔴 键空间由合同定死(SPEC §1.1:`kind ∈ db|table|column|lineage-edge`)。 */
export const MIRROR_KINDS = ["db", "table", "column", "lineage-edge"] as const;
export type MirrorKind = (typeof MIRROR_KINDS)[number];

/**
 * 🔴 **本刀真正会写入的 kind**,与合同的键空间**故意不等**,理由如实登记(SPEC §3.13 已同步):
 *   · `column`:列名随**表条目的 payload** 一起存(`columns:[{name,type}]`)。拆成独立 item 会让
 *     一次刷新从 ~10² 涨到 ~10⁴ 次写(500 表 × 20 列),而读侧一次也用不到"按列查" ⇒ 纯浪费;
 *     键空间保留给轴C 的列级分级镜像(那时才有"按列查"的读侧)。
 *   · `lineage-edge`:平台的血缘边存在**中央** `bgp-lineage`,**没有 target 维度**
 *     (两个区的同名表现在共用一条边 —— 那正是 SPEC §4「轴B」列的 P50.4 待修项)。
 *     ⇒ 本刀**不编造**按区血缘数,分面上照实显示「未采集」+ 原因(见 `NOT_COLLECTED`)。
 */
export const MIRROR_WRITTEN_KINDS: readonly MirrorKind[] = ["db", "table"] as const;

/** 分面汇总条目的 sk(不是 `<kind>#<fqn>` 形态 ⇒ 与镜像条目天然不撞)。 */
export const MIRROR_FACET_SK = "facet#summary";

/** 合同:DDB TTL = 7d(过期即视为 stale)。 */
export const MIRROR_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 定时刷新的目标节奏(leader 循环里按它决定"这个 target 该不该刷")。 */
export const MIRROR_REFRESH_MS = 30 * 60 * 1000;
/**
 * 🔴 判「陈旧」的阈值 = 3 × 刷新节奏。
 * 取 3 倍而不是 1 倍:leader 每 4min 一 tick、一个 tick 只刷有预算的几个 target,
 * 阈值贴着节奏会让正常运行的环境一直闪 ⚠(狼来了 ⇒ 用户学会忽略告警,比不报还糟)。
 */
export const MIRROR_STALE_MS = 3 * MIRROR_REFRESH_MS;

/** 一个 target 分面的新鲜度。🔴 值域穷举,新增必须同时给 UI 与「要不要处理」定去处。 */
export type MirrorState = "fresh" | "stale" | "expired" | "never" | "failed";

/** 呈现顺序(也是"最严重优先"的顺序);同时充当穷举清单。 */
export const MIRROR_UI_ORDER: readonly MirrorState[] = ["never", "expired", "stale", "failed", "fresh"] as const;

/**
 * 需要用户动手(给〔立即同步〕入口)的态。
 * 🔴 `failed` 也算:数据可能还新,但"最近一次同步失败"必须能看见 ——
 * 藏起来的话镜像会一直烂到跨过 stale 阈值才暴露,而那时离根因已经很远了。
 */
export const MIRROR_ATTENTION: readonly MirrorState[] = ["never", "expired", "stale", "failed"] as const;

export function mirrorNeedsSync(s: MirrorState): boolean {
  return MIRROR_ATTENTION.includes(s);
}

export interface MirrorFreshnessInput {
  /** 最近一次**成功**采集的时刻(ISO 串或 epoch ms);从没成功过 ⇒ 不传 */
  mirroredAt?: string | number | null;
  /** DDB TTL(**epoch 秒**,与表上 `ttl` 属性同单位) */
  ttl?: number | null;
  /** 最近一次采集失败的原因(成功则不传) */
  error?: string | null;
  now?: number;
}

/**
 * 分面新鲜度的**唯一判定**。
 *
 * 优先级 `never > expired > stale > failed > fresh`:
 *   · `never`:压根没成功过 —— 与"过期"是两件事,合并会让用户以为"同步过、只是旧了";
 *   · `expired`:🔴 **自己判 `ttl`**,不信 DDB 懒删(见文件头 ②);
 *   · `stale`:超过 `MIRROR_STALE_MS`;
 *   · `failed`:数据还在阈值内,但最近一次采集失败 ⇒ 仍要提示(见 `MIRROR_ATTENTION`)。
 */
export function mirrorFacetState(input: MirrorFreshnessInput): MirrorState {
  const now = input.now ?? Date.now();
  const at = toEpochMs(input.mirroredAt);
  if (at === null) return "never";
  // ttl 是 epoch **秒**;缺 ttl 的老 item 不当过期(只按阈值判),但**有** ttl 就必须尊重它
  if (typeof input.ttl === "number" && Number.isFinite(input.ttl) && input.ttl * 1000 <= now) return "expired";
  if (now - at > MIRROR_STALE_MS) return "stale";
  if (input.error) return "failed";
  return "fresh";
}

/** ISO 串 / epoch ms → epoch ms;认不出来 ⇒ `null`(**不当成 0**:0 会被判成 1970 年的陈旧镜像)。 */
export function toEpochMs(v: string | number | null | undefined): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v : null;
  if (typeof v === "string" && v.trim()) {
    const n = Date.parse(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 「3 分钟前」这种相对说法 —— 页面常驻标注要用(INTERACTION §4quater 明写要显示相对时间)。 */
export function describeAge(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s 前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}min 前`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h 前`;
  return `${Math.floor(h / 24)}d 前`;
}

export function mirrorPk(targetId: string): string {
  return `mirror#${targetId}`;
}

export function mirrorSk(kind: MirrorKind, fqn: string): string {
  return `${kind}#${fqn}`;
}

/**
 * 反解 sk。🔴 只在**第一个** `#` 处切:FQN 里出现 `#` 时按最后一个切会把 kind 解错
 * (而"解错 kind"的表现是分面计数悄悄少一类,不报错)。
 */
export function parseMirrorSk(sk: string): { kind: MirrorKind; fqn: string } | null {
  const i = sk.indexOf("#");
  if (i <= 0) return null;
  const kind = sk.slice(0, i);
  const fqn = sk.slice(i + 1);
  if (!fqn) return null;
  if (!(MIRROR_KINDS as readonly string[]).includes(kind)) return null;
  return { kind: kind as MirrorKind, fqn };
}

/** 镜像的采集来源。`glue` 定时可刷;`redshift` **只在人点〔采集数仓目录〕时**跑(理由见下)。 */
export const MIRROR_SOURCES = ["glue", "redshift"] as const;
export type MirrorSource = (typeof MIRROR_SOURCES)[number];

/**
 * 🔴 **定时只刷 Glue,数仓目录必须手动** —— 这是一条**成本**决定,不是偷懒:
 * Redshift Serverless 按 RPU-秒计费且**空闲会暂停**;每 30min 往每个区打一条 `SVV_*` 查询
 * 等于把所有区的数仓永久保持唤醒 ⇒ 一个纯只读的看板把数仓账单拉成常态。
 * ⇒ 定时采 Glue(GetDatabases/GetTables 是**免费**的目录 API),数仓目录做成显式手动动作,
 *   谁点谁知道要花钱;并且它**单独盖时间戳**、单独显示,绝不混进"镜像 3min 前 ✓"里
 *   (混进去就等于用一次 2 小时前的手动采集冒充实时)。
 */
//
// @kf-batch 50-WP28-platform-action-node —— 🔴 口径修订(2026-10-10,用户拍板序 33「治理定时」):
//   上面那条成本决定管的是**平台自己的 30 分钟镜像定时器**(leader 循环)—— 它仍然只刷 Glue,一个字都不变。
//   新增的是**用户自己建的「定时治理任务 · 目录同步」**:用户可以显式勾上 `redshift`(定时采数仓目录),
//   建任务的页面上明示「定时采数仓目录会唤醒该区数仓并产生计费」;不勾就不采。
//   ⇒ 「谁点谁知道要花钱」这条原则没变,只是「点」从按钮扩展到了「用户亲手配的 cron」。
//   采集仍走同一个作者 `mirrorMetadata` + 由调用方注入的 `warehousePuller`(编译边界照旧)。
export const MIRROR_TIMER_SOURCES: readonly MirrorSource[] = ["glue"] as const;

/** 一次采集里**每个来源各自**的结果(部分失败必须能看见,不许被总数吞掉)。 */
export interface MirrorSourceReport {
  source: MirrorSource;
  ok: boolean;
  /** 成功采集的时刻(ISO);失败/跳过 ⇒ 不传 */
  at?: string;
  /**
   * 🔴 **最近一次尝试**的时刻(成功与失败都盖)。
   * 少了它就分不清「一直在试但一直失败」与「压根没再试过」——
   * 两者在界面上都长成 `⚠ 2h 前`,而处置完全不同。
   */
  attemptedAt?: string;
  databases: number;
  tables: number;
  columns: number;
  /** 失败原因(已截断) */
  error?: string;
  /** 本次**故意没采**的原因(如该 target 没装 redshift 组件) */
  skipped?: string;
}

/**
 * 分面上**采不到**的指标 —— 🔴 照实登记,不给数字。
 * 宪法 A4:一个编出来的 0 比一个「未采集」危险得多(前者看起来像"该区很干净")。
 */
export const NOT_COLLECTED = [
  {
    metric: "lineage-edges",
    label: "血缘边",
    reason: "平台血缘边存在中央表且**没有 target 维度**(两个区的同名表共用一条边)⇒ 按区计数会是同一个数重复显示",
    slice: "SPEC §4 轴B / P50.4",
  },
  {
    metric: "quality-score",
    label: "质量分",
    reason: "质量结果按 FQN 存、无 target 维度 ⇒ 两个区的同名表互相覆盖,现在拿出来的「该区质量分」其实是最后一次跑的那个区",
    slice: "SPEC §4 轴B / P50.4",
  },
  {
    metric: "sensitive-hits",
    label: "敏感命中",
    reason: "敏感扫描结果同样无 target 维度;且跨法域的画像必须**在区内算**(中央不留列值画像)",
    slice: "SPEC §4 轴B/轴D / P50.4",
  },
] as const;

export interface MirrorFacet {
  targetId: string;
  region: string;
  jurisdiction: string;
  isHome: boolean;
  /** 注册表里还活跃?(不活跃仍显示 —— 只列活跃会把"那个区还留着东西"藏掉,同矩阵列的取法) */
  active: boolean;
  /** 最近一次**成功**采集(仅定时来源;数仓目录另计,见 `warehouse`) */
  mirroredAt?: string;
  ttl?: number;
  state: MirrorState;
  databases: number;
  tables: number;
  columns: number;
  sources: MirrorSourceReport[];
  /** 手动采集的数仓目录:**自己的时间戳、自己的态**,不参与上面的 ✓/⚠ */
  warehouse?: MirrorSourceReport & { state: MirrorState };
  /** 命中条目上限而被截断 ⇒ 🔴 必须显示(静默截断在界面上等于"这个区就这么点东西") */
  truncated: boolean;
  cap: number;
}

/** 一屏总览。`notCollected` 由服务端下发 ⇒ 诚实文案也只有一个作者。 */
export interface MirrorOverview {
  facets: MirrorFacet[];
  totals: { databases: number; tables: number; columns: number };
  notCollected: typeof NOT_COLLECTED;
  /** 有多少个分面需要用户动手(⚠/从未同步/失败) */
  needSync: number;
  /** 读注册表/镜像表时的**部分失败**(绝不静默变成"少一个分面") */
  warnings: string[];
}
