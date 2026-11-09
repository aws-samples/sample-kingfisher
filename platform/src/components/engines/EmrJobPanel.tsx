"use client";
// EMR Serverless 作业面板（自包含）。
// etl-jobs 页选中 EMR 引擎作业时渲染本组件，与老 Glue/Redshift 分支完全隔离（老执行逻辑零改动）。
// 覆盖：PySpark 脚本编辑 + 规格全暴露 + 连接信息前置(嵌网络顾问) + 参数顾问 + 运行/停止 + 运行历史 + 日志。

// 缺 MWAA 警示卡(EMR 定时逐 target 扇出;缺的区当场列全 + 直达补装)
import { fetchExecTargets } from "@/lib/exec-env/exec-targets-client";
import { runNowLabel } from "@/lib/scope/run-now-label";
// O2:运行对话框(默认跟随视角)+ 多区联动运行组行
import { RunTargetsModal, RunGroupsPanel } from "@/components/monitor/RunGroupPanel";
import MwaaMissingNotice from "@/components/scheduler/MwaaMissingNotice";
import { extractMwaaMissing, type MwaaMissingPayload } from "@/lib/scheduler/mwaa-missing";
import React, { useEffect, useRef, useState } from "react";
// home 的常量与别处同一个来源(不许再写一个字面量)
const HOME_TARGET = "tgt_home";
import {
  Button, Card, Input, Select, Space, Table, Tag, Alert, message, Modal, Tabs,
  InputNumber, Typography, Popconfirm, Spin, Collapse,
} from "antd";
import {
  PlayCircleOutlined, PauseCircleOutlined, SaveOutlined, RobotOutlined, FileTextOutlined,
  ReloadOutlined, ThunderboltOutlined, HistoryOutlined, ScheduleOutlined, RedoOutlined,
} from "@ant-design/icons";
import dynamic from "next/dynamic";
import NetworkAdvisorPanel from "@/components/network-advisor/NetworkAdvisorPanel";
import ParamAdvisorPanel from "@/components/param-advisor/ParamAdvisorPanel";
// 执行角色改为选择器(三组下拉 + 刷新 + 手填兜底 + 检查权限;角色顾问面板在其内)
import ExecutionRolePicker from "@/components/exec-roles/ExecutionRolePicker";
import JobLakeBucketsBlock, { type JobLakeDeclarationValue } from "@/components/lake/JobLakeBucketsBlock"; // 数据湖表桶路由:数据湖表桶声明块(与离线计算页共用)
import { useAuth } from "@/lib/auth/AuthProvider";
import { groupsFromToken } from "@/lib/auth/roles";
import DiagnosisButton from "@/components/common/DiagnosisButton";
// 慢模型下服务端 45s 转 202,aiFetchJson 自动轮询到终态;网关 504 的 HTML 也包成可读错误
import { aiFetchJson } from "@/lib/ai/client/ai-fetch";
import VersionHistoryDrawer from "@/components/common/VersionHistoryDrawer";
import PromoteButton from "@/components/common/PromoteButton";
import EnvTag from "@/components/common/EnvTag";
import EnvPromotionStatus from "@/components/common/EnvPromotionStatus";
import { useT } from "@/lib/i18n/useT";
// 页面「删除」读响应的唯一作者(失败 ⇒ 服务端原话)
import { deleteJson } from "@/lib/http/delete-json";
// 运行历史「触发」格(工作流回链)唯一作者;页签可由页面控制(深链 `?tab=runs`)
import RunTriggerCell from "@/components/monitor/RunTriggerCell";
import { isEtlJobsTab, type EtlJobsTab } from "@/lib/workflow/back-links";
import { CodegenGroundedOn, type CodegenGroundedOnValue } from "@/components/ai/CodegenGroundedOn";
// 免责告知弹窗(409 驱动,同意后重试)
import { useResidencyAck } from "@/components/residency/useResidencyAck";
import { fetchWithResidencyAck } from "@/lib/residency/client";
import {
  EMR_RELEASE_LABELS, EMR_ARCHITECTURES, EMR_CPU_OPTIONS, EMR_MEMORY_OPTIONS, EMR_SPEC_DEFAULT,
} from "@/lib/engines/emr/spec";
import { isEmrNetworkFilled, emrNetworkFromPrefill } from "@/lib/engines/emr/network";
import type { EngineJobView } from "@/types/engine-job";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), { ssr: false });
const { Text } = Typography;

const STATUS_COLOR: Record<string, string> = {
  succeeded: "green", running: "blue", failed: "red", stopped: "orange", draft: "default", ready: "gold",
};

const ENGINE = "emr-serverless";

export default function EmrJobPanel({ job, onChanged, onDeleted, activeTab, onTabChange }: {
  job: EngineJobView; onChanged: () => void; onDeleted: () => void;
  /** 页面控制的页签(离线计算页深链 `?tab=runs`);不传 ⇒ 面板自己管(与原来一样) */
  activeTab?: EtlJobsTab; onTabChange?: (tab: EtlJobsTab) => void;
}) {
  const t = useT();
  const [ownTab, setOwnTab] = useState<EtlJobsTab>("edit");
  const tab = activeTab ?? ownTab;
  const setTab = (k: string) => { if (!isEtlJobsTab(k)) return; setOwnTab(k); onTabChange?.(k); };
  // 免责告知弹窗(409 驱动,同意后重试)
  const { residencyModal, resolveAckRequired } = useResidencyAck();
  const { getToken } = useAuth();
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => { (async () => { try { setIsAdmin(groupsFromToken(await getToken()).includes("bgp-admin")); } catch { /* 忽略 */ } })(); }, [getToken]);
  const [script, setScript] = useState(job.script || "");
  const [spec, setSpec] = useState(job.spec || EMR_SPEC_DEFAULT);
  const [network, setNetwork] = useState(job.network || { subnetIds: [], securityGroupIds: [] });
  // BUG-1 修复(2026-07-04):连接信息从裸文本框改为真实 VPC/子网/SG 下拉(复用 /api/flink/network,
  // 与 Flink CDC 网络选择一致)。此前只能手敲 subnet-xxx/sg-xxx,用户不知填什么。
  const [netVpcs, setNetVpcs] = useState<any[]>([]);
  const [netSubnets, setNetSubnets] = useState<any[]>([]);
  const [netSgs, setNetSgs] = useState<any[]>([]);
  // 这份网络清单是哪个区的(护栏 2:落点必须一眼可见)
  const [netRegion, setNetRegion] = useState("");
  const [netVpc, setNetVpc] = useState<string | undefined>(undefined);
  const [sparkConf, setSparkConf] = useState<Array<{ k: string; v: string }>>(
    Object.entries(job.sparkConf || {}).map(([k, v]) => ({ k, v: String(v) }))
  );
  // 数据湖表桶路由:数据湖表桶声明(作业顶层 lakeBuckets / defaultCatalogAlias;不声明 = 本区全部路由)
  const [lake, setLake] = useState<JobLakeDeclarationValue>({ lakeBuckets: job.lakeBuckets, defaultCatalogAlias: job.defaultCatalogAlias });
  const [args, setArgs] = useState<string>((job.entryPointArguments || []).join(" "));
  const [runDate, setRunDate] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [runs, setRuns] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiResult, setAiResult] = useState<{ code: string; explanation: string; groundedOn?: CodegenGroundedOnValue } | null>(null);
  const [logModal, setLogModal] = useState<{ open: boolean; runId: string; logs: string[]; loading: boolean; status?: string; error?: string | null; logGroup?: string; scheduler?: string ; runType?: string }>({ open: false, runId: "", logs: [], loading: false });
  const pollRef = useRef<any>(null);
  // 补齐(对齐 Glue 面板):补数起止日期、周期调度 cron、版本历史。
  const [bfStart, setBfStart] = useState<string>("");
  const [bfEnd, setBfEnd] = useState<string>("");
  const [cron, setCron] = useState<string>(job.cronExpression || "");
  const [mwaaMissing, setMwaaMissing] = useState<MwaaMissingPayload | null>(null);
  const [versionOpen, setVersionOpen] = useState(false);
  // 执行区域(这个 Spark 作业在哪些区跑)。
  // 🔴 与离线作业面板同一个范式(多选 + 可见标签 + 全选按钮):多选 Select 在只勾一个值时
  //    长得跟单选一模一样,用户第一反应就是"只能选一个区域"(2026-09-04 用户实测反馈过一次)。
  const [targets, setTargets] = useState<string[]>(
    Array.isArray((job as any).targets) && (job as any).targets.length ? (job as any).targets : [HOME_TARGET]
  );
  const [execTargets, setExecTargets] = useState<Array<{ targetId: string; region: string; isHome: boolean }>>([]);
  // 护栏 2 用:只绑一个区时那个区的 region(拿不到退回原文案,不显示 targetId 充数)
  const runRegion = targets.length === 1 ? (execTargets.find((x) => x.targetId === targets[0])?.region || "") : "";
  const [targetsErr, setTargetsErr] = useState("");
  const [runPick, setRunPick] = useState(false);
  const [groupKey, setGroupKey] = useState(0);

  // job 切换时重载本地态。
  useEffect(() => {
    setScript(job.script || "");
    setSpec(job.spec || EMR_SPEC_DEFAULT);
    setNetwork(job.network || { subnetIds: [], securityGroupIds: [] });
    setSparkConf(Object.entries(job.sparkConf || {}).map(([k, v]) => ({ k, v: String(v) })));
    setLake({ lakeBuckets: job.lakeBuckets, defaultCatalogAlias: job.defaultCatalogAlias });
    setArgs((job.entryPointArguments || []).join(" "));
    setCron(job.cronExpression || "");
    setTargets(Array.isArray((job as any).targets) && (job as any).targets.length ? (job as any).targets : [HOME_TARGET]);
    fetchRuns();
    return () => clearInterval(pollRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.jobId]);

  // 拉真实 VPC/子网/SG(供连接信息下拉);失败静默(仍可手动/用顾问)。
  // 🔴 网络是**区域资源**,必须按这个作业的执行目标取。
  // 原来这里固定取主控区 ⇒ 一个只在 us-west-2 跑的 EMR 作业,网络下拉里给的是主控区的子网 / 安全组,
  // 选中后写进作业配置,提交 EMR 时才炸,而报错指向网络配置本身(排障会去查子网,而真因是区错了)。
  // 🔴 作业下发到**多个区**时,单独一份 network 配置本身就不成立(每个区的子网 / SG 都不同)——
  //    这里如实标注只列了第一个 target 的区,不假装那份配置对所有区都有效(见 SCOPE-COVERAGE-TASKS)。
  useEffect(() => {
    const netTid = targets[0] || HOME_TARGET;
    fetch(`/api/flink/network?targetId=${encodeURIComponent(netTid)}`).then((r) => r.json()).then((d) => {
      if (d?.success) {
        setNetRegion(d.data.region || "");
        setNetVpcs(d.data.vpcs || []); setNetSubnets(d.data.subnets || []); setNetSgs(d.data.securityGroups || []);
        // 有已选子网时反推 VPC,便于过滤展示。
        const first = (d.data.subnets || []).find((s: any) => (job.network?.subnetIds || []).includes(s.id));
        if (first) setNetVpc(first.vpcId);
      }
    }).catch(() => {});
    // 🔴 改了执行目标就要重拉:否则网络下拉还留着上一个区的子网(护栏 4)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targets.join(",")]);

  // 可下推的执行目标清单(服务端已过准入 + 组件 + 法域)。
  // 🔴 读失败要**显式说出来**:静默留空 = 界面上只剩 home 可选,用户会以为第二区域没建好。
  useEffect(() => {
    // W3e-12 真撞:路由回 {targets},这里曾按数组读 ⇒ .map is not a function ⇒「全选当前活跃区(0)」灰掉;读法收成单一作者
    fetchExecTargets("redshift").then(setExecTargets).catch((e) => setTargetsErr(String(e?.message || e)));
  }, []);

  const fetchRuns = () =>
    fetch(`/api/engines/${ENGINE}/${job.jobId}/runs`).then((r) => r.json()).then((d) => setRuns(d?.success ? d.data : [])).catch(() => {});

  const buildPayload = () => {
    const conf: Record<string, string> = {};
    sparkConf.forEach(({ k, v }) => { const key = k.trim(); if (key) conf[key] = v; });
    return {
      script, spec, network, sparkConf: conf,
      // 数据湖表桶路由:数据湖表桶声明(不声明 ⇒ 显式 null,让服务端把存量值清掉;服务端按绑定区校验)
      lakeBuckets: lake.lakeBuckets ?? null,
      defaultCatalogAlias: lake.defaultCatalogAlias ?? null,
      entryPointArguments: args.trim() ? args.trim().split(/\s+/) : [],
      // 🔴 绑定跟着保存一起走(服务端会过 `assertBindableTargetsForEngine` 校验)
      targets: targets.length ? targets : [HOME_TARGET],
    };
  };

  const doSave = async () => {
    const res = await fetch(`/api/engines/${ENGINE}/${job.jobId}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(buildPayload()),
    });
    const d = await res.json();
    if (d?.success) { message.success(t("已保存")); onChanged(); } else { message.error(d?.error?.message || t("保存失败")); }
    return d?.success;
  };

  const pollRuns = () => {
    clearInterval(pollRef.current);
    let n = 0;
    pollRef.current = setInterval(async () => {
      n++;
      await fetchRuns();
      const latest = (await (await fetch(`/api/engines/${ENGINE}/${job.jobId}/runs`)).json())?.data?.[0];
      if (n > 60 || (latest && latest.status !== "running")) { clearInterval(pollRef.current); onChanged(); }
    }, 8000);
  };

  // 绑多区就先问「这次在哪些区跑」(默认跟随视角);单绑定直接跑(存量动线不变)
  const runOrAsk = () => {
    if (targets.length > 1) setRunPick(true);
    else void doRun();
  };

  const doRun = async (o: { targets?: string[]; retryOfRunGroupId?: string } = {}) => {
    if (!script.trim()) { message.warning(t("脚本为空")); return; }
    // 根治·裂缝A(前端闸放行):网络未填时【不再硬拦】——后端 ensureApplication 会兜底填平台默认私有子网+
    // bgp-emr-sg(见 lib/engines/emr/application.ts)。此前硬 return 会挡住存量空网络作业的自愈,导致页面永远
    // 跑不了。改为轻提示后继续提交,让后端兜底(用户仍可在「连接信息」自选网络覆盖默认)。
    if (!isEmrNetworkFilled(network)) { message.info(t("未选网络,平台将用默认私有子网+安全组运行(如需指定可在「连接信息」选择)")); }
    setBusy(true);
    try {
      if (!(await doSave())) return;
      // 跨法域 target 首次运行 ⇒ 服务端 409 ⇒ 弹免责告知 ⇒ 同意留存 ⇒ 自动重试同一请求
      const payload: Record<string, unknown> = { runDate };
      if (o.targets?.length) payload.targets = o.targets;
      if (o.retryOfRunGroupId) payload.retryOfRunGroupId = o.retryOfRunGroupId;
      const { body: d, cancelled } = await fetchWithResidencyAck(`/api/engines/${ENGINE}/${job.jobId}/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }, resolveAckRequired);
      if (cancelled) return;
      if (d?.success) {
        // 🔴 **把"提交到了哪几个区"说出来**:只说"已提交运行"的话,多区域执行这件事在界面上
        //    完全不可见(离线作业那边正是因此被用户实测反馈过「看起来只能选一个区域」)。
        //    部分失败也要如实说 —— 不许把"2 个区跑成 1 个"显示成成功。
        const rs: Array<{ targetId?: string }> = d.data?.runs || [];
        const where = rs.map((x) => x.targetId).filter(Boolean).join("、");
        const fails: Array<{ targetId?: string; error?: string }> = d.data?.failures || [];
        message.success(
          t("已提交运行(业务日期 {date}){where}", { date: d.data.runDate || runDate, where: where ? t(" → {w}", { w: where }) : "" })
        );
        if (fails.length) {
          message.warning(t("其中 {n} 个区没提交成功:{d}", { n: fails.length, d: fails.map((f) => `${f.targetId}: ${f.error}`).join(" | ") }));
        }
        fetchRuns(); setGroupKey((k) => k + 1); pollRuns();
      }
      else message.error(d?.error?.message || t("运行失败"));
    } finally { setBusy(false); }
  };

  const doStop = async (runId: string) => {
    const res = await fetch(`/api/engines/${ENGINE}/${job.jobId}/stop`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId }) });
    const d = await res.json();
    if (d?.success) { message.success(t("已请求停止")); fetchRuns(); } else message.error(d?.error?.message || t("停止失败"));
  };

  const doDelete = async () => {
    try {
      await deleteJson(`/api/engines/${ENGINE}/${job.jobId}`);
      message.success(t("已删除作业（含 EMR application）")); onDeleted();
    } catch (e) {
      // R7 口径:服务端拒绝(如 409 JOB_IN_USE 仍被工作流引用)⇒ 原话呈现,不再一句「删除失败」吞掉
      message.error((e as Error).message || t("删除失败"));
    }
  };

  const viewLog = async (runId: string) => {
    setLogModal({ open: true, runId, logs: [], loading: true });
    try {
      const res = await fetch(`/api/engines/${ENGINE}/${job.jobId}/logs?runId=${encodeURIComponent(runId)}`);
      const d = await res.json();
      if (d?.success) setLogModal({ open: true, runId, logs: d.data.logs || [], loading: false, status: d.data.status, error: d.data.error, logGroup: d.data.logGroup, scheduler: d.data.scheduler, runType: d.data.runType });
      else setLogModal({ open: true, runId, logs: [d?.error?.message || t("加载失败")], loading: false });
    } catch (e: any) {
      setLogModal({ open: true, runId, logs: [e?.message || t("网络异常")], loading: false });
    }
  };

  const doGenerate = async () => {
    if (!aiPrompt.trim()) { message.warning(t("请描述这个作业要做什么")); return; }
    setAiLoading(true); setAiResult(null);
    try {
      const d = await aiFetchJson("/api/engines/generate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        // 按作业的章生成
        body: JSON.stringify({ prompt: aiPrompt, currentCode: script.trim() ? script : undefined, targetId: targets[0] }),
      });
      if (d?.success) setAiResult({ code: d.data.code, explanation: d.data.explanation, groundedOn: d.data.groundedOn });
      else message.error(d?.error?.message || t("生成失败"));
    } catch (e: any) { message.error(e?.message || t("网络异常")); }
    finally { setAiLoading(false); }
  };

  // 补数:对起止业务日期区间逐日提交(照抄 Glue 补数)。
  const doBackfill = async () => {
    if (!bfStart || !bfEnd) { message.warning(t("请填写补数起止日期")); return; }
    setBusy(true);
    try {
      if (!(await doSave())) return;
      const { body: d, cancelled } = await fetchWithResidencyAck(`/api/engines/${ENGINE}/${job.jobId}/backfill`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ startDate: bfStart, endDate: bfEnd }),
      }, resolveAckRequired);
      if (cancelled) return;
      if (d?.success) { message.success(t("已提交补数 {n} 个业务日期", { n: d.data.count })); fetchRuns(); pollRuns(); }
      else message.error(d?.error?.message || t("补数失败"));
    } finally { setBusy(false); }
  };

  // 重跑:以某历史运行相同业务日期重新提交。
  const doRerun = async (runId: string) => {
    const { body: d, cancelled } = await fetchWithResidencyAck(`/api/engines/${ENGINE}/${job.jobId}/rerun`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId }),
    }, resolveAckRequired);
    if (cancelled) return;
    if (d?.success) { message.success(t("已重跑（业务日期 {date}）", { date: d.data.runDate || "-" })); fetchRuns(); pollRuns(); }
    else message.error(d?.error?.message || t("重跑失败"));
  };

  // 发布 cron 调度到 MWAA。
  const doSchedule = async () => {
    if (!cron.trim()) { message.warning(t("请输入 cron 表达式，如 0 * * * *")); return; }
    setBusy(true);
    try {
      if (!(await doSave())) return;
      const res = await fetch(`/api/engines/${ENGINE}/${job.jobId}/schedule`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cronExpression: cron }),
      });
      const d = await res.json();
      const mm = extractMwaaMissing(d);
      setMwaaMissing(mm);
      if (mm) return; // 卡片已列全缺失区 + 直达补装
      if (d?.success) {
        const rows: any[] = d.data.rows || [];
        const okN = rows.filter((r) => r.status === "ok").length;
        if (d.data.partial) {
          message.warning(t("部分下发成功:{ok}/{all} 个区已发布;失败:{bad}", { ok: okN, all: rows.length, bad: rows.filter((r) => r.status !== "ok").map((r) => `${r.targetId}(${r.status})`).join("、") }));
        } else if (rows.length && rows.every((r) => r.scheduler === "serverless")) {
          message.success(t("已发布调度到 {n} 个区(Serverless workflow 已就绪,按 cron 触发)", { n: okN || 1 }));
        } else {
          message.success(t("已发布调度到 {n} 个区(MWAA 加载+解挂需 1~3 分钟)", { n: okN || 1 }));
        }
        onChanged();
      }
      else message.error(d?.error?.message || t("发布调度失败"));
    } finally { setBusy(false); }
  };

  // 〔触发一次调度〕(与离线计算页同口径)
  const doTrigger = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/engines/${ENGINE}/${job.jobId}/schedule/trigger`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
      const d = await res.json();
      if (d?.success) {
        const rows: any[] = d.data.rows || [];
        const okN = rows.filter((r) => r.status === "ok").length;
        if (d.data.partial) message.warning(t("部分触发成功:{ok}/{all};失败:{bad}", { ok: okN, all: rows.length, bad: rows.filter((r) => r.status !== "ok").map((r) => `${r.targetId}(${r.error || r.status})`).join("、") }));
        else message.success(t("已触发 {n} 个区的调度产物各跑一次(运行历史约 1 分钟后出现新行)", { n: okN }));
        setTimeout(() => fetchRuns(), 5000);
      } else message.error(d?.error?.message || t("触发失败"));
    } finally { setBusy(false); }
  };

  // 下线调度:pause + 删 MWAA DAG 文件。
  const doUnschedule = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/engines/${ENGINE}/${job.jobId}/schedule`, { method: "DELETE" });
      const d = await res.json();
      if (d?.success) { message.success(t("调度已下线(DAG {dagId} 已从 MWAA 移除)", { dagId: d.data.dagId })); setCron(""); onChanged(); }
      else message.error(d?.error?.message || t("下线失败"));
    } finally { setBusy(false); }
  };

  const setDriver = (patch: any) => setSpec({ ...spec, driver: { ...spec.driver, ...patch } });
  const setExecutor = (patch: any) => setSpec({ ...spec, executor: { ...spec.executor, ...patch } });

  return (
    <>
    {residencyModal}
    <Card size="small" title={<Space><EnvTag env={(job as { env?: string }).env || "dev"} current /><Tag color="volcano">EMR Serverless</Tag>{job.name}</Space>}
      extra={<Popconfirm title={t("删除该作业？会同时删除其专属 EMR application。")} onConfirm={doDelete}><a style={{ color: "red" }}>{t("删除")}</a></Popconfirm>}>

      {job.applicationCreateError && (
        <Alert type="warning" showIcon style={{ marginBottom: 8 }}
          message={t("EMR application 尚未创建成功（运行时会重试）")} description={job.applicationCreateError} />
      )}

      <Tabs activeKey={tab} onChange={setTab} items={[
        {
          key: "edit", label: t("脚本 & 规格"), children: (
            <>
              {/* 参数顾问：按数据量推荐 driver/executor 规格，一键预填 spec。 */}
              <ParamAdvisorPanel
                request={{ channel: "emr", current: { spec } }}
                onPrefill={(p) => {
                  if (p.channel === "emr" && p.spec) {
                    // architecture 顾问侧为 string,收窄回 EmrSpec 的字面量联合。
                    const arch = p.spec.architecture === "X86_64" ? "X86_64" : "ARM64";
                    setSpec({ ...spec, ...p.spec, architecture: arch });
                  }
                }}
                title={t("EMR 参数智能顾问")}
              />

              {/* 规格全暴露（拍板③）：release / 架构 / driver / executor / executorCount。 */}
              <Space wrap style={{ marginBottom: 8 }}>
                <Select size="small" value={spec.releaseLabel} style={{ width: 150 }} onChange={(v) => setSpec({ ...spec, releaseLabel: v })}
                  options={EMR_RELEASE_LABELS.map((x) => ({ label: x, value: x }))} />
                <Select size="small" value={spec.architecture} style={{ width: 120 }} onChange={(v) => setSpec({ ...spec, architecture: v })}
                  options={EMR_ARCHITECTURES.map((x) => ({ label: x, value: x }))} />
                <InputNumber size="small" min={1} max={100} value={spec.executorCount} onChange={(v) => setSpec({ ...spec, executorCount: Number(v) || 1 })} addonBefore="Executors" style={{ width: 150 }} />
              </Space>
              {/* 执行角色(留空=该区平台 EMR 角色;:账号内任何 emr-serverless.amazonaws.com 可承担的角色都能选,StartJobRun 时生效,无需重建 application) */}
              <div style={{ marginBottom: 8 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>{t("执行角色")}</Text>
                <ExecutionRolePicker
                  engine="emr"
                  size="small"
                  targetId={targets[0] || HOME_TARGET}
                  multiTargetHint={targets.length > 1}
                  value={spec.executionRoleArn || ""}
                  onChange={(arn) => setSpec({ ...spec, executionRoleArn: arn })}
                  isAdmin={isAdmin}
                  scriptCode={script}
                  advisorRequest={{ engine: "emr", resources: { needsS3Tables: true, needsGlueCatalog: true, needsRedshift: true, needsCloudWatchLogs: true } }}
                />
              </div>
              {/* 数据湖表桶路由:数据湖表桶 —— 与离线计算 Glue 作业同一个块(S3TablesCatalog 目录按路由逐条注入;spark.bgp.lakeCatalogs 读回路由图) */}
              <div style={{ marginBottom: 8 }}>
                <JobLakeBucketsBlock engine="emr" targetId={targets[0] || HOME_TARGET} multiTargetHint={targets.length > 1} value={lake} onChange={setLake} />
              </div>
              <Collapse size="small" style={{ marginBottom: 8 }} items={[{
                key: "spec", label: t("Driver / Executor 规格（CPU / 内存 / 磁盘）"),
                children: (
                  <Space direction="vertical" size={8} style={{ width: "100%" }}>
                    <Space wrap>
                      <Text type="secondary" style={{ width: 60, display: "inline-block" }}>Driver</Text>
                      <Select size="small" value={spec.driver.cpu} style={{ width: 120 }} onChange={(v) => setDriver({ cpu: v })} options={EMR_CPU_OPTIONS.map((x) => ({ label: x, value: x }))} />
                      <Select size="small" value={spec.driver.memory} style={{ width: 120 }} onChange={(v) => setDriver({ memory: v })} options={EMR_MEMORY_OPTIONS.map((x) => ({ label: x, value: x }))} />
                      <Input size="small" value={spec.driver.disk} placeholder={t("磁盘如 20 GB")} style={{ width: 130 }} onChange={(e) => setDriver({ disk: e.target.value })} />
                    </Space>
                    <Space wrap>
                      <Text type="secondary" style={{ width: 60, display: "inline-block" }}>Executor</Text>
                      <Select size="small" value={spec.executor.cpu} style={{ width: 120 }} onChange={(v) => setExecutor({ cpu: v })} options={EMR_CPU_OPTIONS.map((x) => ({ label: x, value: x }))} />
                      <Select size="small" value={spec.executor.memory} style={{ width: 120 }} onChange={(v) => setExecutor({ memory: v })} options={EMR_MEMORY_OPTIONS.map((x) => ({ label: x, value: x }))} />
                      <Input size="small" value={spec.executor.disk} placeholder={t("磁盘如 20 GB")} style={{ width: 130 }} onChange={(e) => setExecutor({ disk: e.target.value })} />
                    </Space>
                    <div>
                      <Text type="secondary" style={{ fontSize: 12 }}>{t("自定义 Spark conf（平台规格键不可覆盖；如 spark.sql.shuffle.partitions）：")}</Text>
                      {sparkConf.map((p, i) => (
                        <Space key={i} style={{ marginTop: 4 }} wrap>
                          <Input size="small" value={p.k} placeholder="spark.xxx" style={{ width: 280 }} onChange={(e) => setSparkConf(sparkConf.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))} />
                          <Input size="small" value={p.v} placeholder={t("值")} style={{ width: 200 }} onChange={(e) => setSparkConf(sparkConf.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))} />
                          <Button size="small" danger onClick={() => setSparkConf(sparkConf.filter((_, j) => j !== i))}>{t("删")}</Button>
                        </Space>
                      ))}
                      <div><Button size="small" style={{ marginTop: 4 }} onClick={() => setSparkConf([...sparkConf, { k: "", v: "" }])}>{t("添加 conf")}</Button></div>
                    </div>
                  </Space>
                ),
              }]} />

              {/* 连接信息前置（拍板③ "别乱丢垃圾"）：创建/运行前必须填清子网+SG；嵌网络顾问一键预填+校验。 */}
              <Collapse size="small" style={{ marginBottom: 8 }} defaultActiveKey={isEmrNetworkFilled(network) ? [] : ["net"]} items={[{
                key: "net",
                label: <Space>{t("连接信息（VPC 子网 / 安全组）")}{isEmrNetworkFilled(network) ? <Tag color="green">{t("已配置")}</Tag> : <Tag color="red">{t("未配置（运行前必填）")}</Tag>}</Space>,
                children: (
                  <Space direction="vertical" size={8} style={{ width: "100%" }}>
                    <NetworkAdvisorPanel
                      targetIds={targets}
                      request={{ computeKind: "emr", targets: [{ kind: "aws-service", service: "s3" }, { kind: "aws-service", service: "glue" }], constraints: { preferPrivate: true, avoidNatCost: true } }}
                      onPrefill={(p) => { const n = emrNetworkFromPrefill(p); if (n) { if (n.vpcId) setNetVpc(n.vpcId); setNetwork({ subnetIds: n.subnetIds, securityGroupIds: n.securityGroupIds }); message.success(t("已回填 VPC/子网/安全组")); } }}
                      title={t("EMR 网络连通性顾问")}
                    />
                    {/* VPC → 子网 → 安全组 三级下拉(真实资源,复用 /api/flink/network),对齐 Flink CDC 网络选择。 */}
                    {/* 护栏 2:这份清单属于哪个区必须一眼可见;
                        作业下发到多个区时,一份 network 配置覆盖不了所有区,如实说出来而不是默认它对。 */}
                    <Space wrap size={4}>
                      <span style={{ color: "#888", fontSize: 12 }}>{t("网络清单区域")}:</span>
                      <Tag color="blue" data-testid="emr-network-region">{netRegion || t("解析中…")}</Tag>
                      {targets.length > 1 && (
                        <Tag color="warning" data-testid="emr-network-multi-target">
                          {t("本作业下发 {n} 个区,而网络配置只有一份 —— 这里只列了 {r} 的子网 / 安全组", { n: targets.length, r: netRegion || targets[0] })}
                        </Tag>
                      )}
                    </Space>
                    <Space wrap>
                      <span style={{ color: "#888", fontSize: 12 }}>VPC:</span>
                      <Select size="small" value={netVpc} style={{ width: 230 }} placeholder={t("选择 VPC")} showSearch optionFilterProp="label" allowClear
                        onChange={(v) => { setNetVpc(v); setNetwork({ subnetIds: [], securityGroupIds: [] }); }}
                        options={netVpcs.map((x: any) => ({ label: `${x.name || x.id}(${x.cidr})`, value: x.id }))} />
                    </Space>
                    <Select size="small" mode="multiple" value={network.subnetIds} style={{ width: "100%" }} placeholder={t("选私有子网(可多选)")} showSearch optionFilterProp="label"
                      onChange={(v) => setNetwork({ ...network, subnetIds: v })}
                      options={netSubnets.filter((s: any) => !netVpc || s.vpcId === netVpc).map((s: any) => ({ label: `${s.name || s.id} · ${s.az}${s.isPrivate ? ` · ${t("私有")}` : ""}`, value: s.id }))} />
                    <Select size="small" mode="multiple" value={network.securityGroupIds} style={{ width: "100%" }} placeholder={t("选安全组(可多选)")} showSearch optionFilterProp="label"
                      onChange={(v) => setNetwork({ ...network, securityGroupIds: v })}
                      options={netSgs.filter((g: any) => !netVpc || g.vpcId === netVpc).map((g: any) => ({ label: `${g.name}(${g.id})`, value: g.id }))} />
                    <Text type="secondary" style={{ fontSize: 12 }}>{t("EMR Serverless application 需私有子网 + 安全组(选真实 VPC 资源;或用上方网络顾问一键预填)。修改后需保存并重建 application 才生效（新建作业时即建）。")}</Text>
                  </Space>
                ),
              }]} />

              <Input size="small" addonBefore={t("脚本入参(空格分隔;平台会在其后追加 --ds 等业务日期参数)")} value={args} placeholder={t("可留空;业务日期参数由平台按运行日期追加")} style={{ marginBottom: 8 }} onChange={(e) => setArgs(e.target.value)} />

              <div style={{ border: "1px solid #1d4254", borderRadius: 8, overflow: "hidden", marginBottom: 12 }}>
                <MonacoEditor height="320px" language="python" theme="vs-dark" value={script} onChange={(v) => setScript(v || "")} options={{ minimap: { enabled: false }, fontSize: 13 }} />
              </div>
              {/* 执行区域**多选**(一个 Spark 作业可绑多个区,INTERACTION §2.1)。
                  🔴 标签 + placeholder + 计数标签三件一起,"这是多选、现在绑了几个区"才一眼可见。 */}
              <Space wrap style={{ marginBottom: 8 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>{t("执行区域(可多选)")}</Text>
                <Select
                  size="small"
                  mode="multiple"
                  allowClear={false}
                  style={{ minWidth: 320 }}
                  value={targets}
                  onChange={(v: string[]) => setTargets(v.length ? v : [HOME_TARGET])}
                  placeholder={t("执行目标(可多选)")}
                  options={(execTargets.length ? execTargets : [{ targetId: HOME_TARGET, region: "", isHome: true }]).map((x) => ({
                    label: `${x.targetId}${x.region ? `(${x.region})` : ""}${x.isHome ? ` · ${t("本地")}` : ""}`,
                    value: x.targetId,
                  }))}
                />
                <Button size="small" disabled={execTargets.length === 0} onClick={() => setTargets(execTargets.map((x) => x.targetId))}>
                  {t("全选当前活跃区({count})", { count: execTargets.length })}
                </Button>
                {targets.length > 1 ? <Tag color="cyan">{t("多区域执行:{n} 个区", { n: targets.length })}</Tag> : null}
                {targetsErr ? <Text type="danger" style={{ fontSize: 12 }}>{t("执行目标清单读取失败:{e}", { e: targetsErr })}</Text> : null}
              </Space>
              <Space wrap>
                <Button icon={<RobotOutlined />} onClick={() => { setAiPrompt(""); setAiResult(null); setAiOpen(true); }} style={{ borderColor: "#22d3ee", color: "#22d3ee" }}>{t("AI 生成代码")}</Button>
                <Button icon={<SaveOutlined />} onClick={doSave}>{t("保存")}</Button>
                <Button icon={<HistoryOutlined />} onClick={() => setVersionOpen(true)}>{t("版本历史")}</Button>
                <PromoteButton type="engine-job" id={job.jobId} onPromoted={onChanged} />
                <EnvPromotionStatus type="engine-job" id={job.jobId} />
                <Input addonBefore={t("业务日期")} value={runDate} onChange={(e) => setRunDate(e.target.value)} style={{ width: 210 }} placeholder="YYYY-MM-DD" />
                <Button type="primary" data-testid="emr-run-btn" icon={<PlayCircleOutlined />} loading={busy} onClick={runOrAsk}>
                  {/* 护栏 2:写操作在按钮上复述目标。文案走唯一作者 —— 这里原来只写「立即运行」,
                      与同一页 Glue/Redshift 的「立即运行 · us-west-2」不一致(无头验收 2026-09-19 抓到)。 */}
                  {runNowLabel({ targets, regionOfSingle: runRegion, t })}
                </Button>
              </Space>

              {/* 补数:对起止业务日期区间逐日补跑(对齐 Glue 面板)。 */}
              <div style={{ marginTop: 12, padding: "8px 12px", background: "rgba(34,211,238,0.04)", border: "1px solid #1d4254", borderRadius: 8 }}>
                <Space wrap>
                  <Text type="secondary">{t("补数（历史日期区间）")}:</Text>
                  <Input size="small" value={bfStart} onChange={(e) => setBfStart(e.target.value)} placeholder={t("起 YYYY-MM-DD")} style={{ width: 140 }} />
                  <Input size="small" value={bfEnd} onChange={(e) => setBfEnd(e.target.value)} placeholder={t("止 YYYY-MM-DD")} style={{ width: 140 }} />
                  <Button size="small" icon={<HistoryOutlined />} loading={busy} onClick={doBackfill}>{t("补数")}</Button>
                  <Text type="secondary" style={{ fontSize: 12 }}>{t("区间≤31天,每个业务日期各跑一次")}</Text>
                </Space>
              </div>

              {/* 周期调度:cron → 发布到 MWAA;已调度可下线(对齐 Glue 面板)。 */}
              <div style={{ marginTop: 8, padding: "8px 12px", background: "rgba(34,211,238,0.04)", border: "1px solid #1d4254", borderRadius: 8 }}>
                <Space wrap>
                  <Text type="secondary">{t("周期调度")}:</Text>
                  <Input size="small" value={cron} onChange={(e) => setCron(e.target.value)} placeholder="cron: 0 * * * *" style={{ width: 160 }} />
                  <Button size="small" icon={<ScheduleOutlined />} loading={busy} onClick={doSchedule}>{t("发布到 MWAA 调度")}</Button>
                  {(job.scheduleEnabled || job.cronExpression) && (
                    <>
                      <Tag color="blue">{t("当前")}: {job.cronExpression}</Tag>
                      <Popconfirm title={t("从 MWAA 下线该调度(pause + 删 DAG)?")} onConfirm={doUnschedule}>
                        <Button size="small" danger icon={<PauseCircleOutlined />} loading={busy}>{t("下线调度")}</Button>
                      </Popconfirm>
                      <Popconfirm title={t("立刻让已发布的调度产物各跑一次(不改 cron)?")} onConfirm={doTrigger}>
                        <Button size="small" icon={<ThunderboltOutlined />} loading={busy} data-testid="scheduler-trigger">{t("触发一次调度")}</Button>
                      </Popconfirm>
                    </>
                  )}
                </Space>
                <MwaaMissingNotice payload={mwaaMissing} />
              </div>

              <Alert style={{ marginTop: 12 }} type="info" showIcon
                message={t("EMR Serverless 作业：每个作业一个独立 application（不共享，避免争抢）。保存后点「立即运行」提交一次 Spark job-run，冷启动约 1-2 分钟；业务日期以 --ds / --ds_nodash / --bizdate 等参数追加在脚本入参之后（脚本按参数名读取，与 Glue 作业同一套）。删除作业会同时删除其 application（不留垃圾）。")} />
            </>
          ),
        },
        {
          key: "runs", label: t("运行历史 ({n})", { n: runs.length }), children: (
            <>
              <Button size="small" icon={<ReloadOutlined />} onClick={fetchRuns} style={{ marginBottom: 8 }}>{t("刷新")}</Button>
              <Table size="small" rowKey="runId" dataSource={runs} pagination={{ pageSize: 10 }}
                columns={[
                  { title: t("状态"), dataIndex: "status", width: 90, render: (v: string) => <Tag color={STATUS_COLOR[v] || "default"}>{v}</Tag> },
                  // 🔴 这一列是"多区域一起执行"在界面上**唯一**的可见证据:扇出后同一次点击产生 N 条 run,
                  //    没有它,两条 run 在界面上完全无法区分(用户会觉得"还是单区域")。
                  //    值取 run 记录的章(不是作业当前绑定 —— 那样改绑定会把历史改写)。
                  {
                    title: t("执行区域"), dataIndex: "targetId", width: 130,
                    render: (v: string) => (!v || v === HOME_TARGET ? <Tag>{t("本地")}</Tag> : <Tag color="cyan">{v}</Tag>),
                  },
                  // 跨法域 run 的区域审计 ID(全量留在该区;home 为空)
                  {
                    title: t("审计"), dataIndex: "residencyAuditId", width: 100,
                    render: (v: string) => v && !String(v).startsWith("pending#")
                      ? <code data-testid="run-audit-id" style={{ fontSize: 11 }} title={v}>#{String(v).slice(-8)}</code>
                      : "-",
                  },
                  // 运行历史每行带调度器 tag
                  // 工作流触发的行 ⇒ 「由工作流「X」触发」可点回那次工作流运行(唯一作者 RunTriggerCell)
                  { title: t("触发"), dataIndex: "triggeredBy", width: 200, render: (_v: string, r: any) => <RunTriggerCell run={r} /> },
                  { title: t("业务日期"), dataIndex: "runDate", width: 110, render: (v: string) => v || "-" },
                  { title: t("开始"), dataIndex: "startedAt", render: (v: string) => v?.slice(0, 19).replace("T", " ") },
                  { title: t("耗时"), dataIndex: "duration", width: 70, render: (v: number) => (v ? `${v}s` : "-") },
                  { title: t("错误"), dataIndex: "error", ellipsis: true, render: (v: string) => v ? <Text type="danger" style={{ fontSize: 12 }}>{v}</Text> : "-" },
                  { title: t("操作"), key: "act", width: 330, render: (_: any, r: any) => (
                    <Space>
                      <Button size="small" icon={<FileTextOutlined />} onClick={() => viewLog(r.runId)}>{t("日志")}</Button>
                      {r.status === "running"
                        ? <Button size="small" danger icon={<PauseCircleOutlined />} onClick={() => doStop(r.runId)}>{t("停止")}</Button>
                        : <Button size="small" icon={<RedoOutlined />} onClick={() => doRerun(r.runId)}>{t("重跑")}</Button>}
                      {["succeeded", "failed"].includes(r.status) && <DiagnosisButton taskId={job.jobId} runId={r.runId} label={r.status === "failed" ? t("AI 诊断") : t("AI 分析")} />}
                    </Space>
                  ) },
                ]} />
            </>
          ),
        },
        {
          // O2:一次点击跑了多个区 ⇒ 这里出现一行「联动运行」
          key: "rungroups", label: t("联动运行"), children: (
            <RunGroupsPanel kind="engine-job" definitionId={job.jobId} engine={ENGINE} refreshKey={groupKey}
              onRetry={async (plan) => { await doRun({ targets: plan.targets, retryOfRunGroupId: plan.retryOfRunGroupId }); }} />
          ),
        },
      ]} />
      {/* 运行对话框(默认跟随执行范围视角) */}
      <RunTargetsModal open={runPick} bindings={targets} busy={busy}
        onCancel={() => setRunPick(false)}
        onRun={(picked) => { setRunPick(false); void doRun({ targets: picked }); }} />

      <Modal title={<Space><FileTextOutlined /> {t("运行日志")} {logModal.status && <Tag color={STATUS_COLOR[logModal.status] || "default"}>{logModal.status}</Tag>}
          {logModal.scheduler === "serverless" ? <Text type="secondary" style={{ fontSize: 12 }} data-testid="run-log-source">CloudWatch · {logModal.logGroup || "/aws/mwaa-serverless/"}</Text> : null}
          {/* 服务侧触发来源 */}
          {logModal.runType ? <Tag data-testid="run-log-trigger" color={logModal.runType === "SCHEDULED" ? "blue" : "purple"} style={{ fontSize: 11 }}>{logModal.runType === "SCHEDULED" ? t("本次触发:定时(服务侧)") : t("本次触发:手动(服务侧)")}</Tag> : null}</Space>}
        open={logModal.open} onCancel={() => setLogModal({ ...logModal, open: false })} width={1000}
        footer={[
          <Button key="refresh" icon={<ReloadOutlined />} loading={logModal.loading} onClick={() => viewLog(logModal.runId)}>{t("刷新")}</Button>,
          <Button key="close" onClick={() => setLogModal({ ...logModal, open: false })}>{t("关闭")}</Button>,
        ]}>
        {logModal.error && <Alert type="error" showIcon style={{ marginBottom: 8 }} message={t("错误")} description={logModal.error} />}
        <div style={{ maxHeight: 520, overflow: "auto", background: "#1e1e1e", color: "#d4d4d4", padding: 16, borderRadius: 8, fontFamily: "monospace", fontSize: 12, whiteSpace: "pre-wrap" }}>
          {logModal.loading ? <Spin tip={t("加载日志中…")}><div style={{ height: 40 }} /></Spin>
            : logModal.logs.length ? logModal.logs.map((l, i) => <div key={i}>{l}</div>)
            : <span style={{ color: "#808080" }}>{t("暂无日志")}</span>}
        </div>
        <Text type="secondary" style={{ fontSize: 12 }}>{t("EMR Serverless 日志来自 S3（SPARK_DRIVER stdout/stderr）；run 结束后完整可读，运行中可能延迟，点「刷新」。")}</Text>
      </Modal>

      <Modal title={<Space><RobotOutlined style={{ color: "#22d3ee" }} /> {t("AI 生成 PySpark")}</Space>}
        open={aiOpen} onCancel={() => setAiOpen(false)} width={860}
        footer={[
          <Button key="cancel" onClick={() => setAiOpen(false)}>{t("关闭")}</Button>,
          <Button key="gen" type="primary" icon={<RobotOutlined />} loading={aiLoading} onClick={doGenerate}>{aiResult ? t("重新生成") : t("生成")}</Button>,
          <Button key="apply" type="primary" ghost disabled={!aiResult?.code} onClick={() => { if (aiResult?.code) { setScript(aiResult.code); setAiOpen(false); message.success(t("已应用，请审阅后保存")); } }}>{t("应用到编辑器")}</Button>,
        ]}>
        <Space direction="vertical" style={{ width: "100%" }}>
          <Text type="secondary">{t("用自然语言描述作业逻辑，生成生产级 PySpark（EMR Serverless），仅供参考，不会自动执行。")}</Text>
          <Input.TextArea value={aiPrompt} onChange={(e) => setAiPrompt(e.target.value)} autoSize={{ minRows: 3, maxRows: 6 }}
            placeholder={t("例如：读取数据湖 orders 表，按地区聚合订单金额，写回 Iceberg 表 dws_region_amount，按业务日期增量。")} />
          {aiLoading && <Spin tip={t("正在生成……")}><div style={{ height: 48 }} /></Spin>}
          {aiResult && (
            <Card size="small" title={t("生成结果（审阅后应用）")}>
              <div style={{ border: "1px solid #1d4254", borderRadius: 8, overflow: "hidden", marginBottom: 8 }}>
                <MonacoEditor height="300px" language="python" theme="vs-dark" value={aiResult.code} options={{ readOnly: true, minimap: { enabled: false }, fontSize: 13 }} />
              </div>
              <div style={{ margin: "6px 0" }}><CodegenGroundedOn value={aiResult.groundedOn} boundTargets={targets} /></div>
              {aiResult.explanation && <Alert type="info" showIcon message={t("实现说明")} description={<div style={{ whiteSpace: "pre-wrap", fontSize: 13 }}>{aiResult.explanation}</div>} />}
            </Card>
          )}
        </Space>
      </Modal>

      {/* 版本历史(复用通用 drawer,type=engine-job;回滚后刷新)。 */}
      <VersionHistoryDrawer
        type="engine-job"
        id={job.jobId}
        open={versionOpen}
        onClose={() => setVersionOpen(false)}
        onRolledBack={() => { setVersionOpen(false); onChanged(); }}
      />
    </Card>
    </>
  );
}
