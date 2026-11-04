"use client";

// @kf-batch 50-P50.2c-control-api
// 执行环境详情(50 INTERACTION §1.2 进度 / §1.3 探活·启用 / §1.5 组件区)。
//
// 诚实边界(与后端批次对齐,别做"看起来能点其实必炸"的按钮):
//   · probe / enable —— 切片 e 并行交付;接口 404 时给出明确降级提示,不白屏;
//   · 补充部署(add-components);删除:路 A 弃置 / 路 B 下线销毁(drain→影响预览→审批→销毁,DecommissionPanel);
//   · home 环境**不显示**删除入口(INTERACTION §1.4 机制D;后端另有硬拒)。
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Badge, Button, Descriptions, Divider, Drawer, Input, List, Modal, Radio, Select, Space, Tag, Tooltip, Typography, message } from "antd";
import { CheckCircleTwoTone, CloseCircleTwoTone, ExperimentOutlined, MedicineBoxOutlined, PoweroffOutlined, RocketOutlined } from "@ant-design/icons";
import { useT } from "@/lib/i18n/useT";
import { ApiError, COMPONENT_META, STATUS_META, addComponents, apiFetch, deployTarget, enableTarget, getPreviewVerdict, getRecoveryStatus, previewComponents, probeTarget, recoverTarget, setTargetAccess, setTargetIntent, setTargetSchedulerPreference, type ExecEnvTarget, type ImpactVerdictView, type ProbeResult, type RecoveryStatus } from "./api";
// @kf-batch 50-WP15-airflow-serverless(施工序 6):调度器偏好(两者都装时)
import { SCHEDULER_PREFERENCES, SCHEDULER_PREFERENCE_LABEL, isWritableSchedulerPreference } from "@/lib/exec-env/scheduler-preference";
import BuildProgress from "./BuildProgress";
import CredentialIsolationPanel from "./CredentialIsolationPanel"; // @kf-batch 50-WP9a-durable-jobs
// @kf-batch 50-WP30-decommission
import DecommissionPanel from "./DecommissionPanel";
import { missingRequiredComponents, requiredComponentsFor } from "@/lib/exec-env/implemented-components";
// @kf-batch 50-WP15-airflow-serverless(K-5 网络规模)

/**
 * 可(重)触发部署的状态 —— **UI 便利判定,真权威在 broker**(infra/lambda/exec-env-broker/validate.mjs
 * 的 DEPLOYABLE_STATUS,语义一致:draining/decommissioning/deleted 是删除流程的地盘,一律不给按钮)。
 * 两侧若漂移,后果只是按钮点了拿到 broker 的明确 409/400 报错 —— 不是安全面。
 * 🔴 P50.2e3 补:此前 deploy 只在向导里,register 成功但触发失败的环境在页面上**无路可重试**
 * (向导报错文案却承诺「可在详情页重试」)—— 用户实测撞到(broker KMS 缺权那次)。
 */
const DEPLOYABLE_STATUS = new Set(["registered", "initializing", "testing", "active", "degraded", "failed", "upgrading"]);
// @kf-batch 50-WP30-discard —— 「从没装出来」的提示性口径(服务端 discard.ts 现查 CFN 才是最终判定)
const DISCARDABLE_STATUS = new Set(["registered", "initializing", "failed"]);

const { Text } = Typography;

export default function TargetDetail({
  target,
  onClose,
  onChanged,
  highlightComponent,
}: {
  target: ExecEnvTarget | null;
  onClose: () => void;
  /** probe/enable 改了状态后回调(父组件刷新列表)。 */
  onChanged: () => void;
  /** @kf-batch 50-WP13-mwaa-region 深链要高亮的组件(调度页「去执行环境补装 MWAA」落点;INTERACTION v2.18 §2.2a) */
  highlightComponent?: string;
}) {
  const t = useT();
  const [probing, setProbing] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [intentBusy, setIntentBusy] = useState(false);
  // @kf-batch 50-WP30-discard
  const [discardOpen, setDiscardOpen] = useState(false);
  const [discardText, setDiscardText] = useState("");
  const [discardBusy, setDiscardBusy] = useState(false);
  const doDiscard = async () => {
    if (!target) return;
    setDiscardBusy(true);
    try {
      const res = await fetch(`/api/admin/exec-envs/${encodeURIComponent(target.targetId)}/discard`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: discardText, decisionId: `discard-${Date.now().toString(36)}` }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || d?.success === false) { message.error(d?.error?.message || t("弃置失败")); return; }
      message.success(t("已弃置 {tid},{region} 的执行环境名额已释放", { tid: target.targetId, region: target.region }));
      setDiscardOpen(false);
      onChanged();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setDiscardBusy(false);
    }
  };
  // @kf-batch 50-WP15-airflow-serverless(施工序 6):调度器偏好只影响之后的发布(INTERACTION §2.2b)
  const [spBusy, setSpBusy] = useState(false);
  const doSetSchedulerPreference = async (v: "serverless" | "mwaa") => {
    if (!target) return;
    setSpBusy(true);
    try {
      const r = await setTargetSchedulerPreference(target.targetId, v, target.version ?? 0);
      message.success(t(r.hint));
      onChanged();
    } catch (e) {
      message.error(t("改调度器偏好失败:{e}", { e: (e as Error).message }));
    } finally {
      setSpBusy(false);
    }
  };
  // @kf-batch 50-WP16-zero-egress:网络行的两个观测量(都来自描述符资源袋 SPEC §3.16-E)
  const netRes = (target as { resources?: Record<string, unknown> } | null | undefined)?.resources ?? {};
  const endpointCount = String(netRes.endpointIds ?? "").split(",").filter((x) => x.trim().length > 0).length;
  const crossRegionOk = Boolean(netRes.crossRegionDdbEndpointId) && Boolean(netRes.homeLinkHostedZoneId);
  // @kf-batch 50-W5-seg2-WP10a —— 「已同意告知」卡(INTERACTION v2.17 §4bis;E-198):跨法域 target 才有;只读回查
  type AckView = { source: "register" | "ack"; by: string; sub?: string; at: string; version: string; textHash: string };
  const crossJurisdiction = (target?.jurisdiction ?? "home") !== "home";
  const [acks, setAcks] = useState<AckView[]>([]);
  const [acksErr, setAcksErr] = useState<string | null>(null);
  useEffect(() => {
    if (!target?.targetId || !crossJurisdiction) return;
    apiFetch<{ acks: AckView[] }>(`/api/admin/exec-envs/${encodeURIComponent(target.targetId)}/acks`)
      .then((d) => { setAcks(d.acks || []); setAcksErr(null); })
      .catch((e) => setAcksErr(String((e as Error)?.message ?? e)));
  }, [target?.targetId, crossJurisdiction, target?.updatedAt]);
  // @kf-batch 50-W5-seg1-WP10a —— 「授权项目」卡(INTERACTION v2.17 §1.7;SPEC §1.1 access,通用)
  const [accessMode, setAccessMode] = useState<"all-projects" | "allowlist">(target?.access?.mode ?? "all-projects");
  const [accessProjects, setAccessProjects] = useState<string[]>(target?.access?.mode === "allowlist" ? target.access.projects : []);
  const [accessBusy, setAccessBusy] = useState(false);
  const [projectOptions, setProjectOptions] = useState<Array<{ value: string; label: string }>>([]);
  useEffect(() => {
    setAccessMode(target?.access?.mode ?? "all-projects");
    setAccessProjects(target?.access?.mode === "allowlist" ? target.access.projects : []);
  }, [target?.targetId, target?.access]);
  useEffect(() => {
    apiFetch<Array<{ projectId: string; name?: string }>>("/api/projects")
      .then((rows) => setProjectOptions((Array.isArray(rows) ? rows : []).map((p) => ({ value: p.projectId, label: p.name ? `${p.name}(${p.projectId})` : p.projectId }))))
      .catch(() => setProjectOptions([]));
  }, []);
  const doSaveAccess = async () => {
    if (!target) return;
    setAccessBusy(true);
    try {
      const r = await setTargetAccess(target.targetId, accessMode === "all-projects" ? { mode: "all-projects" } : { mode: "allowlist", projects: accessProjects });
      message.success(r.access.mode === "all-projects" ? t("已设为:全部项目可用") : t("已设为:仅 {n} 个项目可用", { n: String(r.access.projects.length) }));
      onChanged();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setAccessBusy(false);
    }
  };
  /**
   * 🔴 P0-E 预演/审批的三态(SPEC §3.5c)。`running` = 预演在跑;`done` = 拿到裁决待人决定。
   * 刻意**不做第四态"已批准待部署"** —— 批准与发起在同一次点击里完成,免得出现"批过了但没人点部署"
   * 这种悬空状态(悬空的批准过一会儿就成了陈旧批准,而 planHash 一变它本来就失效了)。
   */
  const [preview, setPreview] = useState<
    | null
    | { phase: "running"; buildId: string; component: string; wanted: string[] }
    | { phase: "done"; buildId: string; component: string; wanted: string[]; verdict: ImpactVerdictView; summary: string }
  >(null);
  const [deploying, setDeploying] = useState(false);
  /** 正在补充部署的组件 key(同时只允许一个:部署锁本来也只容一次)。 */
  const [adding, setAdding] = useState<string | null>(null);
  const [probeResult, setProbeResult] = useState<ProbeResult | null>(null);
  /**
   * 🔴 P50.3b-2b:在途/失败会话的恢复状态(判据全在服务端,页面只渲染它回的东西)。
   * 三态:`null` 未拉过 / `"error"` **拉失败** / 对象 = 服务端结论。
   * 🔴 `"error"` 必须 **fail-closed**:审核 §19.8 要求"必须展示 + 禁止静默重试",若拉不到就把横幅一撤、
   *    部署按钮放开,恰好在最需要它的时候静默失效(真安全仍有 broker 兜,但呈现层不该自己开口子)。
   */
  const [recovery, setRecovery] = useState<RecoveryStatus | "error" | null>(null);
  const [recovering, setRecovering] = useState(false);

  const isHome = !!target && (target.isHome === true || target.targetId === "tgt_home");
  const installed = useMemo(() => new Set(target?.components ?? []), [target]);
  // @kf-batch 50-PROD-B-seq33 ②:完整组件集与缺口(唯一作者 requiredComponentsFor;home 也按它判,但不在这里补)
  const requiredSet = useMemo(
    () => requiredComponentsFor({ isHome, jurisdiction: target?.jurisdiction }),
    [isHome, target]
  );
  const missingRequired = useMemo(
    () => missingRequiredComponents(target?.components ?? [], { isHome, jurisdiction: target?.jurisdiction }),
    [isHome, target]
  );
  // 探活结果:优先本次 probe 的返回,否则用注册表里落的 probe 字段(切片 e 写入)。
  const probe = probeResult?.probe ?? target?.probe;
  // @kf-batch 50-init-region-enablement —— 完成序真因(init 段 I-4:9 行「描述符缺 resources.*」只是衍生症状)
  const finalizeError = probeResult?.finalizeError;
  const regionNotEnabled = target?.controlPlaneRegionEnabled === false || probeResult?.regionEnabled === false;

  const targetId = target?.targetId;
  const refreshRecovery = useCallback(async () => {
    if (!targetId) return;
    try {
      setRecovery(await getRecoveryStatus(targetId));
    } catch {
      // 🔴 拉不到 ⇒ fail-closed 记 "error"(详情页其余部分照常可用,但部署入口一律先锁上)。
      setRecovery("error");
    }
  }, [targetId]);
  useEffect(() => {
    void refreshRecovery();
  }, [refreshRecovery]);

  if (!target) return null;
  const meta = STATUS_META[target.status] ?? { color: "default", label: target.status };
  /**
   * 🔴 **只读**可服务性(服务端 `describeServiceability`,与数据面准入同一内核)。
   * 为什么要单独摆出来:徽标 `status` 是 生命周期×健康 的投影,**不含新鲜度(stale)与残留部署锁**,
   * 于是「运行中」的卡片完全可能被数据面一律拒收。用户原话:「最坏的不是不能用,是看不出为什么不能用」。
   * `undefined`(旧后端)如实显示"未知" —— 两个方向都不许装作知道。
   */
  const svc = target.serviceability;
  const rec = typeof recovery === "object" && recovery !== null ? recovery : null;
  const recUnknown = recovery === "error";
  // 🔴 只有"服务端明确说没有在途会话"才放开部署入口;未知一律当有(fail-closed)。
  const deployBlocked = recUnknown || rec?.sessionInFlight === true;
  /**
   * 🔴 当前意图是否"排空"。读 `spec.intent`;legacy 描述符没有 spec ⇒ 退到派生投影
   * (`status=draining/decommissioning/deleted` 说明意图不是 serve)——**不猜成 serve**:
   * 猜成 serve 会给一个正在退役的环境显示「排空」按钮、并把"已排空"说成"在服务",是反向的误导。
   */
  const intentDrain =
    target.spec?.intent !== undefined
      ? target.spec.intent !== "serve"
      : ["draining", "decommissioning", "deleted"].includes(target.status);
  const deployBlockedReason = recUnknown
    ? t("恢复状态读取失败 —— 无法确认是否有在途部署会话,已先禁用部署入口(fail-closed);请刷新重试")
    : t("有在途部署会话未收口 —— 禁止静默重试新部署(审核 §19.8);会话结束/恢复后自动可用");

  const doProbe = async () => {
    setProbing(true);
    try {
      const r = await probeTarget(target.targetId);
      setProbeResult(r);
      message.success(r.probe.ok ? t("探活全绿") : t("探活有未通过项,见下方明细"));
      await refreshRecovery(); // 探活可能刚把会话收口(finalize)⇒ 重算阻断态
      onChanged();
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        message.info(t("探活接口尚未上线(随切片 e 交付);此按钮为交互先行"));
      } else {
        message.error((e as Error).message);
      }
    } finally {
      setProbing(false);
    }
  };

  /**
   * @kf-batch 50-W5-seg1-WP3 —— 「重新部署」= **升级**,与「触发部署」(首装)走不同的路:
   *   · 首装(`registered`):直接 deploy(初装 change set 全是 Add,本就无需审批);
   *   · 已启用:先**预演同集**(SPEC §2.1 v3.21 升级预演),让人看见这次源包对既有栈会改什么 + 基线是否漂移,
   *     再在同一个 P0-E 弹窗里〔批准并部署〕(带 `approvedPlanHash`)。没有这一步,源漂移后「重新部署」在 build 侧闸必挂,
   *     而管理员只看到一个很远的「构建失败」。
   */
  const UPGRADE_KEY = "__upgrade__";
  /** @kf-batch 50-PROD-B-seq33 ②:〔补齐缺失组件〕在预演/部署公共体里的 key(与 UPGRADE_KEY 同一用法) */
  const FILL_MISSING_KEY = "__fill_missing__";
  const doDeploy = async () => {
    if (target.status !== "registered") {
      await runPreview(UPGRADE_KEY, Array.from(new Set([...(target.components ?? []), "core"])));
      return;
    }
    setDeploying(true);
    try {
      const r = await deployTarget(target.targetId);
      message.success(t("部署已触发(buildId {id});并发保护由 broker 部署锁承担", { id: r.buildId.slice(-12) }));
      await refreshRecovery(); // 会话刚开 ⇒ 立刻重算阻断态(否则横幅/按钮停在旧结论)
      onChanged(); // 刷新 lastBuildId,BuildProgress 跟上新一轮
    } catch (e) {
      message.error((e as Error).message); // broker 拒绝(locked/bad-status…)原样呈现,拒因即解释
    } finally {
      setDeploying(false);
    }
  };

  /**
   * 补充部署一个组件。
   * 🔴 传给服务端的是**全集**(现装 ∪ 这一个),不是增量 —— add-components 的合同是全集语义,
   *    服务端按"只增不减"校验(减组件要走删除流程)。
   */
  // @kf-batch 50-PROD-B-seq33 ②:唯一的补装动作 = 补齐到要求集(SSOT requiredComponentsFor)
  const doFillMissing = async () => {
    await runPreview(FILL_MISSING_KEY, Array.from(new Set([...(target.components ?? []), ...missingRequired])));
  };

  /** P0-E 第一阶段的公共体:补组件(key = 组件)与升级(key = UPGRADE_KEY,wanted = 已装全集)都走它。 */
  const runPreview = async (key: string, wanted: string[]) => {
    setAdding(key);
    try {
      // ── 🔴 P0-E 第一阶段:先**预演**(SPEC §3.5c ①)────────────────────────────
      // 【为什么不直接部署】`add-components` 宣称"只增不改"**只在源模板不变时成立**:控制面 infra 一演进,
      //   给一个**在服务中**的 region 补个组件就可能对已有栈产生 changeset、甚至 REPLACE 有状态资源
      //   (Redshift namespace / MWAA env / S3 桶 / KMS key)⇒ 停机或**不可逆丢数据**。
      //   ⇒ 先只创建 change set 不执行,把"这次到底会改什么"摆给人看,再决定动不动手。
      const pv = await previewComponents(target.targetId, wanted);
      setPreview({ phase: "running", buildId: pv.buildId, component: key, wanted });
      // 预演要跑 cdk synth + describe-change-set,实测 1–3 分钟;轮询上限给到 6 分钟。
      let verdict: ImpactVerdictView | undefined;
      let summary = "";
      for (let i = 0; i < 72; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        const g = await getPreviewVerdict(target.targetId, pv.buildId);
        if (g.state === "ready" && g.verdict) {
          verdict = g.verdict;
          summary = g.summary ?? "";
          break;
        }
        if (g.state === "unavailable") {
          // 🔴 取不到裁决**绝不当成"没有影响"**:明确报出来让人排查,不给"看起来批过了"的假象。
          setPreview(null);
          message.error(
            t("预演结束但取不到影响裁决(buildPhase={p})—— 不能确认这次会改什么,已中止;请看构建日志", {
              p: g.buildPhase ?? "?",
            })
          );
          return;
        }
      }
      if (!verdict) {
        setPreview(null);
        message.error(t("预演超过 6 分钟仍无裁决,已中止(未做任何变更);可稍后重试"));
        return;
      }
      setPreview({ phase: "done", buildId: pv.buildId, component: key, wanted, verdict, summary });
    } catch (e) {
      setPreview(null);
      message.error((e as Error).message); // 服务端拒因(未实现/减组件/锁冲突/在途会话)原样呈现
    } finally {
      setAdding(null);
    }
  };

  /**
   * 🔴 P0-E 第二阶段:管理员看过计划后**真部署**(SPEC §3.5c ③)。
   * 计划需审批时才带 `approvedPlanHash` —— 它绑**这一份计划**:计划变一个字节 hash 就变,旧批准自动失效。
   * 🔴 平台侧这一步只是"把批准递下去";**要不要审批由 build 侧重算决定**(平台可能被绕,纵深两道锁)。
   */
  const doApproveAndAdd = async () => {
    const pv = preview;
    if (!pv || pv.phase !== "done" || !pv.verdict) return;
    setAdding(pv.component);
    try {
      const approved = pv.verdict.requiresApproval ? pv.verdict.planHash : undefined;
      if (pv.component === UPGRADE_KEY) {
        // 升级:同一份计划的 hash 交给 deploy(SPEC §2.1 v3.21)
        const r = await deployTarget(target.targetId, approved);
        setPreview(null);
        message.success(t("已触发重新部署(升级;buildId {id})", { id: r.buildId.slice(-12) }));
        await refreshRecovery();
        onChanged();
        return;
      }
      const r = await addComponents(target.targetId, pv.wanted, approved);
      setPreview(null);
      message.success(t("已触发补充部署:{added}(buildId {id})", { added: r.added.join(", "), id: r.buildId.slice(-12) }));
      await refreshRecovery();
      onChanged(); // 刷新 lastBuildId,BuildProgress 跟上新一轮
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setAdding(null);
    }
  };

  /**
   * 🔴 P50.3b-4:排空 / 回服务。**必须二次确认** —— 排空会让该 region 停止承接新工作(同步生效)。
   * 🔴 文案如实:排空**不**销毁任何资源、在途作业会跑完;回服务需下一次全绿探活才真正回到「运行中」。
   */
  const doSetIntent = (intent: "serve" | "drain") => {
    const draining = intent === "drain";
    Modal.confirm({
      title: draining ? t("确认排空该执行环境?") : t("确认恢复承接新工作?"),
      okText: draining ? t("确认排空") : t("确认恢复"),
      okButtonProps: draining ? { danger: true } : undefined,
      cancelText: t("取消"),
      content: (
        <Space direction="vertical" size={4}>
          <Text style={{ fontSize: 12 }}>
            {draining
              ? t("排空后该 region **立即停止承接新工作**(同步生效);**在途作业会跑完**,不销毁任何资源。")
              : t("恢复后该 region 重新承接新工作;phase 需**下一次全绿探活**才回到「运行中」——不是翻个标记就算好。")}
          </Text>
          <Text style={{ fontSize: 12 }} type="secondary">
            {draining
              ? t("排空**不是删除**:删除环境要走单独的销毁流程(影响预览 → 输名强确认 → 审批 → 销毁,数据桶保留)。")
              : t("若探活未全绿,它会留在「排空中」并把原因显示出来。")}
          </Text>
        </Space>
      ),
      onOk: async () => {
        setIntentBusy(true);
        try {
          const r = await setTargetIntent(target.targetId, intent);
          message.success(r.note);
          onChanged();
        } catch (e) {
          message.error((e as Error).message); // 409(在途会话/并发)与 403(home 不许排空)原样呈现
        } finally {
          setIntentBusy(false);
        }
      },
    });
  };

  /**
   * 🔴 P50.3b-2b:恢复失败会话(SPEC §3.5b)。**必须二次确认** —— 它会清掉在途部署会话与部署锁,
   * 前提是服务端已核验 build 终止 + 目标 region 基础设施稳定(审核 §19.8 禁止静默自动恢复)。
   */
  const doRecover = () => {
    const operationId = rec?.operationId;
    if (!operationId) return;
    Modal.confirm({
      title: t("确认恢复该失败的部署会话?"),
      content: (
        <Space direction="vertical" size={4}>
          <Text style={{ fontSize: 12 }}>
            {t("会话 {op}:build={bs}", { op: operationId, bs: rec?.buildStatus ?? "—" })}
          </Text>
          <Text style={{ fontSize: 12 }}>
            {t("恢复将:记录本次失败 + 解除部署锁;health 置为未知(暂不承接新工作),下一次探活全绿后自动回到运行中。")}
          </Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t("服务端已核验:该 build 已终止,且目标 region 的栈无进行中动作、无未执行 change set。")}
          </Text>
        </Space>
      ),
      okText: t("确认恢复"),
      cancelText: t("取消"),
      onOk: async () => {
        setRecovering(true);
        try {
          const decisionId = `recover-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${Math.floor(
            Math.random() * 0xffff
          )
            .toString(16)
            .padStart(4, "0")}`;
          const r = await recoverTarget(target.targetId, operationId, decisionId);
          message.success(r.note || t("已恢复"));
          await refreshRecovery();
          onChanged();
        } catch (e) {
          message.error((e as Error).message); // 服务端拒因(build 还在跑 / CFN 未稳定 / fence 变了)原样呈现
        } finally {
          setRecovering(false);
        }
      },
    });
  };

  const doEnable = async () => {
    setEnabling(true);
    try {
      await enableTarget(target.targetId);
      message.success(t("已启用,开始接受下推"));
      onChanged();
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        message.info(t("启用接口尚未上线(随切片 e 交付)"));
      } else {
        message.error((e as Error).message);
      }
    } finally {
      setEnabling(false);
    }
  };

  return (
    <Drawer
      open={!!target}
      onClose={onClose}
      width={680}
      title={
        <Space>
          {isHome ? <span>🏠</span> : null}
          <Text strong>{target.displayName || target.targetId}</Text>
          <Badge status={meta.color as never} text={t(meta.label)} />
        </Space>
      }
    >
      <Descriptions size="small" column={2} bordered>
        <Descriptions.Item label="targetId">
          <Text code>{target.targetId}</Text>
        </Descriptions.Item>
        <Descriptions.Item label="region">{target.region}</Descriptions.Item>
        <Descriptions.Item label={t("账号")}>{target.accountId || "—"}</Descriptions.Item>
        <Descriptions.Item label={t("法域")}>
          {(target.jurisdiction ?? "home") === "home" ? "home" : <Tag data-testid="jurisdiction-tag">🌍 {target.jurisdiction}</Tag>}
          {target.residencyAck ? (
            <Tooltip title={t("注册时 {by} 于 {at} 同意了免责告知 {v}(可回查;不可改)", { by: target.residencyAck.by, at: target.residencyAck.at, v: target.residencyAck.version })}>
              <Text type="secondary" style={{ fontSize: 12, marginInlineStart: 8 }}>{t("已同意告知 {v} ✓", { v: target.residencyAck.version })}</Text>
            </Tooltip>
          ) : null}
        </Descriptions.Item>
        <Descriptions.Item label="ready">
          {target.ready === true ? <Tag color="green">true</Tag> : <Tag>false</Tag>}
        </Descriptions.Item>
        <Descriptions.Item label={t("更新时间")}>
          {(target.updatedAt ?? "").slice(0, 19).replace("T", " ") || "—"}
        </Descriptions.Item>
        {/* 🔴 可服务性:数据面此刻会不会收它 + **为什么不收**(逐字是数据面的拒因,同一判定内核)。 */}
        {/* @kf-batch 50-WP9a-durable-jobs —— 凭证隔离状态 + 〔延期供给截止〕(50 SPEC §3.9b) */}
        <Descriptions.Item label={t("凭证隔离")} span={2}>
          <CredentialIsolationPanel target={target} onChanged={onChanged} />
        </Descriptions.Item>
        <Descriptions.Item label={t("可承接新工作")} span={2}>
          {svc === undefined ? (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {t("未知(后端未返回可服务性)")}
            </Text>
          ) : svc.usable ? (
            <Space size={6} wrap>
              <Tag color="green">{t("可承接")}</Tag>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {svc.ageSeconds === null
                  ? t("无可用探活时间源")
                  : t("距上次探活/更新 {a}s(过期阈值 {m}s)", {
                      a: String(svc.ageSeconds),
                      m: String(svc.freshnessMaxAgeSeconds),
                    })}
                {svc.staleExempt ? t(";home 豁免过期判定") : ""}
              </Text>
            </Space>
          ) : (
            <Space direction="vertical" size={2} style={{ width: "100%" }}>
              <Space size={6} wrap>
                <Tag color="error">{t("不承接")}</Tag>
                {svc.ageSeconds !== null ? (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {t("距上次探活/更新 {a}s(过期阈值 {m}s)", {
                      a: String(svc.ageSeconds),
                      m: String(svc.freshnessMaxAgeSeconds),
                    })}
                  </Text>
                ) : null}
              </Space>
              <Text style={{ fontSize: 12 }}>{svc.reason}</Text>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {t("这就是数据面下推时给出的同一句拒因;徽标只反映生命周期与健康,不含新鲜度与残留部署锁")}
              </Text>
            </Space>
          )}
        </Descriptions.Item>
      </Descriptions>

      {/* @kf-batch 50-W5-seg2-WP10a —— 「已同意告知」卡(INTERACTION v2.17 §4bis;E-198):注册时 admin 的同意 + 之后每个用户
          首次数据操作时的同意,只读可回查(表只追加、不可改删)。home 法域 target 没有这张卡(没有需要同意的东西)。 */}
      {crossJurisdiction && (
        <>
          <Divider titlePlacement="start" plain>
            {t("已同意告知")}
          </Divider>
          <div data-testid="acks-card">
            {acksErr ? (
              <Alert type="warning" showIcon message={acksErr} />
            ) : (
              <List
                size="small"
                dataSource={acks}
                locale={{ emptyText: t("暂无同意记录") }}
                renderItem={(a) => (
                  <List.Item data-testid="ack-row">
                    <Space size={8} wrap>
                      <Tag>{a.source === "register" ? t("注册时") : t("使用时")}</Tag>
                      <Text data-testid="ack-by">{a.by}</Text>
                      <Text type="secondary">{a.at?.slice(0, 19).replace("T", " ")}</Text>
                      <Tag color="blue">{a.version}</Tag>
                    </Space>
                  </List.Item>
                )}
              />
            )}
          </div>
        </>
      )}

      {/* @kf-batch 50-W5-seg1-WP10a —— 「授权项目」卡(INTERACTION v2.17 §1.7):任何 target 都有,不对跨法域特殊化;
          缺省全部项目;判据与数据面同一个 accessAllows(呈现 = 授权)。全集语义,POST .../access,审计 exec-env.access.set。 */}
      <Divider titlePlacement="start" plain>
        {t("授权项目")}
      </Divider>
      <Space direction="vertical" size={8} style={{ width: "100%" }} data-testid="access-card">
        <Radio.Group value={accessMode} onChange={(e) => setAccessMode(e.target.value)}>
          <Radio value="all-projects">{t("全部项目(默认)")}</Radio>
          <Radio value="allowlist">{t("仅以下项目")}</Radio>
        </Radio.Group>
        {accessMode === "allowlist" && (
          <Select
            mode="multiple"
            allowClear
            showSearch
            // 🔴 按**项目名**搜索(2026-09-05 真环境 W5a-16 抓到):antd 缺省按 value(projectId 的 ULID)过滤,
            //    管理员敲项目名 ⇒ 「无匹配结果」,白名单根本选不进去。
            optionFilterProp="label"
            style={{ width: "100%" }}
            placeholder={t("选择可以把任务 / 直查 / 建模绑到本执行环境的项目(空 = 谁都不能绑);可按项目名搜索")}
            options={projectOptions}
            value={accessProjects}
            onChange={(v) => setAccessProjects(v as string[])}
          />
        )}
        <Space>
          <Button size="small" type="primary" loading={accessBusy} onClick={doSaveAccess}>
            {t("保存授权")}
          </Button>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t("不在白名单的项目成员看不到本环境、也不能改绑;已有绑定不受影响(改绑时才校验)")}
          </Text>
        </Space>
      </Space>

      {/* 🔴 P50.3b-2b:在途/失败会话的阻断横幅 —— 审核 §19.8 要求 UI **必须**呈现
          start-uncertain / needs-failure-reconcile,并**禁止静默重试新 operation**(故下方部署按钮同时禁用)。 */}
      {rec?.needed ? (
        <Alert
          style={{ marginTop: 8 }}
          type={rec.recoverableNow ? "error" : "warning"}
          showIcon
          message={rec.recoverableNow ? t("需人工恢复") : t("需人工恢复(现在还不能执行)")}
          description={
            <Space direction="vertical" size={4}>
              <Text style={{ fontSize: 12 }}>{rec.reason}</Text>
              {rec.operationId ? (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {t("会话 {op}{k}{b}", {
                    op: rec.operationId,
                    k: rec.kind ? ` · ${rec.kind}` : "",
                    b: rec.buildStatus ? ` · build=${rec.buildStatus}` : "",
                  })}
                </Text>
              ) : null}
              {rec.earliestRecoverAt ? (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {t("最早可恢复:{at}", { at: rec.earliestRecoverAt.slice(0, 19).replace("T", " ") })}
                </Text>
              ) : null}
              {rec.cfn && !rec.cfn.stable ? (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {t("基础设施未稳定:{b}", { b: rec.cfn.blockers.join(";") })}
                </Text>
              ) : null}
              {(rec.cfn?.stacks ?? []).filter((x) => x.failureReason).map((x) => (
                <Text key={x.name} type="danger" style={{ fontSize: 12, display: "block" }} data-testid="stack-failure-reason">
                  {t("失败原因")}({x.name}):{x.failureReason}
                </Text>
              ))}
              <Tooltip
                title={
                  rec.recoverableNow
                    ? t("清除在途会话与部署锁并记录失败;须二次确认(SPEC §3.5b)")
                    : t("服务端判定现在还不能恢复:{r}", { r: rec.reason })
                }
              >
                <Button
                  danger
                  size="small"
                  icon={<MedicineBoxOutlined />}
                  loading={recovering}
                  disabled={!rec.recoverableNow}
                  onClick={doRecover}
                >
                  {t("恢复(记录失败并解锁)")}
                </Button>
              </Tooltip>
            </Space>
          }
        />
      ) : null}

      {(rec?.sessionInFlight && !rec.needed) || recUnknown ? (
        <Alert
          style={{ marginTop: 8 }}
          type="info"
          showIcon
          message={recUnknown ? t("恢复状态未知") : t("部署会话在途")}
          description={
            <Text type="secondary" style={{ fontSize: 12 }}>
              {recUnknown ? deployBlockedReason : rec?.reason}
            </Text>
          }
        />
      ) : null}

      <Divider titlePlacement="start" plain>
        {t("部署进度")}
      </Divider>
      {/* @kf-batch 50-WP16-zero-egress:取代 K-5 的「网络规模」行(INTERACTION v2.21)。
          只显示**观测到的事实**,不给「n / n」这种需要期望值的分数 —— 期望清单的唯一作者在
          infra 的 endpoints.ts,platform 跨不过构建边界;拿它对账的是 synth 门禁与 net0 判据,
          不是这个界面(界面编一个分母出来就是第二个作者)。 */}
      {!isHome ? (
        <div style={{ marginBottom: 8 }} data-testid="network-row">
          <Space wrap size="small">
            <Text type="secondary">{t("网络")}:</Text>
            <Tag color="green" data-testid="network-zero-egress">{t("零出网")}</Tag>
            <Text type="secondary" style={{ fontSize: 12 }} data-testid="network-endpoint-count">
              {t("VPC 端点 {n} 个", { n: String(endpointCount) })}
            </Text>
            {crossRegionOk ? (
              <Tag color="blue" data-testid="network-home-link">{t("跨区私连 → 主控区 ✓")}</Tag>
            ) : (
              <Tooltip title={t("描述符里没有跨区端点 / 私有托管域 —— 该 target 可能还没走完切换动线;探活项 network:home-link 会说明原因")}>
                <Tag data-testid="network-home-link-missing">{t("跨区私连 未就位")}</Tag>
              </Tooltip>
            )}
          </Space>
        </div>
      ) : null}
      {!isHome && DEPLOYABLE_STATUS.has(target.status) ? (
        <div style={{ marginBottom: 8 }}>
          <Tooltip
            title={
              deployBlocked
                ? deployBlockedReason
                : t("经窄权 broker 触发 CodeBuild(§12.0);同环境并发部署会被部署锁拒绝(409)")
            }
          >
            <Button icon={<RocketOutlined />} loading={deploying} disabled={deployBlocked} onClick={doDeploy}>
              {target.status === "registered" ? t("触发部署") : t("重新部署")}
            </Button>
          </Tooltip>
        </div>
      ) : null}
      <BuildProgress targetId={target.targetId} />

      <Divider titlePlacement="start" plain>
        {t("初始化 / 探活")}
      </Divider>
      <Space style={{ marginBottom: 8 }}>
        {regionNotEnabled && (
          <Alert
            type="warning"
            showIcon
            data-testid="region-not-enabled"
            style={{ marginBottom: 8 }}
            message={t("控制面尚未放行 region {r}:「检测初始化」会在放行前失败", { r: target.region })}
            description={t("运维:bash scripts/redeploy-platform.sh <profile> <home-region>(§1b 自动从执行环境注册表推导放行清单并重部署控制面;控制面 ECS 会滚动一次),完成后再点「检测初始化」。")}
          />
        )}
        {finalizeError && (
          <Alert
            type="error"
            showIcon
            data-testid="finalize-error"
            style={{ marginBottom: 8 }}
            message={t("完成序(finalize)未通过 —— 这是下面红项的真因")}
            description={finalizeError}
          />
        )}
        <Button icon={<ExperimentOutlined />} loading={probing} onClick={doProbe}>
          {t("检测初始化")}
        </Button>
        <Tooltip
          title={
            target.status !== "testing"
              ? t("须 status=testing 且探活全绿才可启用(当前 {s})", { s: target.status })
              : !probe?.ok
                ? t("探活未全绿")
                : undefined
          }
        >
          <Button
            type="primary"
            icon={<PoweroffOutlined />}
            loading={enabling}
            disabled={target.status !== "testing" || !probe?.ok}
            onClick={doEnable}
          >
            {t("启用")}
          </Button>
        </Tooltip>
        {probe?.at ? (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t("最近探活:{at}", { at: probe.at.slice(0, 19).replace("T", " ") })}
          </Text>
        ) : null}
      </Space>

      {/* ── 🔴 P50.3b-4:排空 / 回服务(SPEC §1.1 双轴)────────────────────────────
          运维在维护、腾挪、准备退役前需要"停接新活但让在途跑完"。没有这个入口,运维只能去改状态字段
          或干脆不排空(后者更危险)。🔴 home **不给**这个按钮 —— 排空控制面自己的执行环境 = 平台自断双腿
          (与「home 不显示删除入口」同一口径,后端另有 403 硬拒)。 */}
      {!target.isHome && (
        <Space style={{ marginBottom: 8 }} wrap>
          {intentDrain ? (
            <Tooltip title={t("恢复承接新工作;phase 需下一次**全绿探活**才回到「运行中」")}>
              <Button type="primary" loading={intentBusy} onClick={() => doSetIntent("serve")}>
                {t("恢复承接新工作")}
              </Button>
            </Tooltip>
          ) : (
            <Tooltip
              title={
                deployBlocked
                  ? t("有在途部署会话未收口 —— 部署途中改意图会让那次部署永远合不上栅栏,先收口再排空")
                  : t("停止承接新工作(同步生效);在途作业跑完,**不销毁任何资源**")
              }
            >
              <Button danger loading={intentBusy} disabled={deployBlocked} onClick={() => doSetIntent("drain")}>
                {t("排空(停接新工作)")}
              </Button>
            </Tooltip>
          )}
          <Text type="secondary" style={{ fontSize: 12 }}>
            {intentDrain
              ? t("当前意图:排空中 —— 不承接新工作(在途作业仍会跑完)")
              : t("当前意图:承接工作")}
          </Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t("排空 ≠ 删除:删除环境要走单独的销毁流程(影响预览 → 输名强确认 → 审批 → 销毁,数据桶保留)")}
          </Text>
        </Space>
      )}
      {probe?.items?.length ? (
        <List
          size="small"
          dataSource={probe.items}
          renderItem={(it) => (
            <List.Item style={{ padding: "4px 0" }}>
              <Space>
                {it.ok ? <CheckCircleTwoTone twoToneColor="#52c41a" /> : <CloseCircleTwoTone twoToneColor="#ff4d4f" />}
                <Text style={{ fontSize: 12 }}>{it.name}</Text>
                {it.error ? (
                  <Text type="danger" style={{ fontSize: 12 }}>
                    {it.error}
                  </Text>
                ) : null}
              </Space>
            </List.Item>
          )}
        />
      ) : (
        <Text type="secondary" style={{ fontSize: 12 }}>
          {t("尚无探活记录;探活项由已装组件驱动(core 探桶/表桶/Glue/Athena),未装组件不探不判")}
        </Text>
      )}

      <Divider titlePlacement="start" plain>
        {t("组件")}
      </Divider>
      {/* @kf-batch 50-PROD-B-seq33 ② —— 🔴🔴 不提供精简形态(用户 2026-10-10):这里只列**要求集**(+ 存量已装的停供组件),
          没有逐个「+ 补充部署」;缺了就整体〔补齐缺失组件〕(只为修存量,新注册的环境天生完整)。 */}
      {missingRequired.length > 0 && (
        <Alert
          data-testid="env-incomplete-alert"
          type="warning"
          showIcon
          style={{ marginBottom: 8 }}
          message={t("执行环境不完整:缺少 {m}", { m: missingRequired.join("、") })}
          description={
            <Space wrap>
              <Text style={{ fontSize: 12 }}>{t("每个执行环境都必须装齐全部组件(不提供精简形态)。")}</Text>
              {!isHome && (
                <Tooltip title={deployBlocked ? deployBlockedReason : t("经窄权 broker 一次补齐全部缺失组件的栈(纯新增,不动已有的有状态资源);先预演、再确认")}>
                  <Button
                    size="small"
                    type="primary"
                    data-testid="fill-missing-components"
                    disabled={!!adding || deployBlocked}
                    loading={adding === FILL_MISSING_KEY}
                    onClick={doFillMissing}
                  >
                    {t("补齐缺失组件")}
                  </Button>
                </Tooltip>
              )}
            </Space>
          }
        />
      )}
      <List
        size="small"
        dataSource={COMPONENT_META.filter((c) => requiredSet.includes(c.key) || installed.has(c.key))}
        renderItem={(c) => (
          <List.Item
            style={{
              padding: "4px 0",
              // @kf-batch 50-WP13-mwaa-region —— 深链高亮:从调度页跳来要补的那一行(背景 + 左侧色条)
              ...(highlightComponent === c.key && !installed.has(c.key)
                ? { background: "rgba(250,173,20,0.12)", borderLeft: "3px solid #faad14", paddingLeft: 8 }
                : {}),
            }}
            data-testid={`component-row-${c.key}`}
            data-highlight={highlightComponent === c.key && !installed.has(c.key) ? "1" : undefined}
          >
            <Space wrap>
              {installed.has(c.key) ? (
                <CheckCircleTwoTone twoToneColor="#52c41a" />
              ) : (
                <Text type="danger">✗</Text>
              )}
              <Text style={{ width: 130, display: "inline-block" }}>{c.label}</Text>
              {highlightComponent === c.key && !installed.has(c.key) && (
                <Tag color="orange" data-testid="component-highlight-alert">{t("从调度页跳转到此:点上方〔补齐缺失组件〕")}</Tag>
              )}
              <Text type="secondary" style={{ fontSize: 12 }}>
                {t(c.desc)}
              </Text>
            </Space>
          </List.Item>
        )}
      />

      {!isHome && (
        <>
          {/* @kf-batch 50-WP15-airflow-serverless —— 两者都装 ⇒ 「调度器偏好」单选(Serverless 默认 / MWAA);只影响之后的发布 */}
      {installed.has("mwaa") && installed.has("airflow-serverless") ? (
        <div style={{ margin: "8px 0 12px" }} data-testid="scheduler-preference-row">
          <Space wrap>
            <Text type="secondary">{t("调度器偏好")}:</Text>
            <Radio.Group
              data-testid="scheduler-preference"
              size="small"
              value={target.schedulerPreference ?? "serverless"}
              disabled={spBusy || deployBlocked}
              onChange={(e) => doSetSchedulerPreference(e.target.value as "serverless" | "mwaa")}
              /* @kf-batch 50-WP20b-retire-mwaa-preference
                 🔴 已停供的取值**禁用而不是隐藏**:隐藏会让存量双装目标上「现在是 MWAA」这件事凭空消失
                 (选中项都渲染不出来);禁用 + 「已停止提供」才能既说清现状、又说清为什么点不动。
                 与向导里经典 MWAA 那一行同一个做法(WP-20)。 */
              options={SCHEDULER_PREFERENCES.map((p) => ({
                value: p,
                label: isWritableSchedulerPreference(p)
                  ? t(SCHEDULER_PREFERENCE_LABEL[p].label)
                  : `${t(SCHEDULER_PREFERENCE_LABEL[p].label)}(${t("已停止提供")})`,
                disabled: !isWritableSchedulerPreference(p),
              }))}
            />
            <Text type="secondary" style={{ fontSize: 12 }}>{t("只影响之后的发布;已发布作业保持原调度器,重新发布时会先下线旧产物再切")}</Text>
          </Space>
        </div>
      ) : null}
      <Divider titlePlacement="start" plain>
            {t("危险区")}
          </Divider>
          {/* @kf-batch 50-WP30-discard —— 路 A「弃置」:从没装出来的环境(目标区没有它的资源)一键退役、释放该区名额。
              🔴 前端只做**提示性**分流(status ∈ registered/initializing/failed 且从没 ready);最终判定在服务端
              (`lib/exec-env/discard.ts` 现查 CFN),不满足会 409 并把原因原样显示。 */}
          {DISCARDABLE_STATUS.has(target.status) && target.ready !== true ? (
            <Alert
              type="warning"
              showIcon
              data-testid="exec-env-discard-zone"
              message={t("弃置这个执行环境")}
              description={
                <Space direction="vertical" size={4}>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {t("这个环境从没装出来(目标区域里没有它的资源)。弃置后它显示为「已删除」,并释放 {region} 的执行环境名额,可以在该区重新注册。", { region: target.region })}
                  </Text>
                  <Button danger size="small" data-testid="exec-env-discard-btn" onClick={() => { setDiscardText(""); setDiscardOpen(true); }}>
                    {t("弃置这个环境")}
                  </Button>
                </Space>
              }
            />
          ) : (
            // @kf-batch 50-WP30-decommission —— 路 B「下线销毁」:停止承接 → 影响预览 → 输 region 名 → 审批 → 销毁 → 已删除 / 卡住重试
            <DecommissionPanel target={target} onChanged={onChanged} />
          )}
          <Modal
            open={discardOpen}
            title={t("确认弃置 {tid}", { tid: target.targetId })}
            okText={t("弃置")}
            okButtonProps={{ danger: true, disabled: discardText !== target.targetId, loading: discardBusy, "data-testid": "exec-env-discard-ok" } as never}
            onOk={doDiscard}
            onCancel={() => setDiscardOpen(false)}
          >
            <Space direction="vertical" style={{ width: "100%" }}>
              <Text>{t("请输入 {tid} 以确认(平台会先现查目标区域里确实没有这个环境的任何栈)。", { tid: target.targetId })}</Text>
              <Input data-testid="exec-env-discard-input" value={discardText} onChange={(e) => setDiscardText(e.target.value)} placeholder={target.targetId} />
            </Space>
          </Modal>
        </>
      )}

      {/* ── 🔴 P0-E:预演/审批弹窗(SPEC §3.5c ①③)────────────────────────────────
          【为什么必须有这个界面】P0-E 是"唯一能毁数据的洞":补组件在源漂移下可能 REPLACE
          Redshift namespace / MWAA env / S3 桶 / KMS key。让人**在动手之前看见逐条变更**,
          比任何事后回滚都便宜。审批绑 `planHash` —— 计划变一个字节旧批准自动失效。
          🔴 平台这一侧只是"把批准递下去",要不要审批由 **build 侧重算**决定(平台可能被绕)。 */}
      <Modal
        open={preview !== null}
        title={
          preview?.phase === "running"
            ? preview.component === UPGRADE_KEY
              ? t("正在预演:重新部署(升级)会改什么(不执行任何变更)")
              : t("正在预演:这次补充部署会改什么(不执行任何变更)")
            : preview?.component === UPGRADE_KEY
              ? t("请确认这次重新部署(升级)的影响")
              : t("请确认这次补充部署的影响")
        }
        width={860}
        onCancel={() => setPreview(null)}
        maskClosable={preview?.phase !== "running"}
        footer={
          preview?.phase === "done" ? (
            <Space>
              <Button onClick={() => setPreview(null)}>{t("取消(不做任何变更)")}</Button>
              <Button
                type="primary"
                danger={preview.verdict.requiresApproval}
                loading={adding === preview.component}
                onClick={doApproveAndAdd}
              >
                {preview.verdict.requiresApproval
                  ? t("我已阅读并批准该计划,开始部署")
                  : preview.verdict.disruptive
                    ? t("确认部署(会打断在跑的作业)")
                    : t("确认部署(只增不改)")}
              </Button>
            </Space>
          ) : (
            <Button onClick={() => setPreview(null)}>{t("取消")}</Button>
          )
        }
      >
        {preview?.phase === "running" && (
          <Space direction="vertical" size={6}>
            <Text>{t("正在目标 region 创建 change set 并读取影响(只创建不执行,通常 1–3 分钟)…")}</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {t("buildId {id};预演产生的 change set 与空壳栈会被自动清理", { id: preview.buildId.slice(-12) })}
            </Text>
          </Space>
        )}
        {preview?.phase === "done" && (
          <Space direction="vertical" size={10} style={{ width: "100%" }}>
            <Alert
              type={preview.verdict.requiresApproval ? "error" : preview.verdict.disruptive ? "warning" : "success"}
              showIcon
              message={preview.summary || t("影响摘要")}
              description={
                <Space direction="vertical" size={2}>
                  <Text style={{ fontSize: 12 }}>
                    {t("组件:{comp};涉及 {sc} 个栈、共 {cc} 条变更", {
                      comp: preview.wanted.join(", "),
                      sc: String(preview.verdict.stackCount),
                      cc: String(preview.verdict.changeCount),
                    })}
                  </Text>
                  <Text style={{ fontSize: 12 }} type="secondary">
                    {t("计划指纹 {h}(批准绑这一份计划:计划一变旧批准自动失效)", { h: preview.verdict.planHash.slice(0, 24) })}
                  </Text>
                  {preview.verdict.baseline && (
                    <Text style={{ fontSize: 12 }} type="secondary">
                      {t("源基线:{st} —— {why}", {
                        st: preview.verdict.baseline.state,
                        why: preview.verdict.baseline.why,
                      })}
                    </Text>
                  )}
                </Space>
              }
            />
            {preview.verdict.reasons.length === 0 ? (
              <Text type="secondary">{t("没有任何删除/替换/原地改属性 —— 只新增资源,可边服务边部署。")}</Text>
            ) : (
              <List
                size="small"
                bordered
                dataSource={preview.verdict.reasons}
                renderItem={(r) => (
                  <List.Item>
                    <Space direction="vertical" size={0} style={{ width: "100%" }}>
                      <Space size={6} wrap>
                        <Tag color={r.requiresApproval ? "red" : "orange"}>{r.action}</Tag>
                        {r.stateful && <Tag color="volcano">{t("有状态资源")}</Tag>}
                        <Text strong style={{ fontSize: 12 }}>{r.logicalResourceId}</Text>
                        <Text type="secondary" style={{ fontSize: 12 }}>{r.resourceType}</Text>
                        <Text type="secondary" style={{ fontSize: 12 }}>{r.stackName}</Text>
                      </Space>
                      <Text style={{ fontSize: 12 }}>{r.why}</Text>
                    </Space>
                  </List.Item>
                )}
              />
            )}
          </Space>
        )}
      </Modal>
    </Drawer>
  );
}
