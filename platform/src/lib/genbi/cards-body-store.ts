// 会话卡片**正文**的唯一读写方(54 DESIGN v1.1 §3.1 / §4.2)。
//
// 【为什么正文必须落「数据来源那个 target」的本区桶】一张卡片里有**真实业务数据行**
//   (每轮 ≤200 行 × N 轮)。会话卡片是平台**第一个持久化查询结果行**的功能 ——
//   把正文写进主控区就等于把别法域的数据搬进 us,那正是整个 W5 在防的事。
//   中央表(`bgp-genbi-cards`)只存**不含数据值**的指针,见 cards-store.ts。
//
// 【标题也留区(用户 2026-09-12 拍板)】中央连 `title` 都不存 ⇒ 列表要显示标题就得读该区。
//   逐卡读整份 `body.json` 太重(可能几 MB)⇒ 每张卡**另存一个轻量 `head.json`**
//   (只含 title / turnCount / savedAt)。为什么不做「每用户一个 index.json」:那要维护
//   read-modify-write 的并发一致性(乐观锁 + 重试),而 head 是**每卡一个对象、与正文同一次写入**,
//   压根没有一致性问题;代价只是列表要并发发 N 个小 GET(N ≤ 100,并发上限见 service 层)。
//   🔴 读不到 head **绝不能让卡片从列表里消失** —— 那比看不到标题坏得多(卡片是用户资产)。
//
// 【落点不许有默认值】本模块的入口一律收 `ExecutionTarget` **对象**,不收 `targetId?: string` ——
//   元缺陷教训(一天内「恒打主控区」犯六次,根因是「落点是个有静默合法默认值的参数」):
//   收对象 ⇒ 调用方必须先真的把 target 解析出来,漏传直接是**编译错误**,不会静默落回主控区。
//   桶名与 region 都走 `resolveTargetGlue()`(它对非 home 缺资源/缺 region 一律抛,绝不回落)。
//
// 【加密与生命周期 —— 如实交代,不吹】
//   · 加密 = **桶默认 SSE-S3**(`BucketEncryption.S3_MANAGED`;home `platform-stack.ts:53`、
//     非 home `exec-env/core-stack.ts:64`)。平台只有 residency 桶是 KMS。要给卡片上 CMK
//     得每区一把 key + 授权,属独立加强项,**本包不做**(设计 §3.1 已登记)。
//   · 非 home 的 datalakeBucket 是 `RETAIN` 且不带 autoDeleteObjects(exec-env 纪律)⇒ 删环境不删正文;
//   · 🔴 **home 的 datalakeBucket 是 `DESTROY + autoDeleteObjects: true`**(`platform-stack.ts:57`)⇒
//     销毁平台栈会连 home 卡片正文一起删。这是既有的 home/非 home 不对称(core-stack 文件头写着「刻意相反」),
//     本包**不改它**(那是记的「home 桶仍 DESTROY」那条线),但在设计里登记为已知风险。
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { createHash } from "crypto";
import { s3ClientFor } from "@/lib/exec-env/target-clients";
import { resolveTargetGlue } from "@/lib/exec-env/target-clients";
import type { ExecutionTarget } from "@/lib/exec-env/registry";
// 正文落点的唯一作者记落点决策(卡片正文的
//   S3 Get / Put 落在该区桶上没越区,却因读侧只经 getTargetRaw(看得见即可,不记决策)⇒ 未归因)。
import { notePlaceDecision } from "@/lib/place/context";

/** 决策记账里的作者名。 */
export const CARD_BODY_PLACE_VIA = "cardBodyLocation";

/** 正文对象的前缀。独立前缀 = 与用户的湖内业务数据互不打扰(复用桶但不混目录)。 */
export const CARD_BODY_PREFIX = "genbi-cards";
/** 正文 schema 版本。读到不认识的版本**拒绝**,不猜字段(半懂的解析比读不出来更坏)。 */
export const CARD_BODY_VERSION = 1;
/** 标题上限(标题只存在区域侧 ⇒ 校验也在这一层)。 */
export const MAX_TITLE_LEN = 80;

export interface CardBodyTurn {
  i: number;
  question: string;
  askedAt: string;
  elapsedMs?: number;
  /** 完整 `GenBiResult`(answer / sql / columns / **全部 rows** / chart / steps / usage / …)。 */
  result: Record<string, unknown> | null;
  error?: string | null;
}

export interface CardBody {
  v: number;
  cardId: string;
  conversationId: string;
  targetId: string;
  projectId: string;
  engine: string;
  /**
   * 这段对话执行时所用的**库名**。
   * 🔴 为什么必须随正文存下来:打开卡片要按**当前**数据分级重新脱敏,而分级是按
   *    `<引擎>.<库>.<schema>.<表>` 的 FQN 存的 ⇒ 没有库名就拼不出 FQN ⇒ `maskRows` 找不到任何
   *    参考表 ⇒ **直接放行明文**。2026-09-13 实测:这条路径原来既不传 sql 也不传 database,
   *    于是「按当前分级重新脱敏」在真实数据上**恒为 no-op** —— 卡片成了绕过数据分级的后门。
   * 可选:本字段之前保存的卡片没有它,打开时回落到平台默认库(见 cards-service 的重脱敏段)。
   */
  database?: string;
  title: string;
  savedAt: string;
  savedBy: { sub: string; name?: string };
  turns: CardBodyTurn[];
}

/** 轻量头对象:列表渲染只需要它(标题在区域侧,中央不存)。 */
export interface CardHead {
  v: number;
  cardId: string;
  title: string;
  turnCount: number;
  savedAt: string;
}

export interface CardBodyLocation {
  bucket: string;
  key: string;
  region: string;
}

/** 正文 schema 不认识 / 对象内容不是一张卡片。 */
export class CardBodyUnreadable extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = "CardBodyUnreadable";
  }
}

// 🔴 key 片段必须校验字符集。`userSub` 是 Cognito sub(UUID)、`cardId` 是 ulid —— 两者本来都安全,
//    但它们是**从请求里传进来的字符串**:不校验就等于把 S3 key 的路径结构交给调用方拼(`../` 穿越、
//    空段导致覆盖别人的对象)。这类防护要放在**构造 key 的那一处**,不能指望每个调用方自己检查。
const KEY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

function assertSegment(v: string, what: string): string {
  if (!KEY_SEGMENT.test(v || "")) {
    throw new CardBodyUnreadable(`${what} 形态非法:${JSON.stringify(v)} —— 它会成为 S3 key 的一段,只接受 ${KEY_SEGMENT}`);
  }
  return v;
}

export function cardBodyKey(userSub: string, cardId: string): string {
  return `${CARD_BODY_PREFIX}/${assertSegment(userSub, "userSub")}/${assertSegment(cardId, "cardId")}/body.json`;
}

/** 轻量头对象的 key(与正文同目录,同一次写入)。 */
export function cardHeadKey(userSub: string, cardId: string): string {
  return `${CARD_BODY_PREFIX}/${assertSegment(userSub, "userSub")}/${assertSegment(cardId, "cardId")}/head.json`;
}

// (问数)—— 刷新快照(与正文同目录、同一个桶、同一个区)
/** 一次刷新的快照 key。快照 id 是平台生成的 ulid(DAG 的 runId 带 `#`,不能直接当 key 段)。 */
export function cardRunSnapshotKey(userSub: string, cardId: string, snapshotId: string): string {
  return `${CARD_BODY_PREFIX}/${assertSegment(userSub, "userSub")}/${assertSegment(cardId, "cardId")}/runs/${assertSegment(snapshotId, "snapshotId")}.json`;
}
/** 最近一次刷新的快照(固定 key,便于直接取)。 */
export function cardLatestSnapshotKey(userSub: string, cardId: string): string {
  return `${CARD_BODY_PREFIX}/${assertSegment(userSub, "userSub")}/${assertSegment(cardId, "cardId")}/latest.json`;
}

export interface CardRunSnapshot {
  v: number;
  cardId: string;
  snapshotId: string;
  turnIndex: number;
  refreshedAt: string;
  triggeredBy: "manual" | "schedule";
  sql: string;
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  chart: unknown;
  maskedColumns: string[];
}

/** 写一份刷新快照(`runs/<id>.json` + `latest.json`)。🔴 写在**卡片自己的区**,与正文同一个落点解析。 */
export async function putCardRunSnapshot(target: ExecutionTarget, userSub: string, snap: CardRunSnapshot): Promise<CardBodyLocation> {
  if (snap.v !== CARD_BODY_VERSION) throw new CardBodyUnreadable(`快照 schema 版本 ${snap.v} 不是当前的 ${CARD_BODY_VERSION}`);
  const loc = cardBodyLocation(target, userSub, snap.cardId);
  const s3 = await s3ClientFor(loc.region);
  const text = JSON.stringify(snap);
  const key = cardRunSnapshotKey(userSub, snap.cardId, snap.snapshotId);
  await s3.send(new PutObjectCommand({ Bucket: loc.bucket, Key: key, Body: text, ContentType: "application/json; charset=utf-8" }));
  await s3.send(
    new PutObjectCommand({ Bucket: loc.bucket, Key: cardLatestSnapshotKey(userSub, snap.cardId), Body: text, ContentType: "application/json; charset=utf-8" })
  );
  return { bucket: loc.bucket, key, region: loc.region };
}

/** 删一份快照(保留份数超限 / 刷新途中卡片被删时的补偿)。回 true = 确认不在了。 */
export async function deleteCardRunSnapshot(target: ExecutionTarget, userSub: string, cardId: string, snapshotId: string): Promise<boolean> {
  const loc = cardBodyLocation(target, userSub, cardId);
  try {
    const s3 = await s3ClientFor(loc.region);
    await s3.send(new DeleteObjectCommand({ Bucket: loc.bucket, Key: cardRunSnapshotKey(userSub, cardId, snapshotId) }));
    return true;
  } catch (e) {
    const name = (e as { name?: string })?.name || "";
    if (name === "NoSuchKey" || name === "NotFound") return true;
    console.error("[genbi/cards-body-store] 删快照失败:s3://%s/…/%s %s", loc.bucket, snapshotId, String(e));
    return false;
  }
}

/** 标题校验(区域侧唯一作者)。拒绝时说清超了多少。 */
export function assertTitle(title: string): string {
  const t = (title || "").trim();
  if (!t) throw new CardBodyUnreadable("标题不能为空(保存卡片时必须命名)");
  if (t.length > MAX_TITLE_LEN) throw new CardBodyUnreadable(`标题 ${t.length} 字,超过上限 ${MAX_TITLE_LEN} 字(超出 ${t.length - MAX_TITLE_LEN} 字)`);
  return t;
}

/** 这张卡片的正文该在哪(桶 + key + region)。**只从描述符解析**,非 home 缺一即抛。 */
export function cardBodyLocation(target: ExecutionTarget, userSub: string, cardId: string): CardBodyLocation {
  const landing = resolveTargetGlue(target);
  notePlaceDecision({ targetId: target.targetId, via: CARD_BODY_PLACE_VIA });
  return { bucket: landing.datalakeBucket, key: cardBodyKey(userSub, cardId), region: landing.region };
}

export interface PutCardBodyResult extends CardBodyLocation {
  bytes: number;
  sha256: string;
}

/**
 * 写正文。返回 `{bucket, key, region, bytes, sha256}` —— 调用方拿它去写中央指针(§7.1 的顺序:
 * **先正文、后指针**;反过来会出现「列表里有、打开报错」,而先正文失败最多留一个孤儿对象)。
 */
export async function putCardBody(target: ExecutionTarget, userSub: string, body: CardBody): Promise<PutCardBodyResult> {
  if (body.v !== CARD_BODY_VERSION) throw new CardBodyUnreadable(`正文 schema 版本 ${body.v} 不是当前的 ${CARD_BODY_VERSION}`);
  if (body.targetId !== target.targetId) {
    // 🔴 正文里写着 A 区、却往 B 区的桶里放 = 事后没人能发现的错位。这里当场拒。
    throw new CardBodyUnreadable(`正文的 targetId=${body.targetId} 与落点 target=${target.targetId} 不一致`);
  }
  const title = assertTitle(body.title);
  const loc = cardBodyLocation(target, userSub, body.cardId);
  const text = JSON.stringify({ ...body, title });
  const bytes = Buffer.byteLength(text, "utf8");
  const sha256 = createHash("sha256").update(text).digest("hex");
  const s3 = await s3ClientFor(loc.region);
  await s3.send(
    new PutObjectCommand({ Bucket: loc.bucket, Key: loc.key, Body: text, ContentType: "application/json; charset=utf-8" })
  );
  // 🔴 头对象**紧跟正文写**(同一次调用内):它是列表唯一的标题来源,失败必须让调用方知道 ——
  //    静默少写一个 head 的后果是「列表里这张卡永远没有标题」,而没人会想到去查这里。
  const head: CardHead = { v: CARD_BODY_VERSION, cardId: body.cardId, title, turnCount: body.turns.length, savedAt: body.savedAt };
  await s3.send(
    new PutObjectCommand({
      Bucket: loc.bucket, Key: cardHeadKey(userSub, body.cardId),
      Body: JSON.stringify(head), ContentType: "application/json; charset=utf-8",
    })
  );
  return { ...loc, bytes, sha256 };
}

/** 读正文。对象不存在 ⇒ `null`(指针悬空由调用方按「清理未完成」呈现);内容不是卡片 ⇒ 抛。 */
export async function getCardBody(target: ExecutionTarget, userSub: string, cardId: string): Promise<CardBody | null> {
  const loc = cardBodyLocation(target, userSub, cardId);
  const s3 = await s3ClientFor(loc.region);
  let text: string;
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: loc.bucket, Key: loc.key }));
    text = (await r.Body?.transformToString()) ?? "";
  } catch (e) {
    const name = (e as { name?: string })?.name || "";
    if (name === "NoSuchKey" || name === "NotFound") return null;
    // 🔴 其它错误(AccessDenied / 网络 / 桶不存在)**原样上抛**:把它们混成 null 就等于
    //    把「读不到」说成「没有」—— 本仓已为这个病付过两次代价。
    throw e;
  }
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CardBodyUnreadable(`s3://${loc.bucket}/${loc.key} 不是合法 JSON`);
  }
  const b = parsed as CardBody;
  if (!b || typeof b !== "object" || b.v !== CARD_BODY_VERSION || !Array.isArray(b.turns)) {
    throw new CardBodyUnreadable(`s3://${loc.bucket}/${loc.key} 不是当前版本(v${CARD_BODY_VERSION})的卡片正文`);
  }
  if (b.cardId !== cardId) throw new CardBodyUnreadable(`正文里的 cardId=${b.cardId} 与请求的 ${cardId} 不一致`);
  return b;
}

/**
 * 读轻量头(列表用)。对象不存在 ⇒ `null`;🔴 其它错误**原样上抛** —— 调用方据此把标题位显示成
 * 「该区域当前读不到」而**不是**把卡片从列表里去掉。
 */
export async function getCardHead(target: ExecutionTarget, userSub: string, cardId: string): Promise<CardHead | null> {
  const loc = cardBodyLocation(target, userSub, cardId);
  const s3 = await s3ClientFor(loc.region);
  let text: string;
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: loc.bucket, Key: cardHeadKey(userSub, cardId) }));
    text = (await r.Body?.transformToString()) ?? "";
  } catch (e) {
    const name = (e as { name?: string })?.name || "";
    if (name === "NoSuchKey" || name === "NotFound") return null;
    throw e;
  }
  if (!text) return null;
  try {
    const h = JSON.parse(text) as CardHead;
    if (!h || h.v !== CARD_BODY_VERSION || h.cardId !== cardId || typeof h.title !== "string") return null;
    return h;
  } catch {
    return null;
  }
}

/**
 * 删正文。回 `true` = 确认不在了(删成功或本来就没有);回 `false` = **没删掉**
 * (调用方据此把指针留成 `deleting` ⇒ 列表里出现「清理未完成 · 重试」,残留可见)。
 * 🔴 故意不吞异常成 `true`:那会让「清理失败」长得像「已清理干净」。
 */
export async function deleteCardBody(
  target: ExecutionTarget,
  userSub: string,
  cardId: string,
  // 🔴 **必填**(不给静默默认值):刷新快照也在这个目录里,
  //   漏传 = 删卡后该区留下一串带业务数据行的孤儿快照。新卡(从没刷新过)显式传 `[]`。
  snapshotIds: readonly string[]
): Promise<boolean> {
  const loc = cardBodyLocation(target, userSub, cardId);
  try {
    const s3 = await s3ClientFor(loc.region);
    // 两个对象都要删(正文 + 头)。少删一个 ⇒ 残留一个带标题的孤儿头对象。
    await s3.send(new DeleteObjectCommand({ Bucket: loc.bucket, Key: loc.key }));
    await s3.send(new DeleteObjectCommand({ Bucket: loc.bucket, Key: cardHeadKey(userSub, cardId) }));
    // 刷新快照:最近一次 + 清单里的每一份(清单由指针维护,最多 30 份)
    await s3.send(new DeleteObjectCommand({ Bucket: loc.bucket, Key: cardLatestSnapshotKey(userSub, cardId) }));
    for (const sid of snapshotIds) {
      await s3.send(new DeleteObjectCommand({ Bucket: loc.bucket, Key: cardRunSnapshotKey(userSub, cardId, sid) }));
    }
    return true;
  } catch (e) {
    const name = (e as { name?: string })?.name || "";
    if (name === "NoSuchKey" || name === "NotFound") return true; // 本来就没有 = 已清理
    console.error("[genbi/cards-body-store] 删正文失败(留残留可见):s3://%s/%s %s", loc.bucket, loc.key, String(e));
    return false;
  }
}
