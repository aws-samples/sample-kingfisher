// P0-E 预演(changeset dry-run)的**结果判定** —— 纯函数,零 AWS 调用,可离线真跑。
//
// 🔴 为什么把它抽出来(2026-09-15 真环境事故):给 `tgt_usw2_a` 补装 `dms` 时,build 挂在
//    `p0e-gate.mjs` 的第 ① 步,日志逐字是:
//      BgpExecEnv-tgt-usw2-a-base: creating CloudFormation changeset...
//      ❌  BgpExecEnv-tgt-usw2-a-base failed: ChangeSetNotFoundException: ChangeSet [bgp-p0e-preview] does not exist
//      aws: [ERROR]: (InvalidChangeSetStatus) ... Cannot delete ChangeSet in status CREATE_IN_PROGRESS
//    —— 两行合起来说明那个 changeset **就在那儿、正在创建**:CDK 刚 `CreateChangeSet` 就去 describe,
//    撞上 CloudFormation 的最终一致性窗口拿到 `ChangeSetNotFound`。CDK 于是整条 deploy 判失败,
//    而闸把「预演失败」按最严处理 ⇒ **补装组件随机整体失败**,拒因还是「不知道会改什么」(误导)。
//
// 🔴 根治思路:**别把 CDK CLI 的退出码当唯一真相**。真相是「每个栈的 changeset 现在是什么状态」——
//    那是 CloudFormation 自己能回答的事实。所以:CDK 报错 ⇒ 逐栈把 changeset 轮询到**终态**,
//    ① 全部读到(CREATE_COMPLETE)或确定为空(FAILED + didn't contain changes)⇒ 继续裁决;
//    ② 只要有一个**读不到 / 仍在途 / 真失败** ⇒ 拒绝(fail-closed,与改动前同样严),
//       其中「错因全是瞬态」且没有任何一个是**真失败**时,允许**清干净后重试一次**。
export const PREVIEW_TRANSIENT_RE =
  /ChangeSetNotFound|Rate exceeded|Throttl|RequestLimitExceeded|ServiceUnavailable|InternalFailure|try again/i;

/** CDK CLI 的逐栈失败行 → [{stackName, error}]。🔴 只认它自己的失败标记行,不猜别的格式。 */
export function parseCdkStackFailures(output) {
  const out = [];
  for (const line of String(output ?? "").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:❌|✘)\s+(\S+)\s+failed:\s*(.+?)\s*$/);
    if (m) out.push({ stackName: m[1], error: m[2] });
  }
  return out;
}

export function isTransientPreviewError(msg) {
  return PREVIEW_TRANSIENT_RE.test(String(msg ?? ""));
}

/**
 * `describe-change-set` 的原始 JSON → 五态之一。
 *   ready   CREATE_COMPLETE,可以读变更明细
 *   empty   FAILED 且拒因就是「没有变更」(CFN 对空 changeset 的正常表达)
 *   pending 还在创建(CREATE_PENDING / CREATE_IN_PROGRESS)—— 轮询该继续等
 *   missing 读不到(不存在,或最终一致性窗口内)
 *   failed  真失败(别的拒因 / 别的状态)
 * 🔴 `empty` 的判据与 `deploy-impact.mjs` 的 `normalizeDescribeChangeSet` **同一份正则**(那边归一变更明细,
 *    这边只判状态);两处都改才算改,门禁 `p0e-preview-outcome.test.ts` 钉住这句话。
 */
export const CHANGE_SET_EMPTY_RE = /didn't contain changes|No updates are to be performed/i;

export function classifyChangeSet(raw) {
  if (!raw || typeof raw !== "object") return "missing";
  const status = String(raw.Status ?? "");
  const reason = String(raw.StatusReason ?? "");
  if (status === "CREATE_COMPLETE") return "ready";
  if (status === "FAILED") return CHANGE_SET_EMPTY_RE.test(reason) ? "empty" : "failed";
  if (status === "CREATE_PENDING" || status === "CREATE_IN_PROGRESS") return "pending";
  if (!status) return "missing";
  return "failed";
}

export const RESOLVED_OUTCOMES = ["ready", "empty"];

/**
 * 裁决:{ proceed, retry, why, unresolved }。
 *
 * @param cdkFailed  CDK CLI 是否非零退出
 * @param failures   parseCdkStackFailures 的结果
 * @param outcomes   { 栈名: classifyChangeSet 的五态 }(轮询到终态之后的)
 */
export function previewVerdict({ cdkFailed = false, failures = [], outcomes = {} } = {}) {
  const names = Object.keys(outcomes);
  const unresolved = names.filter((n) => !RESOLVED_OUTCOMES.includes(outcomes[n]));
  const detail = names.map((n) => `${n}=${outcomes[n]}`).join(" ");
  if (names.length === 0) {
    // 一个栈都没量到 ⇒ 什么都不知道 ⇒ 最严
    return { proceed: false, retry: false, why: "没有量到任何栈的 changeset 状态", unresolved: [] };
  }
  if (unresolved.length === 0) {
    return {
      proceed: true,
      retry: false,
      why: cdkFailed
        ? `CDK CLI 报了瞬态错(${failures.map((f) => f.error).join(" | ").slice(0, 200)}),但逐栈 changeset 已全部读到终态:${detail}`
        : `预演成功:${detail}`,
      unresolved: [],
    };
  }
  const hardFailed = unresolved.filter((n) => outcomes[n] === "failed");
  const transientOnly =
    cdkFailed && failures.length > 0 && failures.every((f) => isTransientPreviewError(f.error));
  if (hardFailed.length === 0 && transientOnly) {
    return {
      proceed: false,
      retry: true,
      why: `错因全是瞬态(${failures.map((f) => f.error).join(" | ").slice(0, 200)}),而这些栈还没量到终态:${unresolved.join(",")} ⇒ 清干净后重试一次`,
      unresolved,
    };
  }
  return {
    proceed: false,
    retry: false,
    why: `有栈的 changeset 读不到 / 真失败:${unresolved.map((n) => `${n}=${outcomes[n]}`).join(",")}` +
      (failures.length ? `;CDK 报错:${failures.map((f) => `${f.stackName}: ${f.error}`).join(" | ").slice(0, 300)}` : ""),
    unresolved,
  };
}
