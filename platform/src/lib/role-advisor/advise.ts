// 角色顾问的**唯一对外入口**(带扫描推导)。
//
// 🔴🔴 为什么要这个文件、而不是把扫描塞进 `buildRoleAdvice`:
//   配方要从 DDB 读管理员扩展 ⇒ `allRecipesFor` 是**异步**的,而 `buildRoleAdvice` 是同步纯函数
//   (它的纯粹性很值钱:单测不用 mock 任何 AWS)。所以分层:
//     · `policy-builder.buildRoleAdvice`  纯规则(引擎必备基线 + 资源画像)
//     · 本文件 `adviseRole`                = 上面那层 + **代码/绑定/配方扫描**(异步)
//   🔴 对外只许用本文件:`provisionRole` 与 `/api/role-advisor/*` 都走这里 ——
//     否则就是本仓那个元 bug「机制早就建好,只是那条路径没接」的第 N+1 例。
//     闭合判据 `__tests__/role-advisor-wiring.test.ts` 钉着「调用点只许是本文件」。

import { homeRegion } from "@/lib/place/home-region";
import { buildRoleAdvice } from "./policy-builder";
import { scanForPermissions, type InferredNeed, type ScanBinding } from "./script-scan";
import { allRecipesFor } from "../cookbook/registry";
import type { CookbookEngine } from "../cookbook/types";
import type { RoleAdvice, RoleAdviceRequest, PolicyStatement } from "./types";

export interface AdviseInput extends RoleAdviceRequest {
  /** 作业脚本正文(PySpark / boto3 / SQL)——**代码解析**的输入。 */
  script?: string;
  /** 源头绑定(数据源)。 */
  sources?: ScanBinding[];
  /** 目标绑定(落点 / 数仓 / 表桶)。 */
  targets?: ScanBinding[];
}

export interface AdviseResult extends RoleAdvice {
  /** 扫描推导出来的每一条权限 + **证据**(哪一行代码 / 哪个绑定 / 哪条配方要它)。 */
  inferred: InferredNeed[];
  /** 🔴 平台认不出来的 AWS 调用 —— 必须回显给用户,这是知识库该长大的地方。 */
  unknown: { match: string; line: number; hint: string }[];
  scannedLines: number;
}

const ENGINE_TO_COOKBOOK: Record<string, CookbookEngine | ""> = {
  emr: "emr", glue: "glue", flink: "flink", dms: "",
};

export async function adviseRole(input: AdviseInput): Promise<AdviseResult> {
  // L4 过渡:语义是缺省回落主控区(静默默认值类),序 6 再按落点改
  const region = input.region || homeRegion();
  const accountId = input.accountId || "";
  const base = buildRoleAdvice({ ...input, region, accountId: accountId || undefined });

  // 🔴 拿不到账号号时**不做扫描**:所有资源 ARN 都会派生成残句。`buildRoleAdvice` 已经把这件事
  //   写进 `cautions`,`provisionRole` 会据此拒绝创建(fail-closed),这里不重复造一份半成品。
  if (!accountId) {
    return { ...base, inferred: [], unknown: [], scannedLines: 0 };
  }

  const ck = ENGINE_TO_COOKBOOK[input.engine] || "";
  const recipes = ck ? await allRecipesFor(ck) : [];
  const scan = scanForPermissions({
    engine: input.engine, region, accountId,
    script: input.script, sources: input.sources, targets: input.targets, recipes,
  });

  // 合并进权限策略:同 Sid 取并集(`scanForPermissions` 内部已合过一遍,这里只处理与基线重名的情况)。
  const bySid = new Map<string, PolicyStatement>();
  for (const st of base.permissionPolicy.Statement) bySid.set(String(st.Sid || `S${bySid.size}`), st);
  for (const n of scan.needs) {
    const cur = bySid.get(n.sid);
    if (!cur) { bySid.set(n.sid, { Sid: n.sid, Effect: "Allow", Action: n.actions, Resource: n.resources }); continue; }
    const acts = new Set([...(Array.isArray(cur.Action) ? cur.Action : [cur.Action]), ...n.actions]);
    const curRes = Array.isArray(cur.Resource) ? cur.Resource : [cur.Resource];
    const ress = new Set([...curRes, ...n.resources]);
    bySid.set(n.sid, { ...cur, Action: Array.from(acts), Resource: Array.from(ress) });
  }

  // 证据进 notes(界面逐条显示「为什么要这条权限」)。
  const notes = [...base.notes];
  for (const n of scan.needs) {
    if (n.evidence.every((e) => e.origin === "baseline")) continue; // 基线那部分 buildRoleAdvice 已记
    const ev = n.evidence.map((e) =>
      e.origin === "code" ? `代码第 ${e.line} 行:${e.match}`
      : e.origin === "recipe" ? `配方 ${e.recipeId}(代码第 ${e.line} 行命中)`
      : e.origin === "binding" ? e.match
      : "引擎必备").join(" · ");
    notes.push({
      action: n.actions.slice(0, 3).join(" / "),
      why: `${n.why}【证据:${ev}】`,
      scoped: !n.resources.includes("*"),
    });
  }

  const cautions = [...base.cautions];
  for (const u of scan.unknown) cautions.push(`🔴 第 ${u.line} 行 ${u.match}:${u.hint}`);

  return {
    ...base,
    permissionPolicy: { Version: "2012-10-17", Statement: Array.from(bySid.values()) },
    notes,
    cautions,
    reasoning: base.reasoning
      + (scan.scannedLines
        ? `已扫描作业脚本 ${scan.scannedLines} 行 + ${(input.sources || []).length} 个源头 / ${(input.targets || []).length} 个目标绑定,`
          + `自动推导出 ${scan.needs.length} 条权限(每条都带证据);`
          + (scan.unknown.length ? `🔴 其中 ${scan.unknown.length} 个 AWS 调用平台还不认识,需要补配方。` : "")
        : "本次没有提供脚本或绑定 ⇒ 只按引擎必备基线推荐(不是「扫过了没发现」)。"),
    inferred: scan.needs,
    unknown: scan.unknown,
    scannedLines: scan.scannedLines,
  };
}
