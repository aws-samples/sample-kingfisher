"use client";
// 页面删除读响应的唯一作者:失败呈现服务端原话,成功才提示「已删除」
import { deleteJson } from "@/lib/http/delete-json";

// 缺 MWAA 警示卡(在调度区当场列全 + 直达补装)
import { fetchExecTargets } from "@/lib/exec-env/exec-targets-client";
// O2:运行前问「在哪些区跑」(默认跟随视角)+ 多区联动运行组行
import { RunTargetsModal, RunGroupsPanel } from "@/components/monitor/RunGroupPanel";
import MwaaMissingNotice from "@/components/scheduler/MwaaMissingNotice";
import { runNowLabel } from "@/lib/scope/run-now-label";
import { liveRowOf } from "@/lib/scope/live-row";
import { extractMwaaMissing, mwaaMissingFromPreviewRows, type MwaaMissingPayload } from "@/lib/scheduler/mwaa-missing";
import React, { useEffect, useRef, useState } from "react";
import {
  Button, Card, Input, Select, Space, Table, Tag, Alert, message, Modal, Tabs,
  InputNumber, Typography, Popconfirm, Empty, Checkbox, Spin, Collapse,
} from "antd";
import {
  CodeOutlined, PlayCircleOutlined, PauseCircleOutlined, SaveOutlined, ScheduleOutlined, PlusOutlined,
  DeleteOutlined, ReloadOutlined, HistoryOutlined, ExperimentOutlined, RedoOutlined, FieldTimeOutlined,
  ApartmentOutlined, RobotOutlined, FileTextOutlined, ThunderboltOutlined } from "@ant-design/icons";
import dynamic from "next/dynamic";
import { ETL_GLUE_TEMPLATE, ETL_REDSHIFT_TEMPLATE, type EtlJob } from "@/types/etl-job";
import { EMR_PYSPARK_TEMPLATE, type EngineJobView } from "@/types/engine-job";
import VersionHistoryDrawer from "@/components/common/VersionHistoryDrawer";
import ParamAdvisorPanel from "@/components/param-advisor/ParamAdvisorPanel";
// 执行角色改为选择器(三组下拉 + 刷新 + 手填兜底 + 检查权限;角色顾问面板在其内)
import ExecutionRolePicker from "@/components/exec-roles/ExecutionRolePicker";
import JobLakeBucketsBlock from "@/components/lake/JobLakeBucketsBlock"; // 数据湖表桶路由:数据湖表桶声明块(与 EMR 面板共用)
import NetworkAdvisorPanel from "@/components/network-advisor/NetworkAdvisorPanel";
import EmrJobPanel from "@/components/engines/EmrJobPanel";
// 运行历史「触发」格(工作流回链)唯一作者;`?jobId=&tab=runs` 深链(工作流节点详情点回来)
import RunTriggerCell from "@/components/monitor/RunTriggerCell";
import { useSearchParams } from "next/navigation";
import { isEtlJobsTab, type EtlJobsTab } from "@/lib/workflow/back-links";
// 执行范围接入(50 SPEC §2.6;交互 INTERACTION §9)。
// 🔴 列表请求带上 `?scope=`,并按护栏 1 常驻「别处还有 N 条」提示 + 空态说清楚。
import { useScope } from "@/components/scope/ScopeProvider";
import OtherScopesHint, { ScopeEmptyHint } from "@/components/scope/OtherScopesHint";
import { landingOfScope, toScopeParam } from "@/lib/scope/scope";
import { groupsFromToken } from "@/lib/auth/roles";
import { useAuth } from "@/lib/auth/AuthProvider";
import { GLUE_WORKER_TYPES, GLUE_MAX_WORKERS, FLEX_CAPABLE_WORKER_TYPES } from "@/lib/etl/worker-types";
// Glue 版本清单 / 缺省 / 下拉文案的单一作者(缺省最高,用户可降版)
import { GLUE_VERSIONS, GLUE_VERSION_DEFAULT, GLUE_VERSION_FOR_UNVERSIONED_RECORDS, glueVersionLabel } from "@/lib/sync/glue-version";
import PromoteButton from "@/components/common/PromoteButton";
// 作业所在环境标签 + 各环境发布状态(客户 2026-10-19:找不到 dev → prod 的发布入口与结果)
import EnvTag from "@/components/common/EnvTag";
import EnvPromotionStatus from "@/components/common/EnvPromotionStatus";
import DiagnosisButton from "@/components/common/DiagnosisButton";
import { useT } from "@/lib/i18n/useT";
import { CodegenGroundedOn, type CodegenGroundedOnValue } from "@/components/ai/CodegenGroundedOn";
// 免责告知弹窗(409 驱动,同意后重试)
import { useResidencyAck } from "@/components/residency/useResidencyAck";
import { fetchWithResidencyAck } from "@/lib/residency/client";
// 慢模型下服务端 45s 转 202,aiFetchJson 自动轮询到终态;网关 504 的 HTML 也包成可读错误
import { aiFetchJson } from "@/lib/ai/client/ai-fetch";
// 前端默认值也收编到命名 SSOT(与改动前**同值**,零行为变化)。
// 🔴 待办:这里应改成"取当前执行目标的 workgroup"(env 覆盖与 per-target 实名都在服务端,
//    客户端拿不到)—— 届时改这一个 import 的用法即可,不必再回来找字面量。

// EMR 作业(engine=emr-serverless)在列表里的合并展示类型:老 EtlJob 无 engine 字段,
// EMR 作业带 engine。用一个联合视图渲染列表;选中后按 engine 分派到 EmrJobPanel 或老 Glue/Redshift UI。
const EMR_ENGINE = "emr-serverless";

// home target 常量 + 绑定归一 —— 🔴 与服务端 `bindingTargets()` **同一口径**:
// 三种形态(合同 `targets[]` / W3-a 落过的单值 `targetId` / 存量两个都没有)必须映到同一个答案,
// 否则"这个作业绑了哪些区"前后端会有两个说法(而界面显示的那个才是用户相信的)。
const HOME_TARGET = "tgt_home";
function bindingTargetsOf(j: any): string[] {
  const raw = Array.isArray(j?.targets) ? j.targets : [];
  const list = raw.map((x: unknown) => String(x ?? "").trim()).filter((x: string) => x.length > 0);
  if (list.length === 0 && typeof j?.targetId === "string" && j.targetId.trim()) list.push(j.targetId.trim());
  if (list.length === 0) return [HOME_TARGET];
  return list.filter((x: string, i: number) => list.indexOf(x) === i);
}

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), { ssr: false });
const { Title, Text } = Typography;

const STATUS_COLOR: Record<string, string> = {
  // `stopped`(用户取消)此前**不在表里** ⇒ 取消掉的 run
  // 在台账里显示成一个无色灰标签,与「不认识的状态」长得一模一样。色值与 EmrJobPanel 同款(单一约定)。
  succeeded: "green", running: "blue", failed: "red", stopped: "orange", draft: "default", ready: "gold",
};

/** 一个作业的台账里出现过的调度器种类(去重;缺省 mwaa)。 */
function schedulerTagsOf(j: { deployments?: Record<string, { scheduler?: string } | undefined> | null }): string[] {
  const out: string[] = [];
  for (const rec of Object.values(j?.deployments ?? {})) {
    const s = rec?.scheduler === "serverless" ? "serverless" : "mwaa";
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

export default function EtlJobsPage() {
  // 当前执行范围(顶栏选的那个;URL 是权威)+ 已装好的执行环境清单(拿 region 做按钮复述)。
  const { scope, targets: scopeTargets } = useScope();
  // 上提到这里:本页有**两处**取数要用(作业列表 + Glue 连接候选),
  // 原先只在下方定义,新加的候选取数只能靠 TDZ 侥幸成立 ⇒ 一份定义,谁都能用。
  const scopeParam = toScopeParam(scope);
  const scopeQs = scopeParam ? `?scope=${encodeURIComponent(scopeParam)}` : "";
  const t = useT();
  // 免责告知弹窗(409 驱动,同意后重试)
  const { residencyModal, resolveAckRequired } = useResidencyAck();
  const [jobs, setJobs] = useState<EtlJob[]>([]);
  const [emrJobs, setEmrJobs] = useState<EngineJobView[]>([]); // ：EMR 引擎作业(独立表 bgp-engine-jobs)
  const [selEmr, setSelEmr] = useState<EngineJobView | null>(null); // 选中的 EMR 作业(与 sel 互斥)
  const [sel, setSel] = useState<EtlJob | null>(null);
  // 右侧作业面板当前页签(ETL 的 Tabs 与 EMR 面板共用一份;深链 `?tab=runs` 落到这里)
  const [jobTab, setJobTab] = useState<EtlJobsTab>("edit");
  // 深链 `/etl-jobs?jobId=<id>&tab=runs`(工作流实例「节点详情」点回来):列表到了再选中那个作业并切页签;
  // 🔴 只在挂载后的 effect 里读 query(首帧与服务端一致);同一组参数只应用一次(用户之后点别的作业不被拉回)
  const searchParams = useSearchParams();
  const appliedDeepLinkRef = useRef<string>("");
  const [script, setScript] = useState("");
  const [cron, setCron] = useState("");
  const [glueCfg, setGlueCfg] = useState<any>({ workerType: "G.1X", numberOfWorkers: 2, glueVersion: GLUE_VERSION_DEFAULT });
  // Glue 连接候选:平台已建 Glue Connection 的数据源(访问 VPC 内私有源如 RDS 时,作业须引用其连接借 ENI 进 VPC)。
  // Glue 作业本身不选子网/SG(那是 Connection 资源的属性,在数据源层建);此处只选「引用哪个已有连接」。
  const [dsConns, setDsConns] = useState<Array<{ datasourceId: string; name: string; glueConnectionName: string }>>([]);
  // 🔴 Glue 连接候选必须按执行范围过滤:在 us-west-2 建作业却从
  // 主控区的数据源里挑连接,建出来的作业引用的是**另一个区的 Connection**,提交即失败(而下拉里
  // 明明有得选 ⇒ 看着像平台 bug)。`/api/datasources` 已支持 `?scope=`,此前只是没传。
  useEffect(() => {
    fetch(`/api/datasources?hasGlue=true${scopeParam ? `&scope=${encodeURIComponent(scopeParam)}` : ""}`).then((r) => r.json()).then((d) => {
      const items = Array.isArray(d) ? d : (d?.data || []);
      setDsConns(items.filter((x: any) => x?.glueConnectionName).map((x: any) => ({ datasourceId: x.datasourceId, name: x.name, glueConnectionName: x.glueConnectionName })));
    }).catch(() => {});
    // 🔴 切区要重拉候选,否则下拉里留着上一个区的连接(护栏 4)
  }, [scopeParam]);
  // 角色顾问一键创建仅平台管理员可见(与后端 requireAdmin 一致);非管理员看推荐+复制自建。
  const { getToken } = useAuth();
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => { (async () => { try { setIsAdmin(groupsFromToken(await getToken()).includes("bgp-admin")); } catch { /* 非登录态忽略 */ } })(); }, [getToken]);
  // 🔴 落点默认值一个都不给(原来打底 home 的 workgroup/database 常量):
  // 编辑框里空 = 服务端按作业绑定的执行目标解析(唯一作者 resolveRedshiftBinding;home 空值 == 旧缺省)。
  // 前端保留 home 常量 = 在客户端造第二个落点真值源,在别的区视角下显示的就是主控区的名字(向导同族)。
  const [rsCfg, setRsCfg] = useState<any>({ workgroupName: "", database: "" });
  // 执行目标(数据面下推:这个作业在哪个区域跑)。
  // 🔴 清单**必须来自服务端**(`/api/exec-targets`),不在前端拼 —— 前端拼等于第二个判据源,
  //    而"哪些目标可下推"是准入 + 组件 + 法域三条判据的合成,只有服务端知道。
  const [execTargets, setExecTargets] = useState<Array<{ targetId: string; region: string; isHome: boolean }>>([]);
  // 绑定是**多值**(50 SPEC §1.3a-S1 `targets?: string[]`)。
  // 🔴 W3-a 曾把它做成单值,于是「一个定义跑多个区」根本表达不出来,版本一致性矩阵每行也只会有
  // 一个格子有值 ⇒ 那张看板是假的。这里与服务端**同一个归一口径**(缺省 `["tgt_home"]`)。
  const [targets, setTargets] = useState<string[]>([HOME_TARGET]);
  // O2:运行对话框 + 组行刷新键
  const [runPick, setRunPick] = useState(false);
  const [groupKey, setGroupKey] = useState(0);
  const [targetsErr, setTargetsErr] = useState<string>("");
  // 下发预览(INTERACTION §2.2 机制B:先看清要往哪些区发什么、再确认)。
  const [previewOpen, setPreviewOpen] = useState(false);
  const [preview, setPreview] = useState<any>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  // 缺 MWAA 的 target(发布 409 / 预览行 code 两处同一张卡);成功即清
  const [mwaaMissing, setMwaaMissing] = useState<MwaaMissingPayload | null>(null);
  useEffect(() => {
    // 🔴 读法单一作者(lib/exec-env/exec-targets-client.ts);读失败要显式说出来:静默留空 = 界面上只剩 home 可选,用户会以为第二区域没建好。
    fetchExecTargets("redshift").then(setExecTargets).catch((e) => setTargetsErr(String(e?.message || e)));
  }, []);
  // 只要绑了任何非 home 的区,落点就不能再让用户手填(见下方 Select 旁的说明)。
  const nonHomeTarget = targets.some((x) => x !== HOME_TARGET);
  // 自定义 Job parameters(--key → value)以数组态编辑,保存时折回对象。
  const [jobParams, setJobParams] = useState<Array<{ k: string; v: string }>>([]);
  const [depUploading, setDepUploading] = useState(false);
  const [runs, setRuns] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<"glue" | "redshift" | "emr-serverless">("glue");
  const [versionOpen, setVersionOpen] = useState(false);
  const [runDate, setRunDate] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [bfOpen, setBfOpen] = useState(false);
  const [bfStart, setBfStart] = useState("");
  const [bfEnd, setBfEnd] = useState("");
  const [lineageOpen, setLineageOpen] = useState(false);
  const [lineagePreview, setLineagePreview] = useState<any>(null);
  // AI 辅助：自然语言 → 生成 ETL 代码。
  const [aiOpen, setAiOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiUseCurrent, setAiUseCurrent] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiResult, setAiResult] = useState<{ code: string; explanation: string; usage?: any; groundedOn?: CodegenGroundedOnValue; dialect?: { fixed: { ruleId: string; title: string }[]; violations: { ruleId: string; title: string; rule: string; severity: string }[] } } | null>(null);
  // Fix A: 运行日志/输出/错误查看。
  // serverless run 的日志来自 CloudWatch,标题要写明日志组(INTERACTION §2.2b)
  const [logModal, setLogModal] = useState<{ open: boolean; runId: string; logs: string[]; loading: boolean; status?: string; error?: string | null; logGroup?: string; scheduler?: string; runType?: string }>({ open: false, runId: "", logs: [], loading: false });
  const pollRef = useRef<any>(null);

  const viewLog = async (runId: string) => {
    if (!sel) return;
    setLogModal({ open: true, runId, logs: [], loading: true });
    try {
      const res = await fetch(`/api/etl-jobs/${sel.jobId}/logs?runId=${encodeURIComponent(runId)}`);
      const d = await res.json();
      if (d?.success) setLogModal({ open: true, runId, logs: d.data.logs || [], loading: false, status: d.data.status, error: d.data.error, logGroup: d.data.logGroup, scheduler: d.data.scheduler, runType: d.data.runType });
      else setLogModal({ open: true, runId, logs: [d?.error?.message || t("加载失败")], loading: false });
    } catch (e: any) {
      setLogModal({ open: true, runId, logs: [e?.message || t("网络异常")], loading: false });
    }
  };

  // 两条列表请求都带当前执行范围;`global` 时 `toScopeParam` 回 null
  // ⇒ **URL 与改动前逐字节相同**(判据 回滚点),不会凭空多出一个 `?scope=global`。
  // 护栏 2 用:作业只绑一个区时,那个区的 region(拿不到就退回原文案,绝不显示 targetId 充数)
  const runTargetRegion =
    targets.length === 1 ? scopeTargets?.find((x) => x.targetId === targets[0])?.region || "" : "";
  // 🔴 选中项的**状态**一律从刷新后的列表现查(唯一作者 `liveRowOf`)——
  //   `sel` / `selEmr` 只记「选中了谁 + 编辑器里正在改什么」。发布成功后只刷列表不刷副本,
  //   会让同一屏上卡片说「已调度」而面板说「没调度」(2026-09-19 无头验收抓到)。
  const selLive = liveRowOf(jobs, sel, "jobId");
  const selEmrLive = liveRowOf(emrJobs, selEmr, "jobId");
  const fetchJobs = () => {
    fetch(`/api/etl-jobs${scopeQs}`).then((r) => r.json()).then((d) => setJobs(d?.success ? d.data : [])).catch(() => {});
    // ：并发拉 EMR 引擎作业(独立 API + 独立表);合并到同一列表展示。
    fetch(`/api/engines/${EMR_ENGINE}${scopeQs}`).then((r) => r.json()).then((d) => setEmrJobs(d?.success ? d.data : [])).catch(() => {});
  };
  const fetchRuns = (id: string) =>
    fetch(`/api/etl-jobs/${id}/runs`).then((r) => r.json()).then((d) => setRuns(d?.success ? d.data : [])).catch(() => {});

  // 🔴 `scopeQs` 进 deps:切范围**不重载页面**,靠这里重拉数据(护栏 4)。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { fetchJobs(); return () => clearInterval(pollRef.current); }, [scopeQs]);

  // 选中 EMR 作业(与老 Glue/Redshift 选中互斥)。
  const selectEmrJob = (j: EngineJobView) => { setSel(null); setSelEmr(j); };

  const selectJob = (j: EtlJob) => {
    setSelEmr(null);
    setSel(j);
    setScript(j.script || "");
    setCron(j.cronExpression || "");
    setMwaaMissing(null);
    // 选中**存量**作业:行里没存 Glue 版本的,编辑框显示(并在保存时写回)它被写下时的缺省 5.1,与运行侧 glueVersionOfRecord 同一口径;
    //   不许让新缺省 6.0 顶上去 —— 用户只改别的字段点保存,作业就被静默换版本。新建作业的缺省仍是 GLUE_VERSION_DEFAULT(state 初值)。
    if (j.type === "glue") setGlueCfg({ ...glueCfg, ...(j.glueConfig || {}), glueVersion: j.glueConfig?.glueVersion || GLUE_VERSION_FOR_UNVERSIONED_RECORDS });
    else if (j.glueConfig) setGlueCfg({ ...glueCfg, ...j.glueConfig });
    // 先归零再套作业自己的配置:原来是 `if (j.redshiftConfig) 合并`,选到一个没有 redshiftConfig 的作业时
    // 编辑框里留着的是**上一个作业**的落点值,再按保存就把别人的 workgroup 写进这个作业。
    setRsCfg({ workgroupName: "", database: "", ...(j.redshiftConfig || {}) });
    // 走**归一口**。🔴 真环境验收 W3a-15 就是被这一行咬的
    // 字段迁到 `targets[]` 之后这里还直读 `j.targetId` ⇒ 拿到 undefined ⇒ 界面把一个绑了
    // us-west-2 的作业显示成 home,**再按保存就把它改回 home 了**(静默改绑)。
    setTargets(bindingTargetsOf(j));
    setJobParams(Object.entries(j.glueConfig?.jobParameters || {}).map(([k, v]) => ({ k, v: String(v) })));
    fetchRuns(j.jobId);
  };

  useEffect(() => {
    const wantJob = searchParams?.get("jobId") || "";
    const wantTab = searchParams?.get("tab") || "";
    if (!wantJob) return;
    const key = `${wantJob}|${wantTab}`;
    if (appliedDeepLinkRef.current === key) return;
    const etl = jobs.find((j) => j.jobId === wantJob);
    const emr = etl ? undefined : emrJobs.find((j) => j.jobId === wantJob);
    if (!etl && !emr) return; // 列表还没到(或作业已不存在)⇒ 等下一次列表更新;不猜
    appliedDeepLinkRef.current = key;
    if (etl) selectJob(etl); else if (emr) selectEmrJob(emr);
    if (isEtlJobsTab(wantTab)) setJobTab(wantTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs, emrJobs, searchParams]);

  const doCreate = async () => {
    if (!newName.trim()) { message.warning(t("请输入作业名称")); return; }
    // ：EMR 引擎走独立 engines API（创建时后端建 per-作业 application）；Glue/Redshift 走老 API。
    if (newType === EMR_ENGINE) {
      const res = await fetch(`/api/engines/${EMR_ENGINE}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        // 🔴 新建落点 = 当前视角(单区 = 那个区;全部 = 主控区,显式)。
        //   原来不带 ⇒ 后端绑主控区、在主控区建 application,作业从 us-west-2 视角消失(段 wp31 W31-E1/E2)。
        body: JSON.stringify({ name: newName, script: EMR_PYSPARK_TEMPLATE, targets: [landingOfScope(scope)] }),
      });
      const d = await res.json();
      if (d?.success) {
        message.success(d.data.applicationCreateError ? t("已创建（EMR application 稍后重试创建）") : t("已创建（EMR application 已就绪）"));
        setCreateOpen(false); setNewName(""); await fetchJobs(); selectEmrJob(d.data);
      } else message.error(d?.error?.message || t("创建失败"));
      return;
    }
    const tpl = newType === "glue" ? ETL_GLUE_TEMPLATE : ETL_REDSHIFT_TEMPLATE;
    const res = await fetch("/api/etl-jobs", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName, type: newType, script: tpl, targets: [landingOfScope(scope)] }),
    });
    const d = await res.json();
    if (d?.success) { message.success(t("已创建")); setCreateOpen(false); setNewName(""); await fetchJobs(); selectJob(d.data); }
    else message.error(d?.error?.message || t("创建失败"));
  };

  const doSave = async (): Promise<boolean> => {
    if (!sel) return false;
    const payload: any = { script, cronExpression: cron };
    if (sel.type === "glue") {
      const jobParameters: Record<string, string> = {};
      jobParams.forEach(({ k, v }) => { const key = k.trim(); if (key) jobParameters[key] = v; });
      payload.glueConfig = { ...glueCfg, jobParameters };
    } else {
      // 🔴 非 home 时把 workgroup/database **清空**再存:非 home 的落点只能来自该目标的描述符
      // (服务端 `assertNoWarehouseConflict` 会拒掉不一致的值)。这里清空而不是"填成目标的值",
      // 是为了不在前端造第二个落点真值源 —— 那正是收编兜底字面量时消灭的东西。
      payload.redshiftConfig = nonHomeTarget ? { ...rsCfg, workgroupName: "", database: "" } : rsCfg;
    }
    // 写入侧只写 `targets`(单值字段已废,两个都写就有两个说法)。
    // W3e-11 真撞第二层:这一行原在 Redshift 分支里,Glue 作业保存**从不发绑定区**
    //    ⇒ 选择器显示 3 个区、存下去仍只有 home(API 能绑、页面存不进 = 假多区域)。两种类型一视同仁。
    payload.targets = targets;
    const res = await fetch(`/api/etl-jobs/${sel.jobId}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    const d = await res.json();
    if (d?.success) { message.success(t("已保存")); setSel(d.data); fetchJobs(); return true; }
    // 保存被拒(如执行角色预检 400「缺 s3:GetObject → 哪个桶 → 为什么要 → 出路」)时把服务端拒因**原话**给用户看
    //   改动前一句「保存失败」把拒因全吞了,用户只能去猜;多行 / 长文走对话框(pre-wrap),短的仍走轻提示。调用方据返回值决定还要不要继续
    //   (运行 / 试运行 / 补数 / 发布原来不看保存结果照样提交 ⇒ 跑的是**旧定义**而用户不知道)。
    const reason = String(d?.error?.message || "").trim();
    if (reason.length > 120 || reason.includes("\n")) {
      Modal.error({
        title: t("保存失败:服务端拒绝了这次保存"),
        width: 720,
        content: <pre data-testid="etl-save-rejection" style={{ whiteSpace: "pre-wrap", margin: 0, fontSize: 12, maxHeight: 420, overflow: "auto" }}>{reason}</pre>,
      });
    } else {
      message.error(reason ? t("保存失败:{reason}", { reason }) : t("保存失败"));
    }
    return false;
  };

  const pollRuns = (id: string) => {
    clearInterval(pollRef.current);
    let n = 0;
    pollRef.current = setInterval(async () => {
      n++;
      await fetchRuns(id);
      const latest = (await (await fetch(`/api/etl-jobs/${id}/runs`)).json())?.data?.[0];
      if (n > 40 || (latest && latest.status !== "running")) { clearInterval(pollRef.current); fetchJobs(); }
    }, 6000);
  };

  // 🔴 绑了**多个**区时先弹对话框问「这次在哪些区跑」(默认跟随视角);
  //    单绑定直接跑 —— 存量动线逐字节不变(多弹一个框会让所有单区用户多点一次)。
  const runOrAsk = () => {
    if (!sel) return;
    if (bindingTargetsOf(sel).length > 1) setRunPick(true);
    else void doRun();
  };

  const doRun = async (o: { targets?: string[]; retryOfRunGroupId?: string } = {}) => {
    if (!sel) return;
    setBusy(true);
    try {
      if (!(await doSave())) return;
      const payload: Record<string, unknown> = { runDate };
      if (o.targets?.length) payload.targets = o.targets;
      // 🔴 重试链只由服务端给的计划驱动(`/retry-failed` 是「哪些区失败」的权威),前端不自己挑
      if (o.retryOfRunGroupId) payload.retryOfRunGroupId = o.retryOfRunGroupId;
      // 跨法域 target 首次运行 ⇒ 服务端 409 ⇒ 弹免责告知 ⇒ 同意留存 ⇒ 自动重试同一请求
      const { body: d, cancelled } = await fetchWithResidencyAck(`/api/etl-jobs/${sel.jobId}/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }, resolveAckRequired);
      if (cancelled) return;
      if (d?.success) {
        // 🔴 逐区回报:提示里点名**哪几个区各起了一条 run**。
        // 只说"已提交运行"的话,多区域执行这件事在界面上不可见(用户实测反馈)。
        const rs: any[] = d.data.runs || [];
        const where = rs.map((x) => x.targetId).filter(Boolean).join("、");
        message.success(
          rs.length > 1
            ? t("已在 {n} 个区各提交一次运行:{where}(业务日期 {date})", { n: rs.length, where, date: d.data.runDate || runDate })
            : t("已提交运行（业务日期 {date}）", { date: d.data.runDate || runDate })
        );
        if (d.data.partial) {
          message.warning(
            t("其中 {n} 个区没起来:{list}", {
              n: (d.data.failures || []).length,
              list: (d.data.failures || []).map((f: any) => `${f.targetId}(${f.error})`).join("；"),
            })
          );
        }
        // 🔴 台账没记全**如实说**(它不影响组状态,但会少「定义版本」这类注解)
        if (d.data.groupLedgerIncomplete?.length) {
          message.warning(t("联动台账有 {n} 处没记上:{list}", { n: d.data.groupLedgerIncomplete.length, list: d.data.groupLedgerIncomplete.join(";") }));
        }
        fetchRuns(sel.jobId); pollRuns(sel.jobId); setGroupKey((k) => k + 1);
      }
      else message.error(d?.error?.message || t("运行失败"));
    } finally { setBusy(false); }
  };

  const doDryRun = async () => {
    if (!sel) return;
    setBusy(true);
    try {
      if (!(await doSave())) return;
      const { body: d, cancelled } = await fetchWithResidencyAck(`/api/etl-jobs/${sel.jobId}/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runDate, dryRun: true }) }, resolveAckRequired);
      if (cancelled) return;
      if (d?.success) { message.success(t("已提交试运行（EXPLAIN 校验，不写数据）")); fetchRuns(sel.jobId); pollRuns(sel.jobId); }
      else message.error(d?.error?.message || t("试运行失败"));
    } finally { setBusy(false); }
  };

  const doBackfill = async () => {
    if (!sel) return;
    setBusy(true);
    try {
      if (!(await doSave())) return;
      const { body: d, cancelled } = await fetchWithResidencyAck(`/api/etl-jobs/${sel.jobId}/backfill`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ startDate: bfStart, endDate: bfEnd }) }, resolveAckRequired);
      if (cancelled) return;
      if (d?.success) { message.success(t("已提交补数 {count} 天", { count: d.data.count })); setBfOpen(false); fetchRuns(sel.jobId); pollRuns(sel.jobId); }
      else message.error(d?.error?.message || t("补数失败"));
    } finally { setBusy(false); }
  };

  const doRerun = async (runId: string) => {
    if (!sel) return;
    const { body: d, cancelled } = await fetchWithResidencyAck(`/api/etl-jobs/${sel.jobId}/rerun`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId }) }, resolveAckRequired);
    if (cancelled) return;
    if (d?.success) { message.success(t("已重跑（业务日期 {date}）", { date: d.data.runDate || t("今天") })); fetchRuns(sel.jobId); pollRuns(sel.jobId); }
    else message.error(d?.error?.message || t("重跑失败"));
  };

  const openAi = () => { setAiPrompt(""); setAiUseCurrent(!!script.trim()); setAiResult(null); setAiOpen(true); };

  const doGenerate = async () => {
    if (!sel) return;
    if (!aiPrompt.trim()) { message.warning(t("请描述这个作业要做什么")); return; }
    setAiLoading(true); setAiResult(null);
    try {
      const d = await aiFetchJson("/api/etl-jobs/generate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        // 按作业的章生成(多区作业取第一个,页面回显并提示其余区须同构)
        body: JSON.stringify({ prompt: aiPrompt, targetType: sel.type, currentCode: aiUseCurrent ? script : undefined, targetId: targets[0] }),
      });
      if (d?.success) setAiResult({ code: d.data.code, explanation: d.data.explanation, usage: d.data.usage, dialect: d.data.dialect, groundedOn: d.data.groundedOn });
      else message.error(d?.error?.message || t("生成失败"));
    } catch (e: any) { message.error(e?.message || t("网络异常")); }
    finally { setAiLoading(false); }
  };

  const applyAi = () => {
    if (!aiResult?.code) return;
    setScript(aiResult.code);
    setAiOpen(false);
    message.success(t("已应用到编辑器，请审阅后保存"));
  };

  const doParseLineage = async () => {
    if (!sel) return;
    const res = await fetch("/api/lineage/parse", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql: script, database: rsCfg.database }),
    });
    const d = await res.json();
    if (d?.success) { setLineagePreview(d.data); setLineageOpen(true); }
    else message.error(d?.error?.message || t("解析失败"));
  };

  // 发布下推分两步(INTERACTION §2.2 机制B):**先预览**(GET,纯读、零副作用)→ 确认后再 POST 下发。
  // 🔴 单绑时不弹预览:存量作业全是单绑,给它们凭空加一次确认 = 白白多一次点击(便利性 §8.2)。
  const doSchedule = async () => {
    if (!sel) return;
    if (!cron.trim()) { message.warning(t("请输入 cron 表达式，如 0 * * * *")); return; }
    if (targets.length > 1) {
      setPreviewLoading(true);
      try {
        if (!(await doSave())) return; // 预览要基于**已保存的绑定**算,否则预览的是旧绑定
        const res = await fetch(`/api/etl-jobs/${sel.jobId}/schedule`);
        const d = await res.json();
        if (!d?.success) { message.error(d?.error?.message || t("算下发预览失败")); return; }
        setPreview(d.data);
        setMwaaMissing(mwaaMissingFromPreviewRows(d.data?.rows)); // 预览就把缺 MWAA 的区列出来(不必等到发布 409)
        setPreviewOpen(true);
      } finally { setPreviewLoading(false); }
      return;
    }
    await doPublish();
  };

  const doPublish = async () => {
    if (!sel) return;
    setBusy(true);
    try {
      if (!(await doSave())) return;
      const res = await fetch(`/api/etl-jobs/${sel.jobId}/schedule`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cronExpression: cron }),
      });
      const d = await res.json();
      setPreviewOpen(false);
      const mm = extractMwaaMissing(d);
      setMwaaMissing(mm);
      if (mm) return; // 卡片已列全缺失区 + 直达补装;不再叠一条通用 toast
      if (d?.success) {
        const rows: any[] = d.data.rows || [];
        const okN = rows.filter((r) => r.status === "ok").length;
        // 🔴 部分成功要说清楚"哪几个区没发出去",不许只报一句"已发布"——
        // 那正是「怕漏 region」这个痛点的发生方式。
        if (d.data.partial) {
          message.warning(
            t("部分下发成功:{ok}/{all} 个区已发布;失败:{bad}", {
              ok: okN, all: rows.length,
              bad: rows.filter((r) => r.status !== "ok").map((r) => `${r.targetId}(${r.status})`).join("、"),
            })
          );
        } else if (rows.length && rows.every((r) => r.scheduler === "serverless")) {
          message.success(t("已发布调度到 {n} 个区(Serverless workflow 已就绪,按 cron 触发)", { n: okN || 1 }));
        } else {
          message.success(t("已发布调度到 {n} 个区(MWAA 加载+解挂需 1~3 分钟)", { n: okN || 1 }));
        }
        fetchJobs();
      } else message.error(d?.error?.message || t("发布失败"));
    } finally { setBusy(false); }
  };

  // 〔触发一次调度〕:对已发布的 target 立刻跑一次调度产物(serverless ⇒ StartWorkflowRun)。
  const doTrigger = async () => {
    if (!sel) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/etl-jobs/${sel.jobId}/schedule/trigger`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
      const d = await res.json();
      if (d?.success) {
        const rows: any[] = d.data.rows || [];
        const okN = rows.filter((r) => r.status === "ok").length;
        if (d.data.partial) message.warning(t("部分触发成功:{ok}/{all};失败:{bad}", { ok: okN, all: rows.length, bad: rows.filter((r) => r.status !== "ok").map((r) => `${r.targetId}(${r.error || r.status})`).join("、") }));
        else message.success(t("已触发 {n} 个区的调度产物各跑一次(运行历史约 1 分钟后出现新行)", { n: okN }));
        setTimeout(() => fetchRuns(sel.jobId), 5000);
      } else message.error(d?.error?.message || t("触发失败"));
    } finally { setBusy(false); }
  };

  // 调度下线:pause DAG + 删 MWAA DAG 文件 + scheduleEnabled=false(发布的逆操作,不再需要手动登 MWAA)。
  const doUnschedule = async () => {
    if (!sel) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/etl-jobs/${sel.jobId}/schedule`, { method: "DELETE" });
      const d = await res.json();
      if (d?.success) { message.success(t("调度已下线(DAG {dagId} 已从 MWAA 移除)", { dagId: d.data.dagId })); setCron(""); fetchJobs(); }
      else message.error(d?.error?.message || t("下线失败"));
    } finally { setBusy(false); }
  };

  const doDelete = async (id: string) => {
    try {
      await deleteJson(`/api/etl-jobs/${id}`);
      message.success(t("已删除")); if (sel?.jobId === id) setSel(null); fetchJobs();
    } catch (e) {
      // 服务端拒绝 ⇒ 原话呈现(此前无条件提示「已删除」)
      message.error((e as Error).message || t("删除失败"));
    }
  };

  return (
    <div>
      {residencyModal}
      <Title level={3}><CodeOutlined /> {t("离线计算")}</Title>
      <Text type="secondary">{t("写代码方式的 ETL 开发：自写 Glue PySpark / Redshift SQL / EMR Serverless PySpark 作业，立即运行或用 MWAA 定时调度。多引擎可选，各引擎参数齐全暴露。")}</Text>
      {/* 护栏 1:target 视角常驻「其他执行范围还有 N 条」(INTERACTION §9.3-1)。
          🔴 这一条是本包最要紧的交互:AWS 式切区的最大痛点就是切错区后「东西不见了」而界面一个字都不说。 */}
      <OtherScopesHint resources={["etl-job", "engine-job"]} />

      <div style={{ display: "flex", gap: 16, marginTop: 16 }}>
        {/* 左：作业列表 */}
        <Card size="small" title={t("作业")} style={{ width: 280, flexShrink: 0 }}
          extra={<Button type="primary" size="small" data-testid="etl-new-btn" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>{t("新建")}</Button>}>
          {jobs.length === 0 && emrJobs.length === 0 ? (
            // 空态不许只说「暂无作业」:target 视角要说清「这个区没有、别处有几条」
            // 并给一键切「全部」(判据断的就是这段文案里的数字)。
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<ScopeEmptyHint resources={["etl-job", "engine-job"]} noun={t("作业")} />} />
          ) : (
            <Space direction="vertical" style={{ width: "100%" }}>
              {jobs.map((j) => (
                // 🔴 无头验收要能**认准对象**:原来只有边框颜色表示选中,
                // 而作业名在一张大卡里 ⇒ 脚本只能按文本模糊点,真环境实测点到了容器中心 = 选中**别的作业**,
                // 于是「下线」下到了另一个作业上(连锁假红,还留下孤儿 workflow)。
                // ⇒ 给每行一个稳定 testid + 把选中态显式暴露成 data-selected(纯附加属性,零视觉变化)。
                <div key={j.jobId} onClick={() => selectJob(j)}
                  data-testid={`job-row-${j.jobId}`} data-selected={sel?.jobId === j.jobId ? "true" : "false"}
                  style={{ cursor: "pointer", padding: 8, borderRadius: 6, border: sel?.jobId === j.jobId ? "1px solid #22d3ee" : "1px solid #1d4254" }}>
                  {/* 作业名**独占一行**并省略,标签行可换行。
                      2026-09-05 真环境(三个 target)抓到:标签 + 名字挤在一个不换行的 Space 里,名字被顶出卡片外(看不见也点不到)。 */}
                  <div style={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={j.name}>{j.name}</div>
                  <Space wrap size={[4, 4]} style={{ marginTop: 4 }}>
                    <Tag color={j.type === "glue" ? "purple" : "geekblue"} style={{ marginInlineEnd: 0 }}>{j.type === "glue" ? "Glue" : "Redshift"}</Tag>
                    {/* 非 home 的绑定**逐个**挂标,一眼看出在哪些区跑。
                        home 刻意**不挂标**:存量作业全是 home,挂满标反而把真正需要注意的那几个淹没。
                        🔴 走归一口 `bindingTargetsOf`,不直读字段(直读的那一版把迁移后的绑定显示成了 home)。 */}
                    {bindingTargetsOf(j)
                      .filter((x) => x !== HOME_TARGET)
                      .map((x) => (
                        <Tag color="cyan" key={x} style={{ marginInlineEnd: 0 }}>{x}</Tag>
                      ))}
                    {bindingTargetsOf(j).length > 1 ? <Tag color="geekblue" style={{ marginInlineEnd: 0 }}>🌐</Tag> : null}
                  </Space>
                  <div><Text type="secondary" style={{ fontSize: 12 }}>{j.scheduleEnabled ? `⏱ ${j.cronExpression}` : t("未调度")} · {j.lastRunStatus || t("未运行")}</Text>
                    {/* 哪个调度器在跑,页面必须说(INTERACTION §2.2b) */}
                    {schedulerTagsOf(j).map((sch) => (
                      <Tag key={sch} data-testid="job-scheduler-tag" color={sch === "serverless" ? "gold" : "default"} style={{ marginInlineStart: 6, fontSize: 11 }}>{sch === "serverless" ? "Serverless" : "MWAA"}</Tag>
                    ))}
                  </div>
                </div>
              ))}
              {/* ：EMR 引擎作业(独立表)合并展示,选中走 EmrJobPanel。 */}
              {emrJobs.map((j) => (
                <div key={j.jobId} onClick={() => selectEmrJob(j)}
                  data-testid={`engine-job-row-${j.jobId}`} data-selected={selEmr?.jobId === j.jobId ? "true" : "false"}
                  style={{ cursor: "pointer", padding: 8, borderRadius: 6, border: selEmr?.jobId === j.jobId ? "1px solid #22d3ee" : "1px solid #1d4254" }}>
                  <div style={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={j.name}>{j.name}</div>
                  <Space wrap size={[4, 4]} style={{ marginTop: 4 }}>
                    <Tag color="volcano" style={{ marginInlineEnd: 0 }}>EMR</Tag>
                    {/* 与 Glue / Redshift 卡片同口径:非 home 绑定逐个挂标 + 多区 🌐(原来 EMR 卡片不显示绑定,三引擎表达不一致) */}
                    {(Array.isArray((j as { targets?: unknown }).targets) ? ((j as { targets?: string[] }).targets as string[]) : [])
                      .filter((x) => x !== HOME_TARGET)
                      .map((x) => (
                        <Tag color="cyan" key={x} style={{ marginInlineEnd: 0 }}>{x}</Tag>
                      ))}
                    {Array.isArray((j as { targets?: unknown }).targets) && ((j as { targets?: string[] }).targets as string[]).length > 1 ? <Tag color="geekblue" style={{ marginInlineEnd: 0 }}>🌐</Tag> : null}
                  </Space>
                  <div><Text type="secondary" style={{ fontSize: 12 }}>EMR Serverless · {j.lastRunStatus || t("未运行")}</Text></div>
                </div>
              ))}
            </Space>
          )}
        </Card>

        {/* 右：编辑器 */}
        <div style={{ flex: 1 }}>
          {/* ：选中 EMR 引擎作业 → 独立 EmrJobPanel（老 Glue/Redshift UI 零改动）。 */}
          {selEmr ? (
            <EmrJobPanel
              job={selEmrLive || selEmr}
              onChanged={fetchJobs}
              onDeleted={() => { setSelEmr(null); fetchJobs(); }}
              activeTab={jobTab}
              onTabChange={setJobTab}
            />
          ) : !sel ? <Card><Empty description={t("从左侧选择或新建一个作业")} /></Card> : (
            <Card size="small" title={<Space><EnvTag env={(sel as { env?: string }).env || "dev"} current /><Tag color={sel.type === "glue" ? "purple" : "geekblue"}>{sel.type === "glue" ? "Glue PySpark" : "Redshift SQL"}</Tag>{targets.filter((x) => x !== HOME_TARGET).map((x) => <Tag color="cyan" key={x}>{x}</Tag>)}{sel.name}</Space>}
              extra={<Popconfirm title={t("删除该作业？")} onConfirm={() => doDelete(sel.jobId)}><a style={{ color: "red" }}><DeleteOutlined /> {t("删除")}</a></Popconfirm>}>
              <Tabs activeKey={jobTab} onChange={(k) => { if (isEtlJobsTab(k)) setJobTab(k); }} items={[
                {
                  key: "edit", label: t("脚本编辑"), children: (
                    <>
                      {/* 参数智能顾问:按运行历史(jobRef=已建 Glue 作业)与数据量推荐 worker/超时,一键预填。 */}
                      {sel.type === "glue" ? (
                        <ParamAdvisorPanel
                          request={{
                            channel: "glue-etl",
                            current: { glueConfig: glueCfg },
                            ...(sel.glueJobName ? { jobRef: { kind: "glue-job", id: sel.glueJobName } } : {}),
                          }}
                          onPrefill={(p) => { if (p.channel === "glue-etl") setGlueCfg({ ...glueCfg, ...p.glueConfig }); }}
                          title={t("Glue 参数智能顾问")}
                        />
                      ) : null}
                      <Space wrap style={{ marginBottom: 8 }}>
                        {sel.type === "glue" ? (
                          <>
                            <Select size="small" value={glueCfg.workerType} style={{ width: 200 }} onChange={(v) => setGlueCfg({ ...glueCfg, workerType: v })}
                              options={GLUE_WORKER_TYPES} />
                            <InputNumber size="small" min={2} max={GLUE_MAX_WORKERS} value={glueCfg.numberOfWorkers} onChange={(v) => setGlueCfg({ ...glueCfg, numberOfWorkers: v })} addonBefore="Workers" style={{ width: 140 }} />
                            <Select size="small" value={glueCfg.glueVersion || GLUE_VERSION_DEFAULT} style={{ width: 250 }} onChange={(v) => setGlueCfg({ ...glueCfg, glueVersion: v })}
                              data-testid="etl-glue-version" options={GLUE_VERSIONS.map((x) => ({ label: glueVersionLabel(x), value: x }))} />
                            <InputNumber size="small" min={5} max={2880} value={glueCfg.timeoutMinutes ?? 60} onChange={(v) => setGlueCfg({ ...glueCfg, timeoutMinutes: v })} addonBefore={t("超时(分)")} style={{ width: 150 }} />
                            {/* Glue 连接(可选):引用平台已建 Glue Connection 的数据源。访问 VPC 内私有源(如 RDS)才需要;
                                纯 S3/S3Tables 作业留空。VPC/子网/SG 是连接的属性(在数据源层配),此处只选引用哪个连接。 */}
                            <Select size="small" value={glueCfg.connectionName} style={{ width: 300 }} allowClear showSearch optionFilterProp="label"
                              placeholder={t("Glue 连接(可选,访问 VPC 内源如 RDS)")}
                              onChange={(v) => setGlueCfg({ ...glueCfg, connectionName: v })}
                              notFoundContent={<span style={{ fontSize: 12, color: "#888" }}>{t("暂无已建连接的数据源;可在「数据源管理」新建带网络的数据源")}</span>}
                              options={[
                                ...dsConns.map((c) => ({ label: `${c.name}（${c.glueConnectionName}）`, value: c.glueConnectionName })),
                                // 兼容既有作业:已保存的连接名若不在候选列表(如数据源已删/历史手填),仍作为选项保留可见。
                                ...(glueCfg.connectionName && !dsConns.some((c) => c.glueConnectionName === glueCfg.connectionName)
                                  ? [{ label: `${glueCfg.connectionName}（${t("既有")}）`, value: glueCfg.connectionName }] : []),
                              ]} />
                          </>
                        ) : null}
                        {/* W3e-11 页面驱动真撞:执行区域多选原来只在 Redshift 分支渲染(三元的 else 侧),
                            Glue 作业在页面上根本绑不了第二个区 —— API 能绑、页面不能 = 界面上的「假多区域」。清单与按钮对两种类型一视同仁。 */}
                        <>
                            {/* 执行目标**多选**(一个定义可绑多个区域,
                                INTERACTION §2.1)。清单只含服务端判定「可下推」的目标(准入 + 组件 + 法域)。 */}
                            {/* 🔴 必须有可见的标签:多选 Select 在只勾了一个值时**长得跟单选一模一样**,
                                用户第一反应就是"只能选一个区域"(2026-09-04 用户实测反馈)。
                                标签 + placeholder + 计数标签三件一起,才让"这是多选、现在绑了几个区"一眼可见。 */}
                            <Text type="secondary" style={{ fontSize: 12 }}>{t("执行区域(可多选)")}</Text>
                            <Select
                              size="small"
                              mode="multiple"
                              allowClear={false}
                              style={{ minWidth: 320 }}
                              value={targets}
                              // 🔴 清空时归一回 home,不允许「绑定为空」这个状态存在:
                              // 空绑定在服务端会被归一成 home,前端若显示为空,用户看到的与真相不一致。
                              onChange={(v: string[]) => setTargets(v.length ? v : [HOME_TARGET])}
                              placeholder={t("执行目标(可多选)")}
                              options={(execTargets.length ? execTargets : [{ targetId: HOME_TARGET, region: "", isHome: true }]).map((x) => ({
                                label: `${x.targetId}${x.region ? `(${x.region})` : ""}${x.isHome ? ` · ${t("本地")}` : ""}`,
                                value: x.targetId,
                              }))}
                            />
                            {/* 便利项(INTERACTION §2.1 用户拍板):一键绑到所有当前活跃且可下推的区。
                                🔴 清单本身已经过服务端「就绪 + 组件齐 + 同法域」筛选 ⇒ 这个按钮
                                不会把未就绪的区静默绑上(那正是 §2.1 明确禁止的)。 */}
                            <Button
                              size="small"
                              disabled={execTargets.length === 0}
                              onClick={() => setTargets(execTargets.map((x) => x.targetId))}
                            >
                              {t("全选当前活跃区({count})", { count: execTargets.length })}
                            </Button>
                            {targets.length > 1 ? (
                              <Tag color="geekblue">{t("🌐 多 region 共享:{n} 个区各跑一份", { n: targets.length })}</Tag>
                            ) : (
                              <Tag>{t("📍 区域专属")}</Tag>
                            )}
                            {/* 就绪清单读失败时"只剩 home 可选"是最容易被误读成"第二区域没建好"的形态 ⇒ 显式说出来 */}
                            {!targetsErr && execTargets.length <= 1 ? (
                              <Tag color="orange">{t("当前只有 1 个可下推区域(去「执行环境管理」建/补装组件后这里会多出来)")}</Tag>
                            ) : null}
                            {nonHomeTarget ? (
                              // 🔴 非 home:落点由该目标的描述符决定,**不给编辑框** ——
                              // 给了就会出现"我填的是 A、真跑在 B"这种最难查的形态。
                              <Tag color="blue">{t("落点由该执行目标决定(workgroup / database 取自其描述符)")}</Tag>
                            ) : (
                              <>
                                <Input size="small" value={rsCfg.workgroupName} addonBefore="Workgroup" style={{ width: 220 }} placeholder={t("留空自动解析")} onChange={(e) => setRsCfg({ ...rsCfg, workgroupName: e.target.value })} />
                                <Input size="small" value={rsCfg.database} addonBefore="DB" style={{ width: 160 }} placeholder={t("留空自动解析")} onChange={(e) => setRsCfg({ ...rsCfg, database: e.target.value })} />
                              </>
                            )}
                            {targetsErr ? <Tag color="red">{t("执行目标清单读取失败")}: {targetsErr}</Tag> : null}
                        </>
                      </Space>
                      {/* Glue 连接的网络连通性顾问(只读诊断):作业本身不配子网/SG(那是连接资源的属性)。
                          此处帮排查「作业经该连接能否到达源/S3/Secrets」,给建议;真正改网络在「数据源管理→网络配置」。 */}
                      {sel.type === "glue" && (
                        <div style={{ marginBottom: 8 }}>
                          <NetworkAdvisorPanel
                            targetIds={targets}
                            request={{ computeKind: "glue", targets: [{ kind: "aws-service", service: "s3" }], constraints: { preferPrivate: true } }}
                            title={t("网络连通性顾问(诊断 Glue 连接可达性)")}
                          />
                        </div>
                      )}
                      {/* 高级属性(对齐 Glue console 创建页):重试/执行类/书签/并发/自定义参数/依赖上传。 */}
                      {sel.type === "glue" && (
                        <Collapse size="small" style={{ marginBottom: 8 }} items={[{
                          key: "adv", label: t("高级属性(重试 / 执行类 / 书签 / 自定义参数 / 依赖库)"),
                          children: (
                            <Space direction="vertical" style={{ width: "100%" }} size={8}>
                              <Space wrap>
                                <InputNumber size="small" min={0} max={10} value={glueCfg.maxRetries ?? 0} onChange={(v) => setGlueCfg({ ...glueCfg, maxRetries: v })} addonBefore={t("重试次数")} style={{ width: 150 }} />
                                <Select size="small" value={glueCfg.executionClass || "STANDARD"} style={{ width: 200 }} onChange={(v) => setGlueCfg({ ...glueCfg, executionClass: v })}
                                  options={[{ label: t("STANDARD(标准)"), value: "STANDARD" }, { label: t("FLEX(弹性,更省)"), value: "FLEX", disabled: !FLEX_CAPABLE_WORKER_TYPES.includes(glueCfg.workerType) }]} />
                                <Select size="small" value={glueCfg.jobBookmark || "job-bookmark-disable"} style={{ width: 190 }} onChange={(v) => setGlueCfg({ ...glueCfg, jobBookmark: v })}
                                  options={[
                                    { label: t("书签:禁用"), value: "job-bookmark-disable" },
                                    { label: t("书签:启用(增量)"), value: "job-bookmark-enable" },
                                    { label: t("书签:暂停"), value: "job-bookmark-pause" },
                                  ]} />
                                <InputNumber size="small" min={1} max={100} value={glueCfg.maxConcurrentRuns ?? 3} onChange={(v) => setGlueCfg({ ...glueCfg, maxConcurrentRuns: v })} addonBefore={t("最大并发")} style={{ width: 160 }} />
                              </Space>
                              {/* 执行角色 = 账号内任何 glue.amazonaws.com 可承担的角色(与 AWS 一致),平台默认 / 顾问生成 / 自建三组,可刷新、可手填、保存前可检查权限 */}
                              <div>
                                <Text type="secondary" style={{ fontSize: 12 }}>{t("执行角色")}</Text>
                                <ExecutionRolePicker
                                  engine="glue"
                                  size="small"
                                  targetId={targets[0] || HOME_TARGET}
                                  multiTargetHint={targets.length > 1}
                                  value={glueCfg.executionRoleArn || ""}
                                  onChange={(arn) => setGlueCfg({ ...glueCfg, executionRoleArn: arn })}
                                  isAdmin={isAdmin}
                                  extraS3Uris={[glueCfg.extraJars, glueCfg.extraPyFiles].flatMap((v: unknown) => (typeof v === "string" ? v.split(",").map((x) => x.trim()).filter(Boolean) : []))}
                                  scriptCode={script}
                                  advisorRequest={{ engine: "glue", resources: { needsS3Tables: true, needsGlueCatalog: true, needsRedshift: true, needsCloudWatchLogs: true } }}
                                />
                              </div>
                              {/* 数据湖表桶路由:数据湖表桶 —— 本区路由多选(缺省全部)+ 每桶读 / 写 + 缺省目录 + 可用目录清单与三段名示例;落到 glueConfig.lakeBuckets / defaultCatalogAlias */}
                              <JobLakeBucketsBlock
                                engine="glue"
                                targetId={targets[0] || HOME_TARGET}
                                multiTargetHint={targets.length > 1}
                                value={{ lakeBuckets: glueCfg.lakeBuckets, defaultCatalogAlias: glueCfg.defaultCatalogAlias }}
                                onChange={(v) => setGlueCfg({ ...glueCfg, lakeBuckets: v.lakeBuckets, defaultCatalogAlias: v.defaultCatalogAlias })}
                              />
                              <div>
                                <Text type="secondary" style={{ fontSize: 12 }}>{t("Job parameters(自定义 --key 参数,脚本用 getResolvedOptions 读取;--conf 会追加到平台 Spark 配置后):")}</Text>
                                {jobParams.map((p, i) => (
                                  <Space key={i} style={{ marginTop: 4 }} wrap>
                                    <Input size="small" value={p.k} placeholder={t("参数名(如 src_table 或 --conf)")} style={{ width: 260 }}
                                      onChange={(e) => setJobParams(jobParams.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))} />
                                    <Input size="small" value={p.v} placeholder={t("值")} style={{ width: 320 }}
                                      onChange={(e) => setJobParams(jobParams.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))} />
                                    <Button size="small" danger icon={<DeleteOutlined />} onClick={() => setJobParams(jobParams.filter((_, j) => j !== i))} />
                                  </Space>
                                ))}
                                <div><Button size="small" icon={<PlusOutlined />} style={{ marginTop: 4 }} onClick={() => setJobParams([...jobParams, { k: "", v: "" }])}>{t("添加参数")}</Button></div>
                              </div>
                              <div>
                                <Text type="secondary" style={{ fontSize: 12 }}>{t("依赖库(上传后自动填 S3 URI;JAR → --extra-jars,Python .py/.whl/.zip → --extra-py-files,多个逗号分隔):")}</Text>
                                <Space direction="vertical" style={{ width: "100%", marginTop: 4 }} size={4}>
                                  <Space.Compact style={{ width: "100%" }}>
                                    <Input size="small" addonBefore="JAR" value={glueCfg.extraJars || ""} placeholder="s3://bucket/deps/foo.jar,s3://..." onChange={(e) => setGlueCfg({ ...glueCfg, extraJars: e.target.value })} />
                                  </Space.Compact>
                                  <Space.Compact style={{ width: "100%" }}>
                                    <Input size="small" addonBefore="PyFiles" value={glueCfg.extraPyFiles || ""} placeholder="s3://bucket/deps/utils.py,s3://.../pkg.whl" onChange={(e) => setGlueCfg({ ...glueCfg, extraPyFiles: e.target.value })} />
                                  </Space.Compact>
                                  <Space>
                                    <Button size="small" loading={depUploading} onClick={() => document.getElementById("etl-dep-file")?.click()}>{t("上传依赖文件")}</Button>
                                    <input id="etl-dep-file" type="file" accept=".jar,.py,.whl,.zip,.egg" style={{ display: "none" }}
                                      onChange={async (e) => {
                                        const f = e.target.files?.[0];
                                        (e.target as HTMLInputElement).value = "";
                                        if (!f || !sel) return;
                                        setDepUploading(true);
                                        try {
                                          const fd = new FormData();
                                          fd.append("file", f);
                                          const res = await fetch(`/api/etl-jobs/${sel.jobId}/deps`, { method: "POST", body: fd });
                                          const d = await res.json();
                                          if (d?.success) {
                                            const uri = d.data.s3Uri as string;
                                            const isJar = /\.jar$/i.test(f.name);
                                            const fieldKey = isJar ? "extraJars" : "extraPyFiles";
                                            const cur = String(glueCfg[fieldKey] || "");
                                            setGlueCfg({ ...glueCfg, [fieldKey]: cur ? `${cur},${uri}` : uri });
                                            message.success(t("已上传 {name} → {target}", { name: f.name, target: isJar ? "--extra-jars" : "--extra-py-files" }));
                                          } else message.error(d?.error?.message || t("上传失败"));
                                        } catch (err: any) { message.error(err?.message || t("上传失败")); }
                                        finally { setDepUploading(false); }
                                      }} />
                                    <Text type="secondary" style={{ fontSize: 12 }}>{t("≤100MB;保存后随作业下发")}</Text>
                                  </Space>
                                </Space>
                              </div>
                            </Space>
                          ),
                        }]} />
                      )}
                      <div style={{ border: "1px solid #1d4254", borderRadius: 8, overflow: "hidden", marginBottom: 12 }}>
                        <MonacoEditor height="340px" language={sel.type === "glue" ? "python" : "sql"} theme="vs-dark" value={script} onChange={(v) => setScript(v || "")} options={{ minimap: { enabled: false }, fontSize: 13 }} />
                      </div>
                      <Space wrap>
                        <Button icon={<RobotOutlined />} onClick={openAi} style={{ borderColor: "#22d3ee", color: "#22d3ee" }}>{t("AI 生成代码")}</Button>
                        <Button icon={<SaveOutlined />} onClick={doSave}>{t("保存")}</Button>
                        <Button icon={<HistoryOutlined />} onClick={() => setVersionOpen(true)}>{t("版本历史")}</Button>
                        <PromoteButton type="etl-job" id={sel.jobId} />
                        <EnvPromotionStatus type="etl-job" id={sel.jobId} />
                        <Input addonBefore={t("业务日期")} value={runDate} onChange={(e) => setRunDate(e.target.value)} style={{ width: 220 }} placeholder="YYYY-MM-DD" />
                        {/* 🔴 按钮上必须写清"会跑几个区":
                            扇出本来就发生在服务端(绑 N 个区 ⇒ N 条 run),但按钮不说的话用户
                            根本看不出"多区域一起执行"这件事发生了(2026-09-04 用户实测反馈)。 */}
                        {/* 护栏 2「写操作在按钮上复述目标」(INTERACTION §9.3-2;判据):
                            单区时把 **region** 写进按钮文案(「立即运行 · us-west-2」)。
                            🔴 复述的是**作业自己的绑定**(`targets`),不是顶栏当前视角 —— 真跑落在哪个区由绑定决定,
                            按钮要说的是"这一下会发生什么",说成视角就是误导。 */}
                        <Button type="primary" data-testid="etl-run-btn" icon={<PlayCircleOutlined />} loading={busy} onClick={runOrAsk}>
                          {/* 文案走唯一作者 `runNowLabel` —— 同一页的 EMR 面板曾经自己写了一份、少了区复述 */}
                          {runNowLabel({ targets, regionOfSingle: runTargetRegion, t })}
                        </Button>
                        {sel.type === "redshift" && (
                          <Button icon={<ExperimentOutlined />} loading={busy} onClick={doDryRun}>
                            {targets.length > 1 ? t("试运行({n} 个区)", { n: targets.length }) : t("试运行")}
                          </Button>
                        )}
                        {sel.type === "redshift" && (
                          <Button icon={<ApartmentOutlined />} onClick={doParseLineage}>{t("解析血缘")}</Button>
                        )}
                        <Button icon={<FieldTimeOutlined />} onClick={() => setBfOpen(true)}>{t("补数")}</Button>
                        <Input value={cron} onChange={(e) => setCron(e.target.value)} placeholder="cron: 0 * * * *" style={{ width: 160 }} />
                        <Button icon={<ScheduleOutlined />} loading={busy || previewLoading} onClick={doSchedule}>
                          {targets.length > 1 ? t("发布到 MWAA 调度({n} 个区)", { n: targets.length }) : t("发布到 MWAA 调度")}
                        </Button>
                        {selLive?.scheduleEnabled && (
                          <Popconfirm title={t("从 MWAA 下线该调度(pause + 删 DAG)?")} onConfirm={doUnschedule}>
                            <Button danger icon={<PauseCircleOutlined />} loading={busy}>{t("下线调度")}</Button>
                          </Popconfirm>
                        )}
                        {selLive?.scheduleEnabled && (
                          <Popconfirm title={t("立刻让已发布的调度产物各跑一次(不改 cron)?")} onConfirm={doTrigger}>
                            <Button icon={<ThunderboltOutlined />} loading={busy} data-testid="scheduler-trigger">{t("触发一次调度")}</Button>
                          </Popconfirm>
                        )}
                      </Space>
                      <MwaaMissingNotice payload={mwaaMissing} />
                      <Alert style={{ marginTop: 12 }} type="info" showIcon
                        message={sel.type === "glue"
                          ? t("Glue 作业：保存后点「立即运行」会创建/更新同名 Glue 作业并启动；冷启动约 1-2 分钟。业务日期作为 --ds/--ds_nodash 等参数传入（脚本用 getResolvedOptions 读取）。")
                          : t("Redshift SQL 作业：多条用分号分隔，经 Redshift Data API 执行。脚本可用 ${ds}/${ds_nodash}/${yesterday_ds} 等业务日期变量；「试运行」用 EXPLAIN 校验不写数据；「补数」按日期区间逐日跑。")} />
                    </>
                  ),
                },
                {
                  key: "runs", label: t("运行历史 ({count})", { count: runs.length }), children: (
                    <>
                      <Button size="small" icon={<ReloadOutlined />} onClick={() => sel && fetchRuns(sel.jobId)} style={{ marginBottom: 8 }}>{t("刷新")}</Button>
                      {/* 固定列合计约 1220px:视口 1600 以下不再把自适应的「开始 / 错误」两列挤成 0 宽(时间戳一字一行竖排、错误列消失),
                          而是横向滚动(2026-11-03 客户 1600 宽截图);「开始」给定宽,剩余宽度全归「错误」列。 */}
                      <Table size="small" rowKey="runId" dataSource={runs} pagination={{ pageSize: 10 }} scroll={{ x: 1400 }} data-testid="etl-run-history-table"
                        columns={[
                          { title: t("状态"), dataIndex: "status", width: 90, render: (v: string) => <Tag color={STATUS_COLOR[v] || "default"}>{v}</Tag> },
                          // 🔴 **这一列是"多区域一起执行"唯一的可见证据**:扇出后同一次点击产生 N 条 run,
                          // 没有这一列的话它们在界面上完全无法区分,用户只会觉得"还是单区域"(用户实测反馈)。
                          // 值取 run 记录的章(`targetId`),不是作业当前的绑定 —— 那样改了绑定会把历史改写。
                          {
                            title: t("执行区域"), dataIndex: "targetId", width: 130,
                            render: (v: string) =>
                              !v || v === HOME_TARGET
                                ? <Tag>{t("本地")}</Tag>
                                : <Tag color="cyan">{v}</Tag>,
                          },
                          // 跨法域 run 的区域审计 ID(全量留在该区;home 为空)
                          {
                            title: t("审计"), dataIndex: "residencyAuditId", width: 100,
                            render: (v: string) => v && !String(v).startsWith("pending#")
                              ? <code data-testid="run-audit-id" style={{ fontSize: 11 }} title={v}>#{String(v).slice(-8)}</code>
                              : "-",
                          },
                          { title: t("类型"), dataIndex: "taskType", width: 130 },
                          // 运行历史每行带调度器 tag(Serverless / MWAA)。
                          // 🔴 不再在行上显示 SCHEDULED / ON_DEMAND —— worker 侧分不出触发来源(实测 cron 与手动完全同形),
                          //   台账里刻意不存这个派生值;真值在服务侧,放在「日志」弹窗里按需展示(那里本来就要调服务)。
                          // 工作流触发的行 ⇒ 「由工作流「X」触发」可点回那次工作流运行(唯一作者 RunTriggerCell)
                          { title: t("触发"), dataIndex: "triggeredBy", width: 200, render: (_v: string, r: any) => <RunTriggerCell run={r} /> },
                          { title: t("业务日期"), dataIndex: "runDate", width: 110, render: (v: string) => v || "-" },
                          { title: t("开始"), dataIndex: "startedAt", width: 160, render: (v: string) => v?.slice(0, 19).replace("T", " ") },
                          { title: t("耗时"), dataIndex: "duration", width: 70, render: (v: number) => (v ? `${v}s` : "-") },
                          { title: t("错误"), dataIndex: "error", ellipsis: true, render: (v: string) => v ? <Text type="danger" style={{ fontSize: 12 }}>{v}</Text> : "-" },
                          { title: t("操作"), key: "act", width: 230, render: (_: any, r: any) => (
                            <Space>
                              <Button size="small" icon={<FileTextOutlined />} onClick={() => viewLog(r.runId)}>{t("日志")}</Button>
                              {["succeeded", "failed"].includes(r.status) && <DiagnosisButton taskId={sel.jobId} runId={r.runId} label={r.status === "failed" ? t("AI 诊断") : t("AI 分析")} />}
                              <Button size="small" icon={<RedoOutlined />} onClick={() => doRerun(r.runId)}>{t("重跑")}</Button>
                            </Space>
                          ) },
                        ]} />
                    </>
                  ),
                },
                {
                  // O2:一次点击跑了多个区 ⇒ 这里出现一行「联动运行」
                  key: "rungroups", label: t("联动运行"), children: (
                    <RunGroupsPanel kind="etl-job" definitionId={sel.jobId} refreshKey={groupKey}
                      onRetry={async (plan) => {
                        // 🔴 重试**不在这里扇出**:服务端只给「哪些区失败」的权威计划,
                        //    真正的运行仍走原来那条运行路由(它才有驻留同意 / 绑定校验 / 审计 / 运行锁)
                        await doRun({ targets: plan.targets, retryOfRunGroupId: plan.retryOfRunGroupId });
                      }} />
                  ),
                },
              ]} />
            </Card>
          )}
        </div>
      </div>

      <Modal title={t("新建 ETL 作业")} open={createOpen} onOk={doCreate} onCancel={() => setCreateOpen(false)} okText={t("创建")}>
        <Space direction="vertical" style={{ width: "100%" }}>
          <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t("作业名称")} />
          <Select value={newType} onChange={(v) => setNewType(v)} style={{ width: "100%" }}
            options={[
              { label: t("Glue PySpark 脚本作业"), value: "glue" },
              { label: t("Redshift SQL 作业"), value: "redshift" },
              { label: t("EMR Serverless（PySpark，独立引擎）"), value: EMR_ENGINE },
            ]} />
          <Text type="secondary">{t("创建后会预置一个脚本模板，可直接编辑。")}{newType === EMR_ENGINE ? t("EMR 引擎会为该作业创建一个独立的 Serverless application（不共享）。") : ""}</Text>
        </Space>
      </Modal>

      {sel && (
        <VersionHistoryDrawer
          type="etl-job"
          id={sel.jobId}
          open={versionOpen}
          onClose={() => setVersionOpen(false)}
          onRolledBack={async () => {
            setVersionOpen(false);
            const d = await fetch(`/api/etl-jobs/${sel.jobId}`).then((r) => r.json()).catch(() => null);
            if (d?.success) selectJob(d.data);
            fetchJobs();
          }}
        />
      )}

      {/* **下发预览**(INTERACTION §2.2 机制B「影响预览」)。
          🔴 摆出「往哪些区、发什么产物、写哪个桶、用哪个 workgroup/DB、什么身份」——
          全部取自各区 ExecutionEnv 描述符,让运维看清**烘焙进产物的值**,而不是事后去 S3 里翻。 */}
      <Modal
        title={<Space><ScheduleOutlined /> {t("下发预览:将向 {n} 个区域发布", { n: preview?.rows?.length ?? 0 })}</Space>}
        open={previewOpen}
        onCancel={() => setPreviewOpen(false)}
        width={980}
        okText={t("确认下发")}
        okButtonProps={{ disabled: (preview?.blocked?.length ?? 0) > 0 }}
        confirmLoading={busy}
        onOk={doPublish}
      >
        {preview?.blocked?.length ? (
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: 12 }}
            message={t("以下区域现在不能下发,已挡住整次发布:{list}", { list: preview.blocked.join("、") })}
            description={t("🔴 刻意不做「能发的先发」——部分下发之后,漏掉的区在看板上显示为「未绑定」这个正常态,于是永远不会被报出来。请按下表的原因修好再发。")}
          />
        ) : (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message={t("逐区域串行下发,遇错即停;已成功的保留,失败的那格会在多 region 看板上显红。")}
          />
        )}
        <MwaaMissingNotice payload={mwaaMissingFromPreviewRows(preview?.rows)} style={{ marginTop: 0, marginBottom: 12 }} />
        <Table
          size="small"
          rowKey="targetId"
          pagination={false}
          dataSource={preview?.rows || []}
          columns={[
            { title: t("执行目标"), dataIndex: "targetId", render: (v: string, r: any) => <Space><Tag color={r.home ? "default" : "cyan"}>{v}</Tag>{r.home ? <Text type="secondary">{t("本地")}</Text> : null}</Space> },
            { title: t("region"), dataIndex: "region", width: 110 },
            { title: t("产物 DAG"), dataIndex: "dagId", ellipsis: true },
            // 预览行要说清走哪个调度器、落到哪(serverless:workflow <dag_id>;mwaa:桶 · 环境)
            { title: t("调度器"), dataIndex: "scheduler", width: 100, render: (v: string) => v ? <Tag data-testid="preview-scheduler" color={v === "serverless" ? "gold" : "default"}>{v === "serverless" ? "Serverless" : "MWAA"}</Tag> : "—" },
            { title: t("桶 / 环境"), key: "env", ellipsis: true, render: (_: any, r: any) => <Text style={{ fontSize: 12 }}>{r.scheduler === "serverless" ? r.envName : `${r.bucket} · ${r.envName}`}</Text> },
            { title: "workgroup", dataIndex: "workgroup", width: 190 },
            { title: "DB", dataIndex: "database", width: 90 },
            { title: t("执行身份"), dataIndex: "credential", width: 120, render: (v: string) => <Tag color={v === "per-project" ? "green" : v === "shared-admin" ? "orange" : "default"}>{v}</Tag> },
            { title: t("可下发"), dataIndex: "ok", width: 220, render: (v: boolean, r: any) => v ? <Tag color="green">✓</Tag> : <Text type="danger" style={{ fontSize: 12 }}>{r.reason}</Text> },
          ]}
        />
        <Text type="secondary" style={{ fontSize: 12 }}>
          {t("桶:{bucket} · cron:{cron} · 基准 DAG:{dag}", { bucket: preview?.bucket || "-", cron: preview?.cron || cron, dag: preview?.baseDagId || "-" })}
        </Text>
      </Modal>

      <Modal title={t("补数（按业务日期区间逐日运行）")} open={bfOpen} onOk={doBackfill} onCancel={() => setBfOpen(false)} okText={t("开始补数")} confirmLoading={busy}>
        <Space direction="vertical" style={{ width: "100%" }}>
          <Input addonBefore={t("起始日期")} value={bfStart} onChange={(e) => setBfStart(e.target.value)} placeholder="YYYY-MM-DD" />
          <Input addonBefore={t("结束日期")} value={bfEnd} onChange={(e) => setBfEnd(e.target.value)} placeholder="YYYY-MM-DD" />
          <Text type="secondary">{t("区间内每个业务日期触发一次运行（≤31 天），各自以对应 ${ds} 参数化。")}</Text>
        </Space>
      </Modal>

      <Modal title={<Space><FileTextOutlined /> {t("运行日志")} {logModal.status && <Tag color={STATUS_COLOR[logModal.status] || "default"}>{logModal.status}</Tag>}
          {logModal.scheduler === "serverless" ? <Text type="secondary" style={{ fontSize: 12 }} data-testid="run-log-source">CloudWatch · {logModal.logGroup || "/aws/mwaa-serverless/"}</Text> : null}
          {/* 触发来源只认服务侧真值(worker 侧分不出 cron 与手动),拿不到就不显示 */}
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
        <Text type="secondary" style={{ fontSize: 12 }}>{t("Glue 作业日志来自 CloudWatch（/aws-glue/jobs/output 含 print/show 输出、/aws-glue/jobs/error 含报错堆栈）；冷启动有延迟，可点「刷新」。")}</Text>
      </Modal>

      <Modal title={<Space><RobotOutlined style={{ color: "#22d3ee" }} /> {t("AI 生成代码")}{sel ? `（${sel.type === "glue" ? "Glue PySpark" : "Redshift SQL"}）` : ""}</Space>}
        open={aiOpen} onCancel={() => setAiOpen(false)} width={860}
        footer={[
          <Button key="cancel" onClick={() => setAiOpen(false)}>{t("关闭")}</Button>,
          <Button key="gen" type="primary" icon={<RobotOutlined />} loading={aiLoading} onClick={doGenerate}>{aiResult ? t("重新生成") : t("生成")}</Button>,
          <Button key="apply" type="primary" ghost disabled={!aiResult?.code} onClick={applyAi}>{t("应用到编辑器")}</Button>,
        ]}>
        <Space direction="vertical" style={{ width: "100%" }}>
          <Text type="secondary">
            {t("用自然语言描述这个作业要做什么（输入/输出表、计算口径、是否按业务日期 ${ds} 增量等）。 大模型会基于真实表结构生成")}<strong>{t("生产级")}</strong>{sel?.type === "glue" ? " PySpark" : " Redshift SQL"}{t("实现， 仅供参考，")}<strong>{t("不会自动执行")}</strong>{t("——应用到编辑器后请审阅再保存。")}
          </Text>
          <Input.TextArea value={aiPrompt} onChange={(e) => setAiPrompt(e.target.value)} autoSize={{ minRows: 3, maxRows: 6 }}
            placeholder={sel?.type === "glue"
              ? t("例如：从源库 customers 表读取数据，清洗后按地区聚合客户数，写入 Redshift 表 region_customer_stats，按业务日期 ${ds} 增量。")
              : t("例如：统计每个商品分类的销售额，结果写入 public.dws_category_sales（含分类、销售额、统计日期），按 ${ds} 幂等可重入。")} />
          <Checkbox checked={aiUseCurrent} onChange={(e) => setAiUseCurrent(e.target.checked)}>
            {t("参考当前编辑器中的代码（在其基础上修改/补全）")}
          </Checkbox>

          {aiLoading && <Spin tip={t("正在生成生产级实现……")}><div style={{ height: 48 }} /></Spin>}

          {aiResult && (
            <Card size="small" title={t("生成结果（审阅后点「应用到编辑器」）")} style={{ marginTop: 4 }}
              extra={aiResult.usage ? <Text type="secondary" style={{ fontSize: 12 }}>tokens in {aiResult.usage.inputTokens} / out {aiResult.usage.outputTokens}</Text> : null}>
              <div style={{ border: "1px solid #1d4254", borderRadius: 8, overflow: "hidden", marginBottom: 8 }}>
                <MonacoEditor height="300px" language={sel?.type === "glue" ? "python" : "sql"} theme="vs-dark" value={aiResult.code}
                  options={{ readOnly: true, minimap: { enabled: false }, fontSize: 13 }} />
              </div>
              {/* cookbook 方言校验回显——已自动修正(绿)/ 检出违规(橙)。规则标题是数据不翻译,框架文案走 t()。 */}
              <div style={{ margin: "6px 0" }}><CodegenGroundedOn value={aiResult.groundedOn} boundTargets={targets} /></div>
              {aiResult.dialect && aiResult.dialect.fixed.length > 0 && (
                <Alert type="success" showIcon style={{ marginBottom: 8 }}
                  message={t("已按平台方言规则自动修正 {n} 处", { n: aiResult.dialect.fixed.length })}
                  description={<ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>{aiResult.dialect.fixed.map((f) => <li key={f.ruleId}>{f.title}</li>)}</ul>} />
              )}
              {aiResult.dialect && aiResult.dialect.violations.length > 0 && (
                <Alert type="warning" showIcon style={{ marginBottom: 8 }}
                  message={t("检出 {n} 处方言问题(运行前会再次校验,error 级会拦截执行)", { n: aiResult.dialect.violations.length })}
                  description={<ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>{aiResult.dialect.violations.map((v) => <li key={v.ruleId}>{v.title}:{v.rule}</li>)}</ul>} />
              )}
              {aiResult.explanation && (
                <Alert type="info" showIcon message={t("实现说明")} description={<div style={{ whiteSpace: "pre-wrap", fontSize: 13 }}>{aiResult.explanation}</div>} />
              )}
            </Card>
          )}
        </Space>
      </Modal>

      <Modal title={t("SQL 血缘解析（表级）")} open={lineageOpen} onCancel={() => setLineageOpen(false)} footer={null} width={680}>
        {lineagePreview && (
          <Space direction="vertical" style={{ width: "100%" }}>
            <div>
              <b>{t("写入表（{n}）：", { n: lineagePreview.targets?.length || 0 })}</b>{" "}
              {lineagePreview.targets?.length
                ? lineagePreview.targets.map((tb: any, i: number) => <Tag key={i} color="purple">{tb.schema}.{tb.table}</Tag>)
                : <Text type="secondary">{t("无")}</Text>}
            </div>
            <div>
              <b>{t("读取表（{n}）：", { n: lineagePreview.sources?.length || 0 })}</b>{" "}
              {lineagePreview.sources?.length
                ? lineagePreview.sources.map((tb: any, i: number) => <Tag key={i} color="blue">{tb.schema}.{tb.table}</Tag>)
                : <Text type="secondary">{t("无")}</Text>}
            </div>
            <Card size="small" title={t("表级血缘边（{n}）", { n: lineagePreview.edges?.length || 0 })}>
              {lineagePreview.edges?.length ? (
                <Table size="small" pagination={false} rowKey={(_: any, i?: number) => String(i)} dataSource={lineagePreview.edges}
                  columns={[
                    { title: t("来源表"), render: (_: any, r: any) => <code>{r.from.schema}.{r.from.table}</code> },
                    { title: "→", width: 30, render: () => "→" },
                    { title: t("目标表"), render: (_: any, r: any) => <code>{r.to.schema}.{r.to.table}</code> },
                  ]} />
              ) : <Empty description={t("未解析到表级血缘（纯 DDL 或无 FROM 的语句）")} />}
            </Card>
            <Text type="secondary">{t("保存作业后，血缘将自动同步到「数据治理 → 数据血缘 / 影响分析」(OpenMetadata)。")}</Text>
          </Space>
        )}
      </Modal>

      {/* O2:运行对话框(默认跟随执行范围视角) */}
      <RunTargetsModal
        open={!!runPick && !!sel}
        bindings={sel ? bindingTargetsOf(sel) : []}
        busy={busy}
        onCancel={() => setRunPick(false)}
        onRun={(picked) => { setRunPick(false); void doRun({ targets: picked }); }}
      />
    </div>
  );
}
