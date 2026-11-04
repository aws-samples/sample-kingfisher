// 敏感数据识别扫描器：检测器 SPI（同构纯 TS）
//
// 面向全球用户，检测器**可插拔、绝不做单一国家特化硬编码**。识别引擎（scan.ts）对
// "有哪些检测器"完全无知：它只遍历注册表（registry.ts），对每列跑每个检测器的 detect()，
// 取置信度最高者作为主建议。**新增一个 PII 类型 = registry 加一行，引擎/服务/前端零改动。**
//
// 照抄项目既有 SPI 样板（lib/engines/{types,spi,registry}）：接口在此，声明式工厂覆盖 90%
// 场景（列名线索 + 值正则/校验和），复杂逻辑用自定义 detect()。

import type { SensitivityLevel, MaskStrategy } from "@/lib/governance/classification";

// 敏感类别（跨文化通用；不绑定任何国家）。
export type PiiCategory =
  | "pii" // 个人身份信息（姓名/生日/地址…）
  | "financial" // 金融（信用卡/IBAN/账号…）
  | "credential" // 凭证（密码/token/密钥…）
  | "network" // 网络标识（IP/MAC…）
  | "location" // 位置（地址/经纬度…）
  | "health" // 健康（预留）
  | "other";

export const PII_CATEGORIES: PiiCategory[] = [
  "pii",
  "financial",
  "credential",
  "network",
  "location",
  "health",
  "other",
];

// 一列的检测输入。sampleValues 仅存在于内存，绝不落库/出日志（见 scan.ts §抽样值处置）。
export interface DetectorContext {
  columnName: string; // 原始列名（检测器内部自行归一：小写 / 去分隔符）
  columnType: string; // Redshift 数据类型（供数值/文本类判定）
  sampleValues: string[]; // 抽样非空值（字符串化）
}

// 检测器命中时返回的打分与证据；不命中返回 null。
export interface DetectorMatch {
  confidence: number; // 0–1
  hitRate?: number; // 值命中率（有值正则/校验和的检测器）
  evidence: {
    nameMatched?: boolean;
    valueHitRate?: number;
    method: "name" | "value" | "name+value" | "checksum";
  };
}

// 检测器 SPI —— 引擎只依赖这个接口，不认识任何具体类型。
export interface SensitiveDetector {
  id: string; // 稳定 id：通用用裸名(email/credit_card)，地区化用命名空间(national_id.us_ssn)
  label: string; // 展示名（i18n：中文源串即 key）
  category: PiiCategory;
  region: string; // "global" | "US" | "CN" | "EU" | "IN" ...；默认 "global"。仅作展示/筛选，引擎一视同仁全跑
  suggestedLevel: SensitivityLevel; // 建议默认值（采纳时用户可改）
  suggestedMask: MaskStrategy;
  detect(ctx: DetectorContext): DetectorMatch | null;
}

// ─── 打分常量（引擎侧统一逻辑，检测器工厂共享，避免每个检测器重复实现）───────────────
const NAME_WEIGHT = 0.5; // 列名命中贡献
const VALUE_WEIGHT = 0.5; // 值命中率满贡献
const NAME_ONLY_CAP = 0.6; // 仅列名启发（无值判定）的置信度封顶——"疑似，需人工确认"
const DEFAULT_VALUE_THRESHOLD = 0.8; // 值命中率视为"强证据"的阈值（仅影响 method 标注）

// 列名归一：小写 + 去除非字母数字分隔符（user_email / userEmail / 用户邮箱 → 统一比较）。
function normName(name: string): string {
  return (name || "").toLowerCase().replace(/[^a-z0-9一-龥]+/g, "");
}

// 列名线索命中：任一 hint（同样归一）作为归一后列名的子串即命中。
function nameHit(columnName: string, hints: string[]): boolean {
  const n = normName(columnName);
  if (!n) return false;
  return hints.some((h) => {
    const nh = normName(h);
    return nh.length > 0 && n.includes(nh);
  });
}

// 值命中率：抽样非空值中满足 predicate 的比例。空样本返回 0。
function valueHitRate(values: string[], predicate: (v: string) => boolean): number {
  const nonEmpty = values.filter((v) => v != null && String(v).trim() !== "");
  if (nonEmpty.length === 0) return 0;
  let hit = 0;
  for (const v of nonEmpty) {
    try {
      if (predicate(String(v).trim())) hit++;
    } catch {
      /* predicate 抛错按未命中处理，绝不影响整体扫描 */
    }
  }
  return hit / nonEmpty.length;
}

// ─── 声明式工厂 1：列名线索 + 可选值正则 ──────────────────────────────────────────
// 覆盖大多数检测器。有 valueRegex 时综合列名 + 值命中率打分；无 valueRegex（如凭证/姓名）
// 则仅列名启发，置信度封顶 NAME_ONLY_CAP。
export function regexDetector(cfg: {
  id: string;
  label: string;
  category: PiiCategory;
  region?: string;
  level: SensitivityLevel;
  mask: MaskStrategy;
  nameHints: string[];
  valueRegex?: RegExp;
  valueThreshold?: number;
  // 语义弱、值正则宽的检测器(如 dob:任意日期值都命中)置 true —— 要求**列名先命中**才产出,
  // 值证据只加强不单独成立,避免把 created_at/updated_at 这类时间戳列误报成"出生日期"。
  requireName?: boolean;
}): SensitiveDetector {
  const threshold = cfg.valueThreshold ?? DEFAULT_VALUE_THRESHOLD;
  return {
    id: cfg.id,
    label: cfg.label,
    category: cfg.category,
    region: cfg.region ?? "global",
    suggestedLevel: cfg.level,
    suggestedMask: cfg.mask,
    detect(ctx: DetectorContext): DetectorMatch | null {
      const nameMatched = nameHit(ctx.columnName, cfg.nameHints);

      // 无值正则：纯列名启发。命中列名才产出，置信度封顶。
      if (!cfg.valueRegex) {
        if (!nameMatched) return null;
        return {
          confidence: NAME_ONLY_CAP,
          evidence: { nameMatched: true, method: "name" },
        };
      }

      // requireName：语义弱的检测器,列名不中直接不产出(值证据只加强,不单独成立)。
      if (cfg.requireName && !nameMatched) return null;

      // 有值正则：列名与值两路证据线性叠加。
      const re = cfg.valueRegex;
      const rate = valueHitRate(ctx.sampleValues, (v) => re.test(v));
      const confidence = Math.min(
        1,
        (nameMatched ? NAME_WEIGHT : 0) + VALUE_WEIGHT * rate
      );
      if (confidence <= 0) return null;
      const method =
        nameMatched && rate >= threshold
          ? "name+value"
          : rate >= threshold
          ? "value"
          : nameMatched
          ? "name"
          : "value";
      return {
        confidence,
        hitRate: rate,
        evidence: { nameMatched, valueHitRate: rate, method },
      };
    },
  };
}

// ─── 声明式工厂 2：列名线索 + 校验和/自定义校验函数 ────────────────────────────────
// 用于信用卡 Luhn 等"结构 + 校验位"类型：validate(v) 通过率即 hitRate。
export function checksumDetector(cfg: {
  id: string;
  label: string;
  category: PiiCategory;
  region?: string;
  level: SensitivityLevel;
  mask: MaskStrategy;
  nameHints: string[];
  validate: (v: string) => boolean;
  valueThreshold?: number;
}): SensitiveDetector {
  const threshold = cfg.valueThreshold ?? DEFAULT_VALUE_THRESHOLD;
  return {
    id: cfg.id,
    label: cfg.label,
    category: cfg.category,
    region: cfg.region ?? "global",
    suggestedLevel: cfg.level,
    suggestedMask: cfg.mask,
    detect(ctx: DetectorContext): DetectorMatch | null {
      const nameMatched = nameHit(ctx.columnName, cfg.nameHints);
      const rate = valueHitRate(ctx.sampleValues, cfg.validate);
      const confidence = Math.min(
        1,
        (nameMatched ? NAME_WEIGHT : 0) + VALUE_WEIGHT * rate
      );
      // 校验和类：无值命中且列名也不中 → 不产出（避免纯噪声）。
      if (confidence <= 0 || (rate === 0 && !nameMatched)) return null;
      return {
        confidence,
        hitRate: rate,
        evidence: {
          nameMatched,
          valueHitRate: rate,
          method: rate >= threshold ? "checksum" : nameMatched ? "name" : "checksum",
        },
      };
    },
  };
}

// Luhn 校验和（全球卡组织通用；比"16 位数字"更准，且不特化任何单一卡种/国家）。
export function luhnValid(raw: string): boolean {
  const s = raw.replace(/[\s-]/g, "");
  if (!/^\d{13,19}$/.test(s)) return false;
  let sum = 0;
  let alt = false;
  for (let i = s.length - 1; i >= 0; i--) {
    let d = s.charCodeAt(i) - 48; // '0' = 48
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}
