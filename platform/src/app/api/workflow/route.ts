export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { requestedTargets } from "@/lib/place/resolve";
import { placeErrorResponse } from "@/lib/place/route";
import { PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { recordAudit } from "@/lib/audit";
import { requireProject, projectFilter, getActiveEnv, envFilter } from "@/lib/projects/guard";
import { requireMwaaForTargets, MwaaNotInstalled, mwaaErrorResponse } from "@/lib/scheduler/mwaa-endpoint";
import { isValidTargetId, HOME_TARGET_ID } from "@/lib/exec-env/target-id";
import { snapshotVersion } from "@/lib/versions/version-service";
// 执行范围。存量编排的执行体确实只有主控区
// (publish 路由用 `homeMwaaEndpoint()`)⇒ 三级回落归 home 是真话;逐区扇出。
import { filterRowsByScope, requireScope } from "@/lib/exec-env/scope";
import { ulid } from "ulid";

const USER_ID = "default-user";

export async function GET(req: NextRequest) {
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  const scope = await requireScope(req, ctx.projectId);
  if (scope instanceof NextResponse) return scope;

  const p = req.nextUrl.searchParams;
  const name = p.get("name") || "";
  const status = p.get("status") || "";
  const cron = p.get("cron") || "";

  const pf = projectFilter(ctx.projectId);
  const filterParts: string[] = ["userId = :uid", pf.clause];
  const attrNames: Record<string, string> = {};
  const attrValues: Record<string, any> = { ":uid": USER_ID, ...pf.values };
  const ef = envFilter(getActiveEnv(req));
  filterParts.push(ef.clause);
  attrNames["#env"] = "env";
  Object.assign(attrValues, ef.values);

  if (status) {
    filterParts.push("#st = :st");
    attrNames["#st"] = "status";
    attrValues[":st"] = status;
  }
  if (name) {
    filterParts.push("contains(#nm, :nm)");
    attrNames["#nm"] = "name";
    attrValues[":nm"] = name;
  }
  if (cron === "configured") {
    filterParts.push("attribute_exists(cronExpression) AND cronExpression <> :empty");
    attrValues[":empty"] = null;
  } else if (cron === "none") {
    filterParts.push("(attribute_not_exists(cronExpression) OR cronExpression = :empty)");
    attrValues[":empty"] = null;
  }

  const { Items = [] } = await docClient.send(new ScanCommand({
    TableName: TABLES.WORKFLOWS,
    FilterExpression: filterParts.join(" AND "),
    ...(Object.keys(attrNames).length > 0 ? { ExpressionAttributeNames: attrNames } : {}),
    ExpressionAttributeValues: attrValues,
  }));
  // 按执行范围过滤(内存侧,走 `bindingTargets` 三级回落)
  const rows = filterRowsByScope(Items as Array<Record<string, unknown>>, scope);

  // 「已发布的载体定义是不是最新的」
  // 🔴 **显式开关** `?withDrift=1`,**没有静默默认**:它要对每个已发布载体打一次
  //   MSAF `get-workflow`(只读),所以只有真要看这件事的页面才付这个代价
  //   (与 `flink/jobs` 列表「仅非终态才查后端」同一个先例)。
  // 🔴🔴 **「没查」与「查了=最新」必须能区分**:不开开关时**压根不带这个字段**;
  //   绝不许用 `ok` 当缺省 —— 那就是把「没查」说成「最新」,是最坏的一种假绿。
  //   查不动(抛错)也**如实回 `unknown`**,绝不省略。
  if (p.get("withDrift") === "1") {
    const { carrierDefinitionDrift } = await import("@/lib/workflow/publish-dag");
    await Promise.all(rows.map(async (r) => {
      const dep = (r as { deployments?: Record<string, unknown> }).deployments;
      const targets = dep && typeof dep === "object" ? Object.keys(dep) : [];
      if (!targets.length) return; // 没有载体 ⇒ 不谈「落后」(那是「待发布」,另一态)
      const out: Record<string, { state: string; reason?: string }> = {};
      await Promise.all(targets.map(async (t) => {
        try {
          const d = await carrierDefinitionDrift(r as never, t);
          out[t] = { state: d.state, ...(d.reason ? { reason: d.reason } : {}) };
        } catch (e) {
          out[t] = { state: "unknown", reason: String((e as Error)?.message ?? e).slice(0, 200) };
        }
      }));
      (r as Record<string, unknown>).carrierDrift = out;
    }));
  }
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  const ctx = await requireProject(req, "editor");
  if (ctx instanceof NextResponse) return ctx;

  const body = await req.json();
  // 🔴🔴 编排的执行区。用户 2026-09-10 **第三次**强调
  // 「每一个分区都有 MWAA serverless 的调度能力,**调度只能在自己的区域执行**。只是元数据收集上报到主控区而已。」
  // ⇒ 新建工作流在**当前视角那个区**,并在建之前就核那个区有没有调度组件(没有 ⇒ 409 + 直达补装,
  //   而不是先建出来、发布时才发现发不了)。落点不从 ...body 裸抄。
  // 🔴🔴 用户 2026-09-15:「我不是让你在美东1 发布执行多个区域吗?」——**创建就必须能绑多个区**。
  //    改动前这里恒写 `targets: [wantTarget]`(单值)⇒ 一个编排永远只有一个绑定 ⇒ 后面那套
  //    「一次发布 → 每区一份产物 / 一次触发 → 每区一条 run」的通道**永远没有输入**(写了也白写)。
  //    形状与离线作业一致:`targets` 多值,逐个校验(合法 id + 该区真装了调度组件),缺省回当前 target/home。
  // 🔴 绑定区必须点名(缺 / 非法 ⇒ 400),不再「没给 = 主控区」
  let wantTargets: string[];
  try {
    wantTargets = requestedTargets(body, "新建工作流");
  } catch (e) {
    const pr = placeErrorResponse(e);
    if (pr) return pr;
    throw e;
  }
  const nonHome = wantTargets.filter((t) => t !== HOME_TARGET_ID);
  if (nonHome.length) {
    try {
      // 🔴 建之前就核**每一个**非 home 区有没有调度组件(没有 ⇒ 409 + 直达补装),
      //    而不是先建出来、发布时才发现某个区发不了。
      await requireMwaaForTargets(nonHome);
    } catch (e) {
      if (e instanceof MwaaNotInstalled) return mwaaErrorResponse(e);
      throw e;
    }
  }
  const wantTarget = wantTargets[0];
  const now = new Date().toISOString();
  const item = {
    dagDefinition: { nodes: [], edges: [] },
    scheduleEnabled: false,
    ...body,
    // 🔴 字段名用平台 B 类绑定默认名 `targets` ⇒ 读侧过滤与三级回落直接复用
    targets: wantTargets,
    userId: USER_ID,
    workflowId: ulid(),
    projectId: ctx.projectId,
    env: getActiveEnv(req),
    createdBy: ctx.identity.username,
    createdBySub: ctx.identity.sub,
    status: "draft",
    createdAt: now,
    updatedAt: now,
  };
  await docClient.send(new PutCommand({ TableName: TABLES.WORKFLOWS, Item: item }));
  await snapshotVersion("workflow", item.workflowId, item, ctx.identity.username, "创建").catch(() => {});
  recordAudit(req, "workflow.create", { resourceType: "workflow", resourceId: item.workflowId, detail: { name: item.name } }).catch(() => {});
  return NextResponse.json(item, { status: 201 });
}
