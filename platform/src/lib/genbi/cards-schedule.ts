// (问数 · CAP-GENBI)
// 问数卡片「定时刷新」的配置面 —— 一张卡片至多一个调度对象(`gcard_<cardId>`,kind=genbi-card)。
//
// 🔴 载体与治理定时任务**同一套**(`lib/scheduler/action-schedules.ts`):单节点 platform-action 工作流发到
//    **卡片自己那个区**的 MWAA Serverless;到点 → 主控区命令表 → 分发 Lambda → 平台内部端点 → `refreshCardOnce`。
// 🔴 只有卡片作者能配(卡片是个人资产;别人看不到这张卡,也就不该能给它定时)。
// 🔴 定时那次**替作者执行**,所以执行前要重验:作者账号仍启用、仍是该项目成员(或仍是平台管理员)、
//    卡片仍在原来的区 —— 任何一条不成立就失败并说清(不许拿一个已被移出项目的人的身份继续取数)。
import type { Identity } from "@/lib/auth/identity";
import { getMember } from "@/lib/projects/project-service";
import { PLATFORM_ADMIN_GROUP } from "@/lib/auth/identity";
import { getUserAuthState } from "@/lib/auth/cognito-users";
import { CARD_REFRESH_ACTION_ID } from "@/lib/scheduler/action-commands";
import {
  createActionSchedule,
  deleteActionSchedule,
  getActionSchedule,
  listActionSchedules,
  setActionScheduleEnabled,
  updateActionScheduleDraft,
  type ActionScheduleRow,
} from "@/lib/scheduler/action-schedules";
import { getCardPointer } from "@/lib/genbi/cards-store";
import { getCardBody } from "@/lib/genbi/cards-body-store";
import { requireReadyTarget } from "@/lib/exec-env/registry";
import { CardNotFound, CardStoreUnavailable } from "@/lib/genbi/cards-service";
import { cardScheduleTaskId, pickTurn } from "@/lib/genbi/cards-refresh";

export { cardScheduleTaskId };

/** 卡片的调度对象(没有 ⇒ null)。 */
export async function getCardSchedule(cardId: string): Promise<ActionScheduleRow | null> {
  const row = await getActionSchedule(cardScheduleTaskId(cardId));
  return row && row.kind === "genbi-card" ? row : null;
}

/** 我的全部卡片定时(调度中心用)。 */
export async function listMyCardSchedules(userSub: string): Promise<ActionScheduleRow[]> {
  return (await listActionSchedules("genbi-card")).filter((r) => r.ownerSub === userSub);
}

/**
 * 配置一张卡片的定时刷新(建 / 改 cron / 启停)。
 * 顺序:校验卡片属于我 + 有可刷新的轮次 → 没有调度对象就建草稿 → 启用中改了参数 ⇒ 先停用再改 → 按要求启停。
 * 🔴 启停的「先办载体再改记录 / 撤不下来不动记录」由 `setActionScheduleEnabled` 一处保证。
 */
export async function configureCardSchedule(
  identity: Identity,
  cardId: string,
  req: { cronExpression: string | null; enabled: boolean; turnIndex?: number }
): Promise<ActionScheduleRow & { notice: string }> {
  const pointer = await getCardPointer(identity.sub, cardId);
  if (!pointer || pointer.state !== "ready") throw new CardNotFound(cardId);
  const params: Record<string, unknown> = {
    cardId,
    ownerSub: identity.sub,
    ownerUsername: identity.username,
    ...(req.turnIndex !== undefined ? { turnIndex: req.turnIndex } : {}),
  };
  // 🔴 配的时候就确认这张卡**有可刷新的轮次**(纯文字卡定时 = 每次都失败的空跑,不许建)
  const target = await requireReadyTarget(pointer.targetId);
  const body = await getCardBody(target, identity.sub, cardId);
  if (!body) throw new CardStoreUnavailable("这张卡片的正文已不在该区域,无法配置定时刷新");
  pickTurn(body.turns, req.turnIndex);

  const create = (cron: string | null) =>
    createActionSchedule({
      taskId: cardScheduleTaskId(cardId),
      kind: "genbi-card",
      // 🔴 名字**不含标题**:标题只留在卡片自己的区(用户拍板「标题也留区」),中央只放非数据值
      name: `问数卡片 ${cardId.slice(-6)}`,
      projectId: pointer.projectId,
      targets: [pointer.targetId],
      action: CARD_REFRESH_ACTION_ID,
      params,
      cronExpression: cron,
      ownerSub: identity.sub,
      ownerUsername: identity.username,
    });

  let row = await getCardSchedule(cardId);
  if (row && row.ownerSub !== identity.sub) throw new CardNotFound(cardId);
  const cron = req.cronExpression ?? row?.cronExpression ?? null;
  if (!row) {
    row = await create(cron);
  } else if (row.targets[0] !== pointer.targetId) {
    // 卡片被改存到了别的区(同一段对话重存)⇒ 落点是不可变身份:撤旧(撤不下来 ⇒ 抛,什么都不改)→ 删 → 建新
    await deleteActionSchedule(row);
    row = await create(cron);
  } else if (JSON.stringify(row.params) !== JSON.stringify(params) || cron !== row.cronExpression) {
    // 参数 / cron 变了:启用中 ⇒ 先撤载体再改草稿(启用中不许改参数,见 updateActionScheduleDraft)
    if (row.scheduleEnabled) {
      await setActionScheduleEnabled(row, { enabled: false });
      row = (await getCardSchedule(cardId))!;
    }
    row = await updateActionScheduleDraft(row, { params, cronExpression: cron });
  }
  if (req.enabled || row.scheduleEnabled) {
    await setActionScheduleEnabled(row, { enabled: req.enabled, cron });
    row = (await getCardSchedule(cardId))!;
  }
  return {
    ...row,
    notice: row.scheduleEnabled
      ? "定时刷新已启用:到点在卡片所在区重跑卡片里那条 SQL,刷新的是同一张卡片(不占卡片额度),每次留一份运行快照。"
      : "定时刷新已停用(该区的调度产物已撤下)。",
  };
}

/** 删卡前:有调度对象就先撤载体再删它(撤不下来 ⇒ 抛,卡片不删 —— 否则那个区会按 cron 刷一张不存在的卡)。 */
export async function removeCardSchedule(cardId: string): Promise<void> {
  const row = await getCardSchedule(cardId);
  if (row) await deleteActionSchedule(row);
}

/**
 * 定时那次执行前的**作者重验**(fail-closed):账号启用 + sub 未变 + 仍是项目成员或平台管理员。
 */
export async function assertCardAuthorStillAuthorized(ownerUsername: string, ownerSub: string, projectId: string): Promise<void> {
  const st = await getUserAuthState(ownerUsername);
  if (!st.enabled) throw new Error(`卡片作者 ${ownerUsername} 的账号已被禁用 —— 定时刷新停止替他取数`);
  if (st.sub && st.sub !== ownerSub) throw new Error(`卡片作者 ${ownerUsername} 的身份已变(sub 不一致)—— 拒绝替他执行`);
  if (st.groups.includes(PLATFORM_ADMIN_GROUP)) return;
  const m = await getMember(projectId, ownerUsername);
  if (!m) throw new Error(`卡片作者 ${ownerUsername} 已不是项目 ${projectId} 的成员 —— 定时刷新停止替他取数`);
}

/** 定时那次:卡片仍在、仍属于作者、仍在调度对象绑定的那个区、仍有可刷新的轮次(与配置时同一个 pickTurn)。 */
export async function assertCardStillSchedulable(ownerSub: string, cardId: string, targetId: string, projectId: string): Promise<void> {
  const p = await getCardPointer(ownerSub, cardId);
  if (!p || p.state !== "ready") throw new Error(`卡片 ${cardId} 已不存在(或正在删除)`);
  if (p.targetId !== targetId) throw new Error(`卡片已改存到 ${p.targetId},而这个定时绑在 ${targetId} —— 请在卡片上重新配置定时刷新`);
  if (p.projectId !== projectId) throw new Error(`卡片的归属项目已变(${p.projectId} ≠ ${projectId})—— 拒绝执行`);
}
