// **PlaceWire v1 的 JS 读取函数**(形状见 platform/place-wire.schema.json)。
//
// 为什么放在 genbi/core:这里是平台 TS 唯一会被**编译进别的运行时**的目录(scripts/core-prebuild.sh 把它编成 CJS,
// 拷进 AgentCore 容器与技能 Lambda 的 core-dist/)⇒ 平台 / 容器 / Lambda 三个 JS 运行时读的是**同一份源**;
// Python 两个运行时(调度运行时 / Spark 脚本)的读取函数在 lib/place/wire-py.ts,契约测试钉五者同夹具同结果。
//
// 🔴 本文件零依赖(core 规矩:不许 `@/`、不许 SDK),只做三件事:解析 · 按 schema 校验 · 归一。
//    缺 / 多 / 形态不对 ⇒ 抛 PlaceWireInvalid(带 JSON 路径),**没有任何缺省值**:读不到落点的运行时只许报错,
//    不许拿自己进程环境里的区 / 工作组顶上(技能 Lambda 原来就是那样静默回落主控区的)。

export interface PlaceWireRedshift {
  readonly workgroup: string;
  readonly database: string;
  readonly secretArn?: string;
}
export interface PlaceWireAthena {
  readonly workgroup: string;
  readonly outputLocation: string;
  readonly catalogRef: string;
}
export interface PlaceWire {
  readonly v: 1;
  readonly targetId: string;
  readonly region: string;
  readonly redshift?: PlaceWireRedshift;
  readonly athena?: PlaceWireAthena;
}

/** 与 schema 的 pattern 逐字相同(契约测试比对 schema 文件,改一边另一边就红)。 */
export const PLACE_WIRE_TARGET_ID_PATTERN = "^tgt_[a-z0-9](?:[a-z0-9_]{0,14}[a-z0-9])?$";
export const PLACE_WIRE_REGION_PATTERN = "^[a-z]{2}(-[a-z]+)+-\\d$";
export const PLACE_WIRE_SECRET_ARN_PATTERN = "^arn:[a-z-]+:secretsmanager:";
export const PLACE_WIRE_S3_LOCATION_PATTERN = "^(s3://.+)?$";

export class PlaceWireInvalid extends Error {
  readonly code = "PLACE_WIRE_INVALID" as const;
  constructor(readonly path: string, why: string) {
    super(`落点(PlaceWire)不合法:${path} ${why} —— 已拒绝,不会用本运行时自己的区 / 工作组顶上`);
    this.name = "PlaceWireInvalid";
  }
}

const TOP = ["v", "targetId", "region", "redshift", "athena"];
const RS = ["workgroup", "database", "secretArn"];
const ATH = ["workgroup", "outputLocation", "catalogRef"];

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
function onlyKeys(o: Record<string, unknown>, allowed: string[], at: string): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new PlaceWireInvalid(`${at}.${k}`, "是未知字段");
}
function str(o: Record<string, unknown>, k: string, at: string, opts: { pattern?: string; minLength?: number }): string {
  const v = o[k];
  if (typeof v !== "string") throw new PlaceWireInvalid(`${at}.${k}`, v === undefined ? "缺失" : "必须是字符串");
  if (opts.minLength !== undefined && v.length < opts.minLength) throw new PlaceWireInvalid(`${at}.${k}`, "不能为空");
  if (opts.pattern !== undefined && !new RegExp(opts.pattern).test(v)) throw new PlaceWireInvalid(`${at}.${k}`, "形态不对");
  return v;
}

/** 读一个 PlaceWire(对象或其 JSON 文本)。返回**归一后的新对象**(键序固定、可选腿缺省即不出现)。 */
export function readPlaceWire(raw: unknown): PlaceWire {
  let o: unknown = raw;
  if (typeof raw === "string") {
    try {
      o = JSON.parse(raw);
    } catch {
      throw new PlaceWireInvalid("$", "不是合法 JSON");
    }
  }
  if (!isObj(o)) throw new PlaceWireInvalid("$", "必须是对象");
  onlyKeys(o, TOP, "$");
  if (o.v !== 1) throw new PlaceWireInvalid("$.v", "必须是 1");
  const targetId = str(o, "targetId", "$", { pattern: PLACE_WIRE_TARGET_ID_PATTERN });
  const region = str(o, "region", "$", { pattern: PLACE_WIRE_REGION_PATTERN });
  const out: { v: 1; targetId: string; region: string; redshift?: PlaceWireRedshift; athena?: PlaceWireAthena } = { v: 1, targetId, region };
  if (o.redshift !== undefined) {
    const r = o.redshift;
    if (!isObj(r)) throw new PlaceWireInvalid("$.redshift", "必须是对象");
    onlyKeys(r, RS, "$.redshift");
    const leg: { workgroup: string; database: string; secretArn?: string } = {
      workgroup: str(r, "workgroup", "$.redshift", { minLength: 1 }),
      database: str(r, "database", "$.redshift", { minLength: 1 }),
    };
    if (r.secretArn !== undefined) leg.secretArn = str(r, "secretArn", "$.redshift", { pattern: PLACE_WIRE_SECRET_ARN_PATTERN });
    out.redshift = leg;
  }
  if (o.athena !== undefined) {
    const a = o.athena;
    if (!isObj(a)) throw new PlaceWireInvalid("$.athena", "必须是对象");
    onlyKeys(a, ATH, "$.athena");
    out.athena = {
      workgroup: str(a, "workgroup", "$.athena", { minLength: 1 }),
      outputLocation: str(a, "outputLocation", "$.athena", { pattern: PLACE_WIRE_S3_LOCATION_PATTERN }),
      catalogRef: str(a, "catalogRef", "$.athena", { minLength: 1 }),
    };
  }
  return out;
}

/** 取某条腿;落点里没有这条腿 ⇒ 拒(不回落)。 */
export function placeWireLeg(w: PlaceWire, leg: "redshift"): PlaceWireRedshift;
export function placeWireLeg(w: PlaceWire, leg: "athena"): PlaceWireAthena;
export function placeWireLeg(w: PlaceWire, leg: "redshift" | "athena"): PlaceWireRedshift | PlaceWireAthena {
  const v = w[leg];
  if (!v) throw new PlaceWireInvalid(`$.${leg}`, "缺失(这次调用要用这条腿)");
  return v;
}
