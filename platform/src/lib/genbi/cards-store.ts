// 问数「会话卡片」的**中央指针 + 每人配额**的唯一写入方(54 DESIGN v1.1 §4.1 / §5.1 / §3.2)。
//
// 【为什么必须是单一作者】上限「每人最多 100 张」只有在**指针与计数器同一次事务**里才是真的:
//   「先 Count 再 Put」在两个并发保存都读到 99 时会写出 **101** —— 本仓最常见的一类洞。
//   ⇒ 这张表的全部写入(建 / 更 / 释放额度 / 删)只从本文件出去;路由层不许自己碰它。
//
// 【本表只存非数据值,连**标题**都不在这】结果行 / SQL / answer / 推理步骤一律落**该 target 本区**的 S3(§3.1);
//   🔴 **标题也留区**(用户 2026-09-12 拍板,否掉了「标题存中央」那个默认):标题是用户自己填的,
//   但它同样可能含业务语义,而中央=主控区 ⇒ 存进来就是把该区域的文本搬走。
//   代价已知并已处理:列表要显示标题就得读该区的轻量 `head.json`;该区读不到时**卡片仍然列出**
//   (cardId / 区域 / 时间 / 轮数都在中央),标题位显示占位 —— 绝不让「读不到标题」变成「列表是空的」。
// 【本表只存非数据值】结果行 / SQL / answer / 推理步骤一律落**该 target 本区**的 S3(§3.1)——
//   会话卡片是平台**第一个持久化查询结果行**的功能,正文放中央就等于把别法域的数据搬进主控区。
//   🔴 这条不靠自觉:`assertNoDataValues` 让那些字段**进不来**(A4「让非法状态无法表达」),
//   真环境判据 GC-7 再扫一遍全表兜底。
//
// 【事务只用 Put + 带条件的 Update】故意不使用 `ConditionCheck` 事务项:那一种要额外的
//   `dynamodb:ConditionCheckItem` 授权,而平台 TaskRole 现在只给到 Put/Update/Delete(见
//   infra/lib/platform-stack.ts 的 bgp-* 语句)。⚠️ 「TransactWriteItems 不需要独立 IAM 动作」
//   这一条本轮**只查到文档级说法、未在真环境坐实** ⇒ 判据 GC-3(造 100 张 + 并发)会当场证伪。
import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { ulid } from "ulid";
import { docClient, TABLES } from "@/lib/aws/dynamodb";

/** 每人可保留的会话卡片上限(用户 2026-09-12 原话:「每个人最多只能保留100个会话卡片」)。 */
export const CARD_LIMIT = 100;
/** 单张卡片的防滥用上限;超了**明确拒绝并说清超在哪**,绝不静默截断(§4.2)。 */
export const MAX_TURNS = 200;
export const MAX_BODY_BYTES = 20 * 1024 * 1024;
export const MAX_TITLE_LEN = 80;

export const CARD_SK_PREFIX = "card#";
export const QUOTA_SK = "quota#";
export const BY_CONVERSATION_INDEX = "byConversation";

export type CardState = "ready" | "deleting";

export interface CardBodyRef {
  bucket: string;
  key: string;
}

/** 中央指针行(**全部是非数据值**;字段清单 = 54 DESIGN §4.1)。 */
export interface CardPointer {
  cardId: string;
  conversationId: string;
  targetId: string;
  region: string;
  projectId: string;
  engine: string;
  turnCount: number;
  bytes: number;
  bodyRef: CardBodyRef;
  bodySha256: string;
  createdAt: string;
  updatedAt: string;
  state: CardState;
  // (问数)—— 卡片「刷新」的**非数据**戳(结果与快照仍在该区 S3)。
  //   🔴 字段名刻意避开 `assertNoDataValues` 拦的那些(rows / result / …):这里只有时间、状态、快照 id。
  /** 最近一次刷新完成的时刻(成功才盖)。 */
  lastRefreshedAt?: string;
  /** 最近一次刷新的结果(succeeded / failed)。 */
  lastRefreshStatus?: "succeeded" | "failed";
  /** 最近一次成功刷新的快照 id(该区 `genbi-cards/<sub>/<cardId>/runs/<id>.json`)。 */
  lastRefreshSnapshotId?: string;
  /** 刷新快照 id 清单(新 → 旧,最多 `CARD_REFRESH_SNAPSHOT_KEEP` 份;删卡时据此清理该区的快照对象)。 */
  refreshSnapshots?: string[];
  /** 累计成功刷新次数。 */
  refreshCount?: number;
}

/** 每张卡保留的刷新快照份数(超出的最旧那份当场删掉;不占 100 张卡片额度)。 */
export const CARD_REFRESH_SNAPSHOT_KEEP = 30;

/**
 * 指针入参。🔴🔴 **`cardId` 必须由调用方给**,本文件绝不自己生成 —— 2026-09-13 真环境首跑抓到的 P0:
 * 原来 `saveCard` 生成一个 `ulid()` 去写**正文的 key**,而这里又 `ulid()` 了**第二个**写指针
 * ⇒ 两个 id 永远不同 ⇒ 读正文恒 NoSuchKey ⇒ **每一张卡片都打不开**(`bodyMissing:true`)。
 * 一个概念两个作者,必然各自漂移;而两个模块的单测各自 mock 掉对方,**接缝从没被测过**
 * (93 条单测 + 60 个变异全绿,功能 100% 不可用)。
 * ⇒ 现在 `cardId` 是必填字段:漏传是**编译错误**,不是运行期悄悄产生第二个 id。
 *   顺序上它本来就必须先有:§7.1 规定「先写正文、后写指针」,而正文的 key 就是用它拼的。
 */
export type CardPointerInput = Omit<
  CardPointer,
  "createdAt" | "updatedAt" | "state" | "lastRefreshedAt" | "lastRefreshStatus" | "lastRefreshSnapshotId" | "refreshSnapshots" | "refreshCount"
>;

/** 配额已满。`used` 是**服务端读到的真实值**,让文案能说「100/100」而不是写死。 */
export class CardQuotaExceeded extends Error {
  readonly limit = CARD_LIMIT;
  constructor(readonly used: number) {
    super(`已保存 ${used}/${CARD_LIMIT} 张会话卡片,达到每人上限`);
    this.name = "CardQuotaExceeded";
  }
}

/**
 * 事务在**争抢**上反复失败(DynamoDB 的 `TransactionConflict`),已把重试预算用完。
 *
 * 🔴 与 `CardQuotaExceeded` 是两件完全不同的事,绝不许混:
 *   · `ConditionalCheckFailed` = **真实答案**(配额满 / id 已占)⇒ 立刻回用户,**不重试**;
 *   · `TransactionConflict`    = **可重试的瞬态争抢**(同一个 item 同时被写)⇒ 平台自己退避重试,
 *     用户不该看见。只有预算用完才抛本类型,并由路由映射成 **503 + Retry-After**,
 *     文案要说清「这是平台侧繁忙、已自动重试 N 次」——**不是**让用户自己去重试 N+1 次。
 */
export class CardStoreContended extends Error {
  constructor(
    readonly attempts: number,
    readonly op: string
  ) {
    super(`保存卡片时与并发写入反复冲突(${op};已自动重试 ${attempts} 次)—— 这是平台侧的瞬态争抢,请稍后再试一次`);
    this.name = "CardStoreContended";
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// 🔴🔴 **争抢重试预算必须是「推导出来的」,不是拍一个数**(2026-09-21 第五轮全量硬门 GC-3a 实测)。
//
// 【实测形态】判据并发(8 路)造满 100 张:配额精确到 100/100、第 101 次 409 —— **正确性是对的**;
// 但并发批里冒出一个 **503**(`CardStoreContended`),判据要求 5xx 恒 0。
//
// 【为什么原来那版必然会漏】两处,而**第二处才是根因**:
//   ① 预算是一个**拍出来的** `6` 次:base 40ms × 2^n、上限 800ms ⇒ 总退避只有 ~1.2s,
//      而配额计数器是**按人的单个 item**、写者要排队被排空;
//   ② 🔴 退避是 `base * 2**(n-1) * (0.5 + random())` —— 抖动只有 ±50%,
//      **所有写者的重试落在几乎同一个窗口里**,于是它们继续互撞(thundering herd)。
//      光把 ① 的次数调大治不了它:相关的重试再多次也还是一起撞。
//
// 【根治】
//   · 退避改 **full jitter**(`random() * cap`,AWS 官方退避建议)—— 把重试时刻**去相关**;
//   · 次数由**最坏并发**推导:同一个人最多只能有 `CARD_LIMIT` 张卡 ⇒ 撞这个单 item 的写者数
//     天然以它为界(超了就是 409 立刻返回、不重试)。预算 = 最坏并发 × 单次事务耗时上限。
//   · 🔴 仍然**有界**:预算用完照旧抛 `CardStoreContended` → 503 + Retry-After。
//     无界重试的故障形态是「请求挂住」,比 503 更坏。
// ══════════════════════════════════════════════════════════════════════════════

/** 最坏并发写者数 —— 配额计数器是**按人**的单个 item,而一个人最多 `CARD_LIMIT` 张卡。 */
const CONTENTION_WORST_CASE_WRITERS = CARD_LIMIT;
/** 单次 `TransactWriteItems` 在争抢下的保守耗时上限(实测 10~30ms,取上限)。 */
const CONTENTION_PER_WRITE_MS = 30;
/** 必须撑到「最坏排队被排空」:预算 = 最坏并发 × 单次耗时。 */
export const CONTENTION_BUDGET_MS = CONTENTION_WORST_CASE_WRITERS * CONTENTION_PER_WRITE_MS;
const CONTENTION_BASE_DELAY_MS = 40;
const CONTENTION_MAX_DELAY_MS = 800;

/**
 * 重试次数**由预算推导**(不是字面量)。
 * 🔴 按 full jitter 的**期望值 = 上限的一半**折算,取悲观侧 —— 否则「平均够用」在尾部仍然不够,
 *    而 503 恰恰只在尾部出现(实测:100 次里就那一次)。
 */
export const CONTENTION_MAX_ATTEMPTS = (() => {
  let acc = 0;
  let n = 0;
  while (acc < CONTENTION_BUDGET_MS) {
    acc += Math.min(CONTENTION_BASE_DELAY_MS * 2 ** n, CONTENTION_MAX_DELAY_MS) / 2;
    n += 1;
  }
  return n + 1; // +1 = 第一次尝试本身(它不消耗退避)
})();

/** 这次取消里**是否只**含可重试的争抢(有任何一项是 ConditionalCheckFailed ⇒ 那是答案,不许重试)。 */
export function isRetryableTransactionConflict(e: unknown): boolean {
  if (!(e instanceof TransactionCanceledException)) return false;
  const reasons = e.CancellationReasons ?? [];
  const codes = reasons.map((r) => r?.Code).filter((c): c is string => !!c && c !== "None");
  if (!codes.length) return false;
  // 🔴 只要掺了一条 ConditionalCheckFailed,就说明这次取消里含**确定性**结论(满额 / 撞 id)⇒ 不重试。
  return codes.every((c) => c === "TransactionConflict");
}

/**
 * 把「可重试的争抢」吸收在平台内部:抖动退避、有界重试。
 * 🔴 只重试 `TransactionConflict`;`ConditionalCheckFailed` 是答案,原样上抛(重试它 = 把满额拖成超时)。
 * 🔴 有界:预算用完抛 `CardStoreContended`,绝不无限重试(无限重试的故障形态是「请求挂住」)。
 */
async function withContentionRetry<T>(op: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!isRetryableTransactionConflict(e)) throw e;
      if (attempt >= CONTENTION_MAX_ATTEMPTS) throw new CardStoreContended(attempt, op);
      // 🔴 **full jitter**:`random() * cap`,而**不是**「指数点 ±50%」。
      //   上一版 `base * 2**(n-1) * (0.5 + random())` 的抖动只有 ±50% ⇒ 并发写者的重试
      //   落在几乎同一个窗口里、继续互撞(thundering herd),再多试几次也一样撞
      //   —— 2026-09-21 GC-3a 实测:8 路并发下就有一个写者把预算全撞光、吃到 503。
      const cap = Math.min(CONTENTION_BASE_DELAY_MS * 2 ** (attempt - 1), CONTENTION_MAX_DELAY_MS);
      await new Promise((r) => setTimeout(r, Math.random() * cap));
    }
  }
}

/** 输入形态非法(轮数 / 字节 / 标题 / 混进了数据值)。拒绝时必须说清**哪一项**超了多少。 */
export class CardInputInvalid extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = "CardInputInvalid";
  }
}

// 🔴 数据值黑名单:这些键**只允许出现在区域正文**里。放在写入通道上做,而不是靠 code review ——
//    「顺手把 answer 也存进指针方便列表显示」是这类设计最自然的退化方向。
// 🔴 `title` 也在黑名单里(用户拍板「标题也留区」)—— 让「顺手把标题存进指针方便列表显示」
//    这个最自然的退化方向**写不出来**,而不是靠 code review 拦。
const DATA_VALUE_KEYS = ["rows", "columns", "answer", "sql", "steps", "result", "turns", "chart", "usedContext", "matchedTables", "title"] as const;

export function assertNoDataValues(obj: Record<string, unknown>, where: string): void {
  const hit = DATA_VALUE_KEYS.filter((k) => k in obj);
  if (hit.length) {
    throw new CardInputInvalid(
      `${where} 里出现了数据值字段 ${hit.join(" / ")} —— 中央指针表只存非数据值,` +
        `结果行 / SQL / 结论 / 推理必须落该 target 本区的 S3(54 DESIGN §3.1)`
    );
  }
}

export function cardKey(userSub: string, cardId: string) {
  return { pk: userSub, sk: `${CARD_SK_PREFIX}${cardId}` };
}
export function quotaKey(userSub: string) {
  return { pk: userSub, sk: QUOTA_SK };
}

function assertInput(input: CardPointerInput): void {
  assertNoDataValues(input as unknown as Record<string, unknown>, "CardPointerInput");
  // 🔴 标题**不在这里校验**:它压根不进这张表(拍板「标题也留区」)⇒ 校验归区域侧 `cards-body-store`。
  // 🔴 cardId 是**正文对象 key 的一部分**:它一空,指针就指向一个读不回来的位置。
  if (!input.cardId) throw new CardInputInvalid("缺 cardId —— 它必须与写正文时用的**同一个** id(指针不许自己另生成一个)");
  if (!input.conversationId) throw new CardInputInvalid("缺 conversationId(它是同一段对话重复保存的幂等键)");
  if (!input.targetId || !input.region) throw new CardInputInvalid("缺 targetId / region —— 落点是必填,绝不回落主控区");
  if (!input.bodyRef?.bucket || !input.bodyRef?.key) throw new CardInputInvalid("缺 bodyRef(区域正文对象);指针不许指向空");
  if (!Number.isInteger(input.turnCount) || input.turnCount < 1) throw new CardInputInvalid("turnCount 必须是 ≥1 的整数");
  if (input.turnCount > MAX_TURNS) {
    throw new CardInputInvalid(`这段对话有 ${input.turnCount} 轮,超过单卡上限 ${MAX_TURNS} 轮(超出 ${input.turnCount - MAX_TURNS} 轮)`);
  }
  if (!Number.isFinite(input.bytes) || input.bytes < 0) throw new CardInputInvalid("bytes 非法");
  if (input.bytes > MAX_BODY_BYTES) {
    const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
    throw new CardInputInvalid(`这段对话正文 ${mb(input.bytes)}MB,超过单卡上限 ${mb(MAX_BODY_BYTES)}MB(超出 ${mb(input.bytes - MAX_BODY_BYTES)}MB)`);
  }
}

/** 读当前已用张数(缺行 = 0)。 */
export async function readQuota(userSub: string): Promise<number> {
  const { Item } = await docClient.send(new GetCommand({ TableName: TABLES.GENBI_CARDS, Key: quotaKey(userSub), ConsistentRead: true }));
  const n = Item?.n;
  return typeof n === "number" ? n : 0;
}

/** 幂等查:这段对话是不是已经存过一张卡(GSI byConversation;`deleting` 的不算,它在往外走)。 */
export async function findCardByConversation(userSub: string, conversationId: string): Promise<CardPointer | null> {
  const { Items = [] } = await docClient.send(
    new QueryCommand({
      TableName: TABLES.GENBI_CARDS,
      IndexName: BY_CONVERSATION_INDEX,
      KeyConditionExpression: "pk = :u AND conversationId = :c",
      ExpressionAttributeValues: { ":u": userSub, ":c": conversationId },
    })
  );
  const ready = (Items as CardPointer[]).filter((x) => x.state === "ready");
  return ready[0] ?? null;
}

export async function getCardPointer(userSub: string, cardId: string): Promise<CardPointer | null> {
  const { Item } = await docClient.send(new GetCommand({ TableName: TABLES.GENBI_CARDS, Key: cardKey(userSub, cardId) }));
  return (Item as CardPointer | undefined) ?? null;
}

/** 我的卡片(含 `deleting` 的 —— 清理未完成必须**可见**,「残留可见」口径)。 */
export async function listCardPointers(userSub: string): Promise<CardPointer[]> {
  const { Items = [] } = await docClient.send(
    new QueryCommand({
      TableName: TABLES.GENBI_CARDS,
      KeyConditionExpression: "pk = :u AND begins_with(sk, :p)",
      ExpressionAttributeValues: { ":u": userSub, ":p": CARD_SK_PREFIX },
    })
  );
  return (Items as CardPointer[]).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

/**
 * 保存 / 更新一段对话的指针。
 *  · 同 `conversationId` 已有 ready 卡片 ⇒ **更新它**,`created:false`,**配额不动**;
 *  · 否则 ⇒ 事务(Put 指针 + `ADD n 1` 且条件 `n < 100`),条件不满足抛 `CardQuotaExceeded`。
 * 🔴 调用方必须**先写好区域正文再调本函数**;本函数抛 `CardQuotaExceeded` 时调用方负责把刚写的正文删掉
 *    (§7.1 的补偿),否则会留孤儿对象。
 */
export async function saveCardPointer(userSub: string, input: CardPointerInput): Promise<{ cardId: string; created: boolean; used: number }> {
  if (!userSub) throw new CardInputInvalid("缺 userSub(身份必须是 Cognito sub,不是用户名)");
  assertInput(input);
  const now = new Date().toISOString();

  const existing = await findCardByConversation(userSub, input.conversationId);
  if (existing) {
    await docClient.send(
      new UpdateCommand({
        TableName: TABLES.GENBI_CARDS,
        Key: cardKey(userSub, existing.cardId),
        UpdateExpression:
          "SET turnCount = :n, #b = :b, bodyRef = :r, bodySha256 = :h, updatedAt = :u, targetId = :tid, #reg = :reg, projectId = :p, engine = :e",
        ConditionExpression: "attribute_exists(pk) AND #st = :ready",
        ExpressionAttributeNames: { "#b": "bytes", "#reg": "region", "#st": "state" },
        ExpressionAttributeValues: {
          ":n": input.turnCount, ":b": input.bytes, ":r": input.bodyRef,
          ":h": input.bodySha256, ":u": now, ":tid": input.targetId, ":reg": input.region,
          ":p": input.projectId, ":e": input.engine, ":ready": "ready",
        },
      })
    );
    return { cardId: existing.cardId, created: false, used: await readQuota(userSub) };
  }

  const cardId = input.cardId;
  const item: CardPointer & { pk: string; sk: string } = {
    ...cardKey(userSub, cardId),
    cardId,
    conversationId: input.conversationId,
    targetId: input.targetId,
    region: input.region,
    projectId: input.projectId,
    engine: input.engine,
    turnCount: input.turnCount,
    bytes: input.bytes,
    bodyRef: input.bodyRef,
    bodySha256: input.bodySha256,
    createdAt: now,
    updatedAt: now,
    state: "ready",
  };
  try {
    // 🔴 争抢由平台吸收(见 withContentionRetry);`ConditionalCheckFailed` 仍原样上抛 —— 它是答案。
    await withContentionRetry("保存卡片指针", () => docClient.send(
      new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: TABLES.GENBI_CARDS, Item: item, ConditionExpression: "attribute_not_exists(pk)" } },
          {
            Update: {
              TableName: TABLES.GENBI_CARDS,
              Key: quotaKey(userSub),
              UpdateExpression: "ADD #n :one",
              // 🔴 上限就在这一行。缺行(第一张)也要放行 ⇒ attribute_not_exists 与 `< limit` 并列。
              ConditionExpression: "attribute_not_exists(#n) OR #n < :limit",
              ExpressionAttributeNames: { "#n": "n" },
              ExpressionAttributeValues: { ":one": 1, ":limit": CARD_LIMIT },
            },
          },
        ],
      })
    ));
  } catch (e) {
    if (e instanceof TransactionCanceledException) {
      // 事务被取消:区分「配额满」与其它(cardId 撞了 = ulid 碰撞,理论上不会发生但不许当成满额)。
      const reasons = e.CancellationReasons ?? [];
      const quotaFailed = reasons[1]?.Code === "ConditionalCheckFailed";
      if (quotaFailed) throw new CardQuotaExceeded(await readQuota(userSub));
    }
    throw e;
  }
  return { cardId, created: true, used: await readQuota(userSub) };
}

/**
 * 删卡第一段的结果。**三态而不是布尔** —— 变异测试逼出来的:
 *  · `released`     正常释放;
 *  · `not-ready`    卡片不存在 / 已在 deleting ⇒ 幂等,什么都没动;
 *  · `quota-broken` 卡片是 ready **但计数器已经是 0 / 缺失**(计数器行与指针行是两个 item,历史脏数据、
 *                   人工修过、迁移中断都能造出这种不一致)。此时防扣穿条件会让整个事务取消 ——
 *                   🔴 若只回布尔,调用方分不清「已经删过」和「计数器坏了」,后者会变成**永远删不掉的卡**。
 *                   调用方应对 `quota-broken` 走 `reconcileQuota()` 再重试一次(自愈),而不是把用户卡死。
 */
export type ReleaseResult = "released" | "not-ready" | "quota-broken";

/**
 * 删卡第一段:指针置 `deleting` + **额度立刻释放**(用户视角马上空出一格,§7.3)。
 * 幂等:卡片不存在 / 已是 deleting ⇒ 回 `not-ready`,不重复扣减(扣穿会让「已用」比真实少)。
 */
export async function releaseCardQuota(userSub: string, cardId: string): Promise<ReleaseResult> {
  try {
    // 🔴 删卡同样会撞计数器(同一个人一次删多张 / 双击)⇒ 同一条争抢纪律。
    await withContentionRetry("释放卡片额度", () => docClient.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLES.GENBI_CARDS,
              Key: cardKey(userSub, cardId),
              UpdateExpression: "SET #st = :deleting, updatedAt = :u",
              ConditionExpression: "attribute_exists(pk) AND #st = :ready",
              ExpressionAttributeNames: { "#st": "state" },
              ExpressionAttributeValues: { ":deleting": "deleting", ":ready": "ready", ":u": new Date().toISOString() },
            },
          },
          {
            Update: {
              TableName: TABLES.GENBI_CARDS,
              Key: quotaKey(userSub),
              UpdateExpression: "ADD #n :minusOne",
              // 🔴 绝不扣穿:没有这条,一次重复删除就能把计数器扣成负数,「已用 -1/100」比崩溃更难查。
              ConditionExpression: "#n > :zero",
              ExpressionAttributeNames: { "#n": "n" },
              ExpressionAttributeValues: { ":minusOne": -1, ":zero": 0 },
            },
          },
        ],
      })
    ));
    return "released";
  } catch (e) {
    if (e instanceof TransactionCanceledException) {
      const r = e.CancellationReasons ?? [];
      // reasons[0] = 指针项(state must be ready)· reasons[1] = 计数器项(n > 0)。
      // 顺序与 TransactItems 一一对应;两项都失败时以「卡片状态」为准(它是更根本的原因)。
      if (r[0]?.Code === "ConditionalCheckFailed") return "not-ready";
      if (r[1]?.Code === "ConditionalCheckFailed") return "quota-broken";
      return "not-ready";
    }
    throw e;
  }
}

/** 删卡第二段:区域正文清干净之后,把指针本身删掉(清理失败就**保留** `deleting` 指针 ⇒ 残留可见)。 */
export async function deleteCardPointer(userSub: string, cardId: string): Promise<void> {
  await docClient.send(new DeleteCommand({ TableName: TABLES.GENBI_CARDS, Key: cardKey(userSub, cardId) }));
}

/** 仅供修复流程:把计数器重置成真实的 ready 张数(**不是**常规路径,写在这里是为了不让别人临时手搓一份)。 */
export async function reconcileQuota(userSub: string): Promise<number> {
  const n = (await listCardPointers(userSub)).filter((c) => c.state === "ready").length;
  await docClient.send(
    new PutCommand({ TableName: TABLES.GENBI_CARDS, Item: { ...quotaKey(userSub), n, reconciledAt: new Date().toISOString() } })
  );
  return n;
}

// (问数)
/**
 * 刷新成功后的指针回写(**唯一作者**:`cards-refresh.ts` 调它)。
 * 正文已原地改写(字节数 / 摘要随之变化)+ 新快照入清单;🔴 条件写:卡片必须仍是 ready
 * (刷新途中被删 ⇒ 抛 ConditionalCheckFailed,调用方据此清掉刚写的快照,不留孤儿)。
 * 🔴 不碰配额:刷新是**同一张卡**的新版本,不是新卡。
 */
export async function stampCardRefresh(
  userSub: string,
  cardId: string,
  v: { bytes: number; bodySha256: string; refreshedAt: string; snapshotId: string; snapshots: string[]; refreshCount: number }
): Promise<void> {
  assertNoDataValues(v as unknown as Record<string, unknown>, "stampCardRefresh");
  await docClient.send(
    new UpdateCommand({
      TableName: TABLES.GENBI_CARDS,
      Key: cardKey(userSub, cardId),
      UpdateExpression:
        "SET #b = :b, bodySha256 = :h, lastRefreshedAt = :t, lastRefreshStatus = :ok, lastRefreshSnapshotId = :sid, refreshSnapshots = :list, refreshCount = :n, updatedAt = :t",
      ConditionExpression: "attribute_exists(pk) AND #st = :ready",
      ExpressionAttributeNames: { "#b": "bytes", "#st": "state" },
      ExpressionAttributeValues: {
        ":b": v.bytes, ":h": v.bodySha256, ":t": v.refreshedAt, ":ok": "succeeded",
        ":sid": v.snapshotId, ":list": v.snapshots, ":n": v.refreshCount, ":ready": "ready",
      },
    })
  );
}

/** 刷新失败的指针回写(只改状态,不动正文戳;卡片已不是 ready ⇒ 静默跳过 —— 失败本身已进 run 台账)。 */
export async function stampCardRefreshFailed(userSub: string, cardId: string): Promise<void> {
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: TABLES.GENBI_CARDS,
        Key: cardKey(userSub, cardId),
        UpdateExpression: "SET lastRefreshStatus = :f",
        ConditionExpression: "attribute_exists(pk) AND #st = :ready",
        ExpressionAttributeNames: { "#st": "state" },
        ExpressionAttributeValues: { ":f": "failed", ":ready": "ready" },
      })
    );
  } catch (e) {
    if ((e as { name?: string })?.name !== "ConditionalCheckFailedException") throw e;
  }
}
