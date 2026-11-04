// 敏感数据识别扫描器：内置检测器注册表（**单一事实源**）。
//
// 全球化优先于本地化：以通用(region="global")检测器为主，地区化仅收录少量代表性样例，
// 与通用检测器同一接口、同一注册表。**新增一个检测器只在本文件加一行**，引擎/服务/前端零改动。
//
// 关键取舍（面向全球用户，不做单一国家特化）：
//  - 信用卡用 Luhn 校验和（checksumDetector），而非"16 位数字"——通用于全球卡组织。
//  - 电话用 E.164 宽松格式（+ 国码 + 6–14 位），而非任何单国号段。
//  - IP 同时覆盖 IPv4 与 IPv6。
//  - 国家身份证号（US-SSN / CN 身份证 / IN-Aadhaar）作为 region≠global 的可选扩展，接口一致。

import { regexDetector, checksumDetector, luhnValid, type SensitiveDetector } from "./types";

// ─── 通用检测器（region="global"，全球适用，首期核心）────────────────────────────
const GLOBAL: SensitiveDetector[] = [
  regexDetector({
    id: "email",
    label: "邮箱地址",
    category: "pii",
    level: "L3",
    mask: "email",
    nameHints: ["email", "mail", "e_mail", "邮箱", "电邮", "邮件"],
    // RFC 简化：本地名@域名.tld；足够区分邮箱列而不误伤普通文本。
    valueRegex: /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/,
  }),
  checksumDetector({
    id: "credit_card",
    label: "信用卡号",
    category: "financial",
    level: "L4",
    mask: "full",
    nameHints: ["card", "credit", "creditcard", "pan", "cardno", "cardnumber", "卡号", "银行卡"],
    validate: luhnValid, // Luhn：全球卡组织通用校验，非位数硬编码
  }),
  regexDetector({
    id: "ip_address",
    label: "IP 地址",
    category: "network",
    level: "L2",
    mask: "full",
    nameHints: ["ip", "ipaddr", "ipaddress", "clientip", "remoteip", "host"],
    // IPv4 或 IPv6（压缩式亦可）。
    valueRegex:
      /^((25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3})$|^(([0-9A-Fa-f]{1,4}:){2,7}[0-9A-Fa-f]{0,4})$/,
  }),
  regexDetector({
    id: "iban",
    label: "IBAN 国际银行账号",
    category: "financial",
    level: "L4",
    mask: "partial",
    nameHints: ["iban", "account", "acct", "账号", "账户"],
    // 2 字母国码 + 2 校验位 + 11–30 位 BBAN（宽松结构，不做逐国 BBAN 校验）。
    valueRegex: /^[A-Za-z]{2}\d{2}[A-Za-z0-9]{11,30}$/,
  }),
  regexDetector({
    id: "phone",
    label: "电话号码",
    category: "pii",
    level: "L3",
    mask: "partial",
    nameHints: ["phone", "mobile", "tel", "telephone", "cellphone", "msisdn", "手机", "电话", "座机"],
    // E.164 宽松：可选 +，首位非 0，共 7–15 位数字。国际通用，不绑定任何单国号段。
    valueRegex: /^\+?[1-9]\d{6,14}$/,
  }),
  regexDetector({
    id: "credential",
    label: "凭证/密钥",
    category: "credential",
    level: "L4",
    mask: "full",
    // 纯列名启发：值常已被 hash/加密，不依赖正则；命中列名即高危。
    nameHints: [
      "password", "passwd", "pwd", "secret", "token", "apikey", "api_key",
      "accesskey", "access_key", "ak", "sk", "privatekey", "private_key",
      "credential", "auth", "密码", "密钥", "凭证",
    ],
  }),
  regexDetector({
    id: "full_name",
    label: "姓名",
    category: "pii",
    level: "L3",
    mask: "partial",
    // 姓名无跨文化稳定正则 → 列名启发为主。
    nameHints: ["name", "fullname", "full_name", "firstname", "lastname", "realname", "contact", "姓名", "名字", "联系人"],
  }),
  regexDetector({
    id: "postal_address",
    label: "邮寄地址",
    category: "location",
    level: "L2",
    mask: "partial",
    nameHints: ["addr", "address", "street", "住址", "地址", "收货地址"],
  }),
  regexDetector({
    id: "dob",
    label: "出生日期",
    category: "pii",
    level: "L3",
    mask: "partial",
    nameHints: ["birth", "birthday", "dob", "dateofbirth", "生日", "出生", "出生日期"],
    // ISO 或常见分隔的年月日（1900–2099）。**requireName**：任意日期列都会命中此正则,
    // 故必须列名先命中(birth/dob…)才产出,否则 created_at/updated_at 等时间戳列会被误报。
    valueRegex: /^(19|20)\d{2}[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12]\d|3[01])/,
    requireName: true,
  }),
];

// ─── 地区化检测器（region≠"global"，可选扩展，首期少量样例证明可插拔）───────────────
// 与通用检测器同一接口、同一打分逻辑；引擎不因 region 走不同代码路径。
// 接更多国家 = 加一行 national_id.<xx>，不改引擎。
const REGIONAL: SensitiveDetector[] = [
  regexDetector({
    id: "national_id.us_ssn",
    label: "美国社会安全号 (SSN)",
    category: "pii",
    region: "US",
    level: "L4",
    mask: "full",
    nameHints: ["ssn", "socialsecurity", "social_security"],
    valueRegex: /^\d{3}-?\d{2}-?\d{4}$/,
  }),
  regexDetector({
    id: "national_id.cn_resident",
    label: "中国居民身份证号",
    category: "pii",
    region: "CN",
    level: "L4",
    mask: "full",
    nameHints: ["idcard", "id_card", "idno", "身份证", "证件号", "sfz"],
    // 18 位：17 位数字 + 校验位(数字或 X)。
    valueRegex: /^\d{17}[\dXx]$/,
  }),
  regexDetector({
    id: "national_id.in_aadhaar",
    label: "印度 Aadhaar 号",
    category: "pii",
    region: "IN",
    level: "L4",
    mask: "full",
    nameHints: ["aadhaar", "aadhar", "uid"],
    // 12 位数字（可空格分组）。
    valueRegex: /^\d{4}\s?\d{4}\s?\d{4}$/,
  }),
];

// 唯一注册点。引擎遍历此数组；顺序不影响结果（引擎取置信度最高者）。
export const DETECTORS: SensitiveDetector[] = [...GLOBAL, ...REGIONAL];

// 便于前端/健康分展示：检测器元数据（不含 detect 逻辑）。
export interface DetectorMeta {
  id: string;
  label: string;
  category: string;
  region: string;
  suggestedLevel: string;
  suggestedMask: string;
}
export const DETECTOR_META: DetectorMeta[] = DETECTORS.map((d) => ({
  id: d.id,
  label: d.label,
  category: d.category,
  region: d.region,
  suggestedLevel: d.suggestedLevel,
  suggestedMask: d.suggestedMask,
}));

export function getDetector(id: string): SensitiveDetector | undefined {
  return DETECTORS.find((d) => d.id === id);
}
