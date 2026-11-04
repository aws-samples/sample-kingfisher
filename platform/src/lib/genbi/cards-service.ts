// @kf-batch 54-genbi-session-cards
// 会话卡片四个动作(保存 / 打开 / 续聊 / 删除)的**编排层**:路由只做取参与出参,业务顺序全在这里。
// 合同 = 54 DESIGN v1.3 §5(接口)/ §7(执行流程)。
//
// 【为什么单独一层】这四个动作各自要按固定顺序穿过三道机制(落点解析 → 驻留门 → 区域正文 ↔ 中央指针),
// 顺序错了就会出「列表里有、打开报错」或「额度扣了、卡片还在」。把顺序写在路由里 = 四份副本各自漂移。
//
// 🔴 **「能不能看」与「能不能承接」在这里分开**(记忆 `scope-view-vs-serviceable-lesson`,犯过两次):
//   · 保存 / 续聊 = 要往那个区写、要在那个区跑 ⇒ `requireReadyTarget()`(可承接,fail-closed);
//   · 打开(只读)= 只要**看得见** ⇒ `getTargetRaw()`(不做可用性过滤)。
//   用「能不能承接」去判「能不能看」的后果是:装好的区一旦 draining,用户的卡片就从列表里消失/打不开。
import { getTargetRaw, requireReadyTarget } from "@/lib/exec-env/registry";
import { isHome } from "@/lib/exec-env/target-id";
import { residencyAudit, auditActorOrService } from "@/lib/exec-env/residency-audit";
import type { ResidencyActor } from "@/lib/exec-env/residency-audit";
import { maskRows } from "@/lib/governance/masking";
import { GENBI } from "@/lib/genbi/config";
import type { Identity } from "@/lib/auth/identity";
import { replaceConversation } from "@/lib/genbi/memory";
import {
  CARD_LIMIT, CardInputInvalid, CardQuotaExceeded, deleteCardPointer, getCardPointer,
  listCardPointers, readQuota, reconcileQuota, releaseCardQuota, saveCardPointer,
} from "@/lib/genbi/cards-store";
import type { CardPointer } from "@/lib/genbi/cards-store";
import {
  CARD_BODY_VERSION, CardBodyUnreadable, deleteCardBody, getCardBody, getCardHead, putCardBody,
} from "@/lib/genbi/cards-body-store";
import type { CardBody, CardBodyTurn } from "@/lib/genbi/cards-body-store";
import { ulid } from "ulid";

export { CARD_LIMIT, CardQuotaExceeded, CardInputInvalid, CardBodyUnreadable };

/** 卡片正文相关的**区域侧存储**不可用(描述符缺资源 / 该区读写失败)。🔴 绝不回落主控区。 */
export class CardStoreUnavailable extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = "CardStoreUnavailable";
  }
}

/** 卡片不存在 / 不属于这个人。🔴 两种情况**同一个** 404:403 会泄露「这个 cardId 存在」。 */
export class CardNotFound extends Error {
  constructor(readonly cardId: string) {
    super(`卡片不存在:${cardId}`);
    this.name = "CardNotFound";
  }
}

export interface SaveCardInput {
  userSub: string;
  userName?: string;
  identity: Identity | null;
  projectId: string;
  targetId: string;
  engine: string;
  /** 执行时所用的库名(重脱敏要靠它拼 FQN;缺了会让重脱敏变 no-op ⇒ 见 CardBody.database)。 */
  database?: string;
  conversationId: string;
  title: string;
  turns: CardBodyTurn[];
}

/**
 * 保存 / 更新一张卡片。顺序见 54 DESIGN §7.1 —— **先正文、后指针**:
 * 反过来会出现「列表里有、打开报错」;先正文失败最多留一个孤儿对象(由本函数的补偿 + 清理兜住)。
 */
export async function saveCard(input: SaveCardInput): Promise<{ cardId: string; created: boolean; used: number; limit: number }> {
  const { userSub, projectId, targetId, engine, conversationId, title, turns } = input;
  if (!Array.isArray(turns) || turns.length === 0) throw new CardInputInvalid("这段对话还没有任何一轮问答,没有可保存的内容");
  // 🔴 **写入侧必填,不给静默默认值**(记忆:「有静默合法默认值的参数」= 一整类缺陷的温床)。
  //    少了它,这张卡片以后每次打开的重脱敏都拼不出 FQN ⇒ 永久放行明文,而且没人会发现。
  //    读取侧对**本次修复之前**存的老卡片保留回落(见重脱敏段)——那是兼容,不是默认值。
  if (!input.database) {
    throw new CardInputInvalid("缺 database(执行时所用的库名)—— 打开卡片时要按当前数据分级重新脱敏,没有库名就拼不出表的 FQN,脱敏会静默失效");
  }

  // ① 落点:保存要往那个区**写** ⇒ 必须可承接(fail-closed,不可用即抛)
  const target = await requireReadyTarget(targetId);

  // ② 跨法域 ⇒ 先过驻留门(同意前置 + 区域审计)。🔴 **写不成就拒绝保存**,不 best-effort ——
  //    卡片是用户主动资产,静默失败不可接受(这与 `recordGenBiHistory` 那条旁路的口径**相反**,是故意的)。
  //    entry 复用既有闭合词表里的 `result`(卡片正文就是「结果的留存」);要区分是哪种留存看 `triggeredBy`。
  const actor: ResidencyActor = auditActorOrService({ identity: input.identity as Identity, authKind: "cognito-user-jwt" }).actor;
  await residencyAudit({
    actor,
    targetId,
    entry: "result",
    triggeredBy: "genbi-card-save",
    projectId,
    sqlText: turns.map((t) => (t.result as { sql?: string } | null)?.sql || "").filter(Boolean).join("\n;\n") || undefined,
    knownJurisdiction: isHome(targetId) ? "home" : undefined,
  });

  // ③ 正文落该区(cardId 先生成:正文的 key 要用它)。已有同对话的卡 ⇒ 沿用它的 cardId,正文原地覆盖。
  const existingByConv = (await listCardPointers(userSub)).find((c) => c.conversationId === conversationId && c.state === "ready");
  const cardId = existingByConv?.cardId ?? ulid();
  const body: CardBody = {
    v: CARD_BODY_VERSION,
    cardId,
    conversationId,
    targetId,
    projectId,
    engine,
    ...(input.database ? { database: input.database } : {}),
    title: (title || "").trim(),
    savedAt: new Date().toISOString(),
    savedBy: { sub: userSub, name: input.userName },
    turns,
  };
  let put;
  try {
    put = await putCardBody(target, userSub, body);
  } catch (e) {
    if (e instanceof CardBodyUnreadable) throw e;
    throw new CardStoreUnavailable(
      `这段对话的正文要保存在 ${targetId}(${target.region ?? "?"})的本区存储,但写入失败:${String(e)}` +
        `。🔴 平台不会把它改存到主控区 —— 那等于把该区域的数据搬走。`
    );
  }

  // ④ 中央指针 + 配额(同一次事务)。满额 ⇒ **把刚写的正文删掉**再抛,不留孤儿。
  try {
    const r = await saveCardPointer(userSub, {
      // 🔴 **同一个 cardId**:正文的 key 就是用它拼的(上一步 putCardBody)。
      //    这里若不传、由 store 自己生成,指针与正文就会指向两个不同的位置 —— 2026-09-13 的 P0。
      cardId,
      conversationId, targetId, region: put.region, projectId, engine,
      turnCount: turns.length, bytes: put.bytes,
      bodyRef: { bucket: put.bucket, key: put.key }, bodySha256: put.sha256,
    });
    return { ...r, limit: CARD_LIMIT };
  } catch (e) {
    // 🔴🔴 **补偿必须覆盖指针写入的每一种失败**,不只是「满额」(2026-09-13 真环境暴露)。
    //    §7.1 的顺序是「先正文、后指针」;指针写失败时正文已经躺在该区的桶里。
    //    改动前只在 `CardQuotaExceeded` 时补偿 ⇒ 并发争抢(TransactionConflict,实测 100 次里 3 次)
    //    每发生一次就**静默留下一个孤儿正文对象**,而且永远没人会发现(没有指针指向它)。
    //    条件只有一个:这是**新卡**(`!existingByConv`)。重存已有卡时那份正文是它自己的,不许删。
    if (!existingByConv) {
      // 新卡从没刷新过 ⇒ 没有快照(显式 `[]`)
      const cleaned = await deleteCardBody(target, userSub, cardId, []).catch(() => false);
      if (!cleaned) {
        // 删不掉就**说出来**(留残留可见);绝不吞成「什么都没发生」。
        console.error(
          "[genbi/cards-service] 指针写入失败后补偿删除正文也失败,已留下孤儿对象:s3://%s/%s(原因:%s)",
          put.bucket, put.key, String(e)
        );
      }
    }
    throw e;
  }
}

export interface OpenCardResult {
  pointer: CardPointer;
  body: CardBody;
  /** 本次打开**按当前数据分级**新隐去的列(存的时候是明文,现在不是了)。 */
  maskedNow: string[];
  /** 正文对象已不在该区(桶被销毁 / 被外部删掉)⇒ 页面要说人话,并允许删卡。 */
  bodyMissing: boolean;
}

/**
 * 打开一张卡片(只读)。
 * 🔴 用 `getTargetRaw()` 而不是 `requireReadyTarget()`:**看**不需要那个区能承接新工作。
 * 🔴 取回正文后**按当前分级重新脱敏**,与存的取更严者 —— 否则卡片就是一个绕过数据分级的后门
 *    (存的时候有权限看明文、后来权限/分级变了,旧卡片不该继续给明文)。
 */
export async function openCard(userSub: string, cardId: string, identity: Identity | null): Promise<OpenCardResult> {
  const pointer = await getCardPointer(userSub, cardId);
  if (!pointer) throw new CardNotFound(cardId);
  const target = await getTargetRaw(pointer.targetId);
  if (!target) {
    throw new CardStoreUnavailable(
      `这张卡片属于执行环境 ${pointer.targetId},而它已不在注册表里(已删除)⇒ 正文读不到。可以删掉这张卡片释放额度。`
    );
  }
  let body: CardBody | null;
  try {
    body = await getCardBody(target, userSub, cardId);
  } catch (e) {
    if (e instanceof CardBodyUnreadable) throw e;
    // 🔴 AccessDenied / 网络错**不当成「没有」**(cards-body-store 已经原样上抛),这里只加一句人话。
    // @kf-batch 50-WP26b-region-derive
    // 🔴🔴 region 一律从**活的 target** 派生,存下来的那份只作回落。
    //   2026-09-20 截图铁证:`读取 tgt_euw1_a(us-west-2)的卡片正文失败…` —— 而 `tgt_euw1_a` 在
    //   **eu-west-1**。原因是这里拼的是 `pointer.region`(保存那一刻写进指针的**快照**,见上面第 127 行)。
    //   两者一旦不一致,这句话就**把一个区的东西说成另一个区** —— 而「界面说错区」是本项目反复
    //   出事的那一族(记忆 stale-response-race-shows-wrong-region:同一个毛病改了三刀才到根)。
    //   🔴 同一个文件下面第 248 行**早就做对了**(`target.region ?? opened.pointer.region`)——
    //     一处对一处错,正是「同一件事两个作者」;这里跟上去。
    //   注:`target` 就在作用域里(上面刚 `getTargetRaw` 过),不需要多一次查询。
    const liveRegion = String((target as { region?: unknown }).region ?? pointer.region ?? "?");
    throw new CardStoreUnavailable(`读取 ${pointer.targetId}(${liveRegion})的卡片正文失败:${String(e)}`);
  }
  if (!body) {
    return { pointer, body: emptyBody(pointer, userSub), maskedNow: [], bodyMissing: true };
  }
  const maskedNow = new Set<string>();
  for (const t of body.turns) {
    const r = t.result as { columns?: string[]; rows?: unknown[][]; maskedColumns?: string[]; sql?: string | null } | null;
    if (!r || !Array.isArray(r.columns) || !Array.isArray(r.rows)) continue;
    const before = new Set(r.maskedColumns || []);
    // 🔴🔴 `sql` + `database` **必须**传进去(2026-09-13 修的真缺口):`maskRows` 是先从
    //    列元数据 / SQL 解析出「这次涉及哪些表」,再去查那些表的分级;两样都不给 ⇒ 参考表集合为空
    //    ⇒ 它在第一个分支就 `return passthrough` ⇒ **重脱敏恒为 no-op、卡片直接给明文**。
    //    平台里其它三个调用点(直查结果 / BI 查询 / 问数执行)一直都传这两样,只有卡片这条漏了。
    const out = await maskRows({
      columns: r.columns.map((name) => ({ name })),
      rows: r.rows,
      sql: r.sql || undefined,
      // 老卡片没存 database ⇒ 回落平台默认库(与问数执行同一个默认值),而不是放弃脱敏。
      database: body.database || GENBI.database,
      identity,
    });
    r.rows = out.rows as unknown[][];
    const union = new Set<string>(Array.from(before).concat(out.maskedColumns));
    for (const c of out.maskedColumns) if (!before.has(c)) maskedNow.add(c);
    r.maskedColumns = Array.from(union); // 取更严者:两次脱敏的并集
  }
  return { pointer, body, maskedNow: Array.from(maskedNow), bodyMissing: false };
}

function emptyBody(p: CardPointer, userSub: string): CardBody {
  return {
    v: CARD_BODY_VERSION, cardId: p.cardId, conversationId: p.conversationId, targetId: p.targetId,
    projectId: p.projectId, engine: p.engine,
    // 🔴 标题只在区域侧 ⇒ 正文读不到时它也读不到。给空串而**不是**编一个,页面据此显示占位。
    title: "", savedAt: p.createdAt,
    savedBy: { sub: userSub }, turns: [],
  };
}

/**
 * 打开续聊:用卡片正文**覆盖式重建**短期记忆,并把「该切到哪个 target」告诉页面。
 * 🔴 续聊要在那个区**跑** ⇒ 这里用 `requireReadyTarget()`(可承接);不可承接就抛,
 *    页面据此只给「只读查看」(50 INTERACTION §9.7 第 7 条)。
 * 🔴 本接口**不改执行范围** —— 切区是页面征得用户同意后自己做的(§9.7 第 1 条:绝不静默切换)。
 */
export async function resumeCard(
  userSub: string,
  cardId: string,
  identity: Identity | null
): Promise<{ conversationId: string; targetId: string; region: string; rehydratedTurns: number; skipped: boolean }> {
  const opened = await openCard(userSub, cardId, identity);
  if (opened.bodyMissing) throw new CardStoreUnavailable("这张卡片的正文已不在该区域,无法继续对话(可以删掉它释放额度)");
  const target = await requireReadyTarget(opened.pointer.targetId);
  const r = await replaceConversation(
    opened.pointer.conversationId,
    opened.body.turns.map((t) => ({
      question: t.question,
      answer: String((t.result as { answer?: string } | null)?.answer ?? ""),
      sql: ((t.result as { sql?: string | null } | null)?.sql) ?? null,
    })),
    opened.pointer.projectId
  );
  return {
    conversationId: opened.pointer.conversationId,
    targetId: opened.pointer.targetId,
    region: String(target.region ?? opened.pointer.region),
    rehydratedTurns: r.written,
    skipped: r.skipped,
  };
}

/**
 * 删卡(两段式,§7.3):置 `deleting` + **额度立刻释放** → 删该区正文 → 删指针。
 * 清理失败 ⇒ 指针留成 `deleting`,列表里出现「清理未完成 · 重试」(残留可见,WP-11a 口径)。
 */
/** 删卡结果。`bodyOrphaned` 非空 = 该区正文**再也清不掉了**(见 deleteCard 的终态分支)。 */
export interface DeleteCardResult {
  deleted: boolean;
  bodyCleaned: boolean;
  /**
   * 🔴 **终态孤儿**:卡片所属的执行环境已**不在注册表里** ⇒ 平台永远够不到那个区的正文。
   * 非空时指针已被删除(不再挂在用户名下),而这条信息交由路由写审计 —— 让**能处置的人**看得到。
   */
  bodyOrphaned?: { targetId: string; bucket: string; key: string };
  used: number;
  limit: number;
}

export async function deleteCard(userSub: string, cardId: string): Promise<DeleteCardResult> {
  const pointer = await getCardPointer(userSub, cardId);
  if (!pointer) throw new CardNotFound(cardId);

  let rel = await releaseCardQuota(userSub, cardId);
  if (rel === "quota-broken") {
    // 计数器与指针漂移过 ⇒ 对账后重试一次,别把用户卡死在一张永远删不掉的卡上。
    await reconcileQuota(userSub);
    rel = await releaseCardQuota(userSub, cardId);
  }
  // `not-ready` = 本来就在 deleting(重复点删除)⇒ 继续做清理那一半,幂等。

  const target = await getTargetRaw(pointer.targetId);
  if (!target) {
    // 🔴🔴 **终态,不是可重试**(2026-09-13 真环境撞到):执行环境已从注册表删除 ⇒ 平台**永远**
    //    够不到那个区的正文,「清理未完成 · 重试」这条路重试一万次也不会成。
    //    改动前这里回 `bodyCleaned=false` 并**保留** `deleting` 指针 ⇒ 那一行永久卡在用户的卡片集合里,
    //    而额度早已释放 ⇒ 留着它对用户只有害处(他既删不掉、也做不了任何事)。
    //    ⇒ 指针删掉(用户的列表恢复诚实),孤儿信息交给**能处置的人**(路由写审计 + 服务端日志)。
    //    这与「删项目不许悄悄留着」是同一条:残留要给**看得懂又动得了**的那一方看,不是给终端用户看。
    console.error(
      "[genbi/cards-service] 卡片所属执行环境已不在注册表,该区正文成为终态孤儿:target=%s s3://%s/%s(card=%s user=%s)",
      pointer.targetId, pointer.bodyRef?.bucket, pointer.bodyRef?.key, cardId, userSub
    );
    await deleteCardPointer(userSub, cardId);
    return {
      deleted: true,
      bodyCleaned: false,
      bodyOrphaned: { targetId: pointer.targetId, bucket: pointer.bodyRef?.bucket ?? "", key: pointer.bodyRef?.key ?? "" },
      used: await readQuota(userSub),
      limit: CARD_LIMIT,
    };
  }
  // @kf-batch 50-WP28-platform-action-node —— 刷新快照一并清(清单在指针上)
  const bodyCleaned = await deleteCardBody(target, userSub, cardId, pointer.refreshSnapshots ?? []);
  if (bodyCleaned) await deleteCardPointer(userSub, cardId);
  return { deleted: true, bodyCleaned, used: await readQuota(userSub), limit: CARD_LIMIT };
}

/** 我的卡片(未按范围过滤;过滤由读路由用 `?scope=` 做,口径与全站一致)。 */
export async function listCards(userSub: string): Promise<{ items: CardPointer[]; used: number; limit: number }> {
  const [items, used] = await Promise.all([listCardPointers(userSub), readQuota(userSub)]);
  return { items, used, limit: CARD_LIMIT };
}

/** 列表行 = 中央指针(非数据值)+ 从**该区**读到的标题。 */
export type CardListRow = CardPointer & {
  /** 标题只存在区域侧;读不到时为 `null`(**不是**编一个)。 */
  title: string | null;
  /** `true` = 这张卡的标题在它自己的区域里当前读不到(该区不可达 / 头对象丢了)。 */
  titleUnavailable: boolean;
};

/** 并发上限:一次列表最多 100 张卡,20 并发足够快又不至于把该区打满。 */
const TITLE_FETCH_CONCURRENCY = 20;

/**
 * 给一批卡片补上标题(**逐个从它自己的区域**读轻量 `head.json`)。
 *
 * 🔴 拍板「标题也留区」的代价就在这里,而它的失败必须是**降级而不是消失**:
 * 某张卡的区域读不到 ⇒ 该行 `title:null` + `titleUnavailable:true`,**卡片仍然列出**
 * (cardId / 区域 / 时间 / 轮数都来自中央)。若让读不到的卡片从列表里消失,用户会以为卡片丢了 ——
 * 那正是护栏一「不丢东西」要防的,也比看不到标题严重得多。
 */
export async function attachTitles(userSub: string, pointers: CardPointer[]): Promise<CardListRow[]> {
  const out: CardListRow[] = pointers.map((p) => ({ ...p, title: null, titleUnavailable: true }));
  const targets = new Map<string, Awaited<ReturnType<typeof getTargetRaw>>>();
  for (let i = 0; i < out.length; i += TITLE_FETCH_CONCURRENCY) {
    const slice = out.slice(i, i + TITLE_FETCH_CONCURRENCY);
    await Promise.all(
      slice.map(async (row) => {
        try {
          if (!targets.has(row.targetId)) targets.set(row.targetId, await getTargetRaw(row.targetId));
          const t = targets.get(row.targetId);
          if (!t) return; // target 已从注册表删掉 ⇒ 保持 titleUnavailable
          const head = await getCardHead(t, userSub, row.cardId);
          if (head) {
            row.title = head.title;
            row.titleUnavailable = false;
          }
        } catch (e) {
          // 读不到就降级,**绝不**把这一行丢掉;打日志让运维查得到。
          console.warn("[genbi/cards-service] 取标题失败(降级为占位):%s@%s %s", row.cardId, row.targetId, String(e));
        }
      })
    );
  }
  return out;
}
