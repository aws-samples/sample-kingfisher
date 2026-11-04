// GET / PUT / DELETE /api/admin/model-config(51 SPEC §2 表 + PUT 服务端流程;§6.1①③④)。
//
// 网关层 middleware.ts:104 已强制 bgp-admin;这里再做 requirePlatformAdmin 纵深。
// PUT 流程(权威顺序):requireAdmin → 正则廉价预筛 → ∈catalog(厂商档案四系列过滤后,唯一权威白名单)
//   → P0-5 硬闸(openai 系 && !gptTransportReady() ⇒ 400 NotAllowedFamily;本波门恒关)
//   → 强制 probeModel(失败 ⇒ 400 ProbeFailed + reason,不写库)
//   → ③′:档案 toolUse:"probe" 的系列(GPT / GLM 5 / Kimi K3)探测通过但
//      toolUseOk !== true ⇒ 400 ToolUseUnavailable(不写库)—— 问数 / Copilot / 顾问全靠工具调用,没有 tool-use = 全平台哑火
//   → store.putGlobalModel(三项一事务;version 条件写冲突 ⇒ 409 VersionConflict)→ 200 { ok, version }
export const dynamic = "force-dynamic";

import { NextRequest } from "next/server";
import { apiOk } from "@/lib/api-response";
import { HOME_TARGET_ID } from "@/lib/exec-env/target-id";
import { auditActorFromRequest } from "@/lib/audit";
import { isOpenAIFamily, type ProbeOk } from "@/lib/ai/capabilities";
// 系列文案由档案 label 拼(不手写「两系列」);③′ 门按档案 toolUse
import { FAMILIES, VENDORS, vendorOf } from "@/lib/ai/core/vendors";
import { isModelIdFormatValid, resolveModelRuntime, resolveWithProvenance, type ResolvedModel } from "@/lib/ai/model";
import { probeModel, freshProbeFromCache } from "@/lib/ai/probe";
import { gptTransportReady } from "@/lib/ai/transport-gate";
import { faultSeamStatus } from "@/lib/ai/fault-seam";
import { requirePlatformAdmin, modelConfigError } from "@/lib/settings/admin-guard";
import { fetchCatalog } from "@/lib/settings/model-catalog";
// 目录 / 探测的落点(主控区也读描述符)
import { registeredPlace } from "@/lib/place/resolve";
import { placeErrorResponse } from "@/lib/place/route";
import type { Place } from "@/lib/place/types";
import {
  deleteModelSetting,
  getModelSetting,
  getProbe,
  isProbeFresh,
  listScopeOverrides,
  putGlobalModel,
  ModelVersionConflictError,
} from "@/lib/settings/model-store";

// 🔴 线上参数名 `scope` 已改为 `settingScope`(50 SPEC v3.34 §2.6.0):
// `?scope=` 全平台唯一含义 = **执行范围**,而本路由的「作用域」是**模型设置作用域**,
// 两者恰好共用 `global` 这一个合法值 ⇒ 平时都对,等把 per-region 覆盖做成
// `settingScope=<targetId>#global` 时就会与执行范围的 `?scope=<targetId>` 撞在同一个名字上。
// 故此处**只改线名不留别名**:收到旧名 `scope` ⇒ 400 `ScopeParamRenamed`(留别名 = 漂移只是延后)。
const SETTING_SCOPE_PARAM = "settingScope" as const;
const SCOPES = ["global"] as const; // 一期只有全局默认(DESIGN D3);扩

/** 旧参数名出现即拒(query 或 body 皆然),报文点名新参数,避免调用方以为「传了但没生效」。 */
function renamedParamError() {
  return modelConfigError("ScopeParamRenamed", 400, {
    message: `参数 scope 已改名为 ${SETTING_SCOPE_PARAM}(scope 现专指执行范围,见 50 SPEC §2.6.0)`,
  });
}

interface EffectiveModel extends ResolvedModel {
  scope: string;
  probedAt?: number;
  probeOk?: boolean;
  version?: number;
}

/** 生效值 + 来源层(供 GET 与 DELETE 的 fellBackTo 共用)。配置面挂了也不抛:退化成 resolveModelRuntime 的 stale/env/ssot。 */
async function effectiveFor(scope: string, targetId: string): Promise<EffectiveModel> {
  let r: ResolvedModel;
  try {
    r = await resolveWithProvenance(scope, targetId);
  } catch {
    r = await resolveModelRuntime(undefined, targetId);
  }
  const eff: EffectiveModel = { scope, ...r };
  if (r.source === "runtime") {
    const item = await getModelSetting(scope).catch(() => null);
    if (item) {
      eff.version = item.version;
      eff.probedAt = item.probedAt;
      eff.probeOk = item.probeOk;
    }
  }
  // 最近一次探测态(可能比保存时更新,场景四失效 banner 靠它)
  const p = await getProbe(targetId, r.modelId).catch(() => null);
  if (p && isProbeFresh(p)) {
    eff.probedAt = p.probedAt;
    eff.probeOk = p.probeOk;
  }
  return eff;
}

export async function GET(req: NextRequest) {
  const guard = await requirePlatformAdmin(req);
  if (!("identity" in guard)) return guard;
  const targetId = HOME_TARGET_ID; // 一期恒 home;读 query targetId
  try {
    const effective = await Promise.all(SCOPES.map((s) => effectiveFor(s, targetId)));
    const overrides = await listScopeOverrides().catch(() => []);
    return apiOk({
      effective,
      overrides: overrides.map(({ pk: _pk, ...rest }) => rest),
      gptTransportReady: await gptTransportReady(),
      faultSeam: faultSeamStatus(),
    });
  } catch (e) {
    return modelConfigError("StoreUnavailable", 503, { message: e instanceof Error ? e.message : String(e) });
  }
}

export async function PUT(req: NextRequest) {
  const guard = await requirePlatformAdmin(req);
  if (!("identity" in guard)) return guard;
  const targetId = HOME_TARGET_ID;

  let body: { scope?: unknown; settingScope?: unknown; modelId?: unknown; expectVersion?: unknown };
  try {
    body = await req.json();
  } catch {
    return modelConfigError("ValidationFailed", 400, { message: "请求体无效" });
  }
  if (body.scope !== undefined) return renamedParamError();
  const scope = typeof body.settingScope === "string" ? body.settingScope : "global";
  if (!(SCOPES as readonly string[]).includes(scope)) {
    return modelConfigError("ValidationFailed", 400, {
      message: `一期只支持 ${SETTING_SCOPE_PARAM}=global(收到 ${scope})`,
    });
  }
  const modelId = typeof body.modelId === "string" ? body.modelId.trim() : "";
  const expectVersion = body.expectVersion === undefined || body.expectVersion === null ? undefined : Number(body.expectVersion);
  if (expectVersion !== undefined && !Number.isInteger(expectVersion)) {
    return modelConfigError("ValidationFailed", 400, { message: "expectVersion 须为整数" });
  }

  // ① 正则廉价预筛(拒 ARN / 大写 / 空)
  if (!isModelIdFormatValid(modelId)) {
    return modelConfigError("NotInCatalog", 400, { detail: "modelId 格式不合法(需 Bedrock 短 id 或 us./global. 推理配置 id,不接受 ARN)" });
  }
  // 同类缺陷:目录与探测的区**从描述符来**(原来缺省 process.env.AWS_REGION)。
  //   一期全局设置只作用于主控区(targetId 恒 tgt_home,51 SPEC D8),但主控区的 region 也读描述符;不存在 / 没装好 ⇒ 409。
  let place: Place;
  try {
    place = await registeredPlace(targetId, "保存全局模型");
  } catch (e) {
    const pr = placeErrorResponse(e);
    if (pr) return pr;
    throw e;
  }
  // ② 唯一权威白名单:目录(两系列过滤后)
  let inCatalog = false;
  try {
    inCatalog = (await fetchCatalog({ place })).some((m) => m.modelId === modelId);
  } catch (e) {
    return modelConfigError("CatalogUnavailable", 503, { message: `模型目录拉取失败: ${e instanceof Error ? e.message : String(e)}` });
  }
  if (!inCatalog) {
    return modelConfigError("NotInCatalog", 400, {
      detail: `${modelId} 不在可选系列目录内(${FAMILIES.map((f) => VENDORS[f].label).join(" / ")})`,
    });
  }
  // ③ P0-5 一期硬闸:GPT 系列须经传输门控放行(本波恒关)
  if (isOpenAIFamily(modelId) && !(await gptTransportReady())) {
    return modelConfigError("NotAllowedFamily", 400, { detail: "GPT 系列一期未开放,待传输门控放行" });
  }
  // ④ 保存前强制真探测(D5)。
  //   页面「测试该模型」刚通过(同区、PROBE_FRESH_MS 内、tool-use 证据齐)就**不再二次探**——
  //   原来保存必重探,Kimi K3 首字延迟 3–39s 让第二次探测随机超时,用户看到的是「探测被限流」保存失败。ProbeOk 仍只由一次真通过的探测供给
  //   (类型级 probe-before-save 不变),只是允许这次探测来自 10 分钟内的缓存;没有新鲜缓存照旧现探。
  const cachedFresh = freshProbeFromCache(await getProbe(targetId, modelId).catch(() => null), modelId);
  const probe = cachedFresh ?? (await probeModel(modelId, { place }));
  if (probe.ok !== true) {
    return modelConfigError("ProbeFailed", 400, { reason: probe.error, detail: probe.errorDetail || "探测失败" });
  }
  // ③′ D11:tool-use 门按**模型证据**,不按系列拍脑袋 —— toolUse:"probe" 的系列必须在二探里真产出 toolUse 块
  const vendor = vendorOf(modelId);
  if (vendor?.toolUse === "probe" && probe.toolUseOk !== true) {
    return modelConfigError("ToolUseUnavailable", 400, {
      detail: `${modelId} 在 Converse 下不能调用工具(tool-use 探测未通过),问数 / Copilot / 顾问会哑火,不能设为全局默认`,
    });
  }
  // ⑤ 三项一事务写库
  try {
    const previous = await getModelSetting(scope).catch(() => null);
    const r = await putGlobalModel({
      scope,
      modelId,
      probe: probe as ProbeOk,
      expectVersion,
      actor: auditActorFromRequest(req),
      ctx: { method: req.method, path: req.nextUrl?.pathname || "" },
      previous: previous ? { modelId: previous.modelId, version: previous.version } : null,
    });
    return apiOk({ ok: true, version: r.version, modelId, scope });
  } catch (e) {
    if (e instanceof ModelVersionConflictError) return modelConfigError("VersionConflict", 409, { message: e.message });
    return modelConfigError("StoreUnavailable", 503, { message: e instanceof Error ? e.message : String(e) });
  }
}

export async function DELETE(req: NextRequest) {
  const guard = await requirePlatformAdmin(req);
  if (!("identity" in guard)) return guard;
  const targetId = HOME_TARGET_ID;
  if (req.nextUrl.searchParams.has("scope")) return renamedParamError();
  const scope = req.nextUrl.searchParams.get(SETTING_SCOPE_PARAM) || "global";
  if (!(SCOPES as readonly string[]).includes(scope)) {
    return modelConfigError("ValidationFailed", 400, {
      message: `一期只支持 ${SETTING_SCOPE_PARAM}=global(收到 ${scope})`,
    });
  }
  try {
    const previous = await getModelSetting(scope).catch(() => null);
    const deleted = await deleteModelSetting(
      scope,
      auditActorFromRequest(req),
      { method: req.method, path: req.nextUrl?.pathname || "" },
      previous ? { modelId: previous.modelId, version: previous.version } : null
    );
    const after = await effectiveFor(scope, targetId);
    return apiOk({ ok: true, deleted, fellBackTo: after.source, effective: after });
  } catch (e) {
    return modelConfigError("StoreUnavailable", 503, { message: e instanceof Error ? e.message : String(e) });
  }
}
