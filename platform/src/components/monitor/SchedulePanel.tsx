"use client";

// 调度配置面板(原 /schedule 页,2026-07-13 调度运维收敛并入任务监控页作 Tab;
// 功能零删减:cron 编辑/EventBridge 启停/Airflow 入口/筛选/展开运行记录+日志)。

import React, { useEffect, useState, useRef } from "react";
import { Table, Switch, Tag, message, Modal, Button, Space, Select, Badge, Input, Card, Tooltip } from "antd";
import { ReloadOutlined, ClockCircleOutlined, HistoryOutlined, SearchOutlined } from "@ant-design/icons";
import CronEditor from "@/components/common/CronEditor";
import { useT } from "@/lib/i18n/useT";
// @kf-batch 50-WP4quater-reads(工单 SC-32)—— 🔴 调度面板与 `/sync`、`/workflow` 两页读的是**同一批行**,
// 那两页已按执行范围过滤而这里没有 ⇒ 同一份数据在两个页面给出不同条数(用户看到的是「平台在自相矛盾」)。
// 两条列表接口本来就支持 `?scope=`,此前只是没传。
import { useScope } from "@/components/scope/ScopeProvider";
import { landingOfScope } from "@/lib/scope/scope";
import { toScopeParam } from "@/lib/scope/scope";
// @kf-batch 50-B09-carrier-drift —— 「该显示哪一态」的**唯一判别作者**(五态,含「没查」「只查了一半」)
import { carrierDriftView } from "@/lib/workflow/carrier-drift-view";

export default function SchedulePanel({ active }: { active: boolean }) {
  const t = useT();
  const { scope } = useScope();
  const scopeParam = toScopeParam(scope);
  const [syncTasks, setSyncTasks] = useState<any[]>([]);
  const [workflows, setWorkflows] = useState<any[]>([]);
  // @kf-batch 50-WP28-platform-action-node —— 平台动作的调度对象:定时治理任务(本批)/ 问数卡片定时刷新
  const [govTasks, setGovTasks] = useState<any[]>([]);
  const [cardScheds, setCardScheds] = useState<any[]>([]);
  // @kf-batch 50-CAPSEED-seed-dispatch —— 定时造数任务(第三类平台动作调度对象)
  const [seedScheds, setSeedScheds] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [cronModal, setCronModal] = useState<{ open: boolean; item?: any; cron: string }>({ open: false, cron: "" });
  const [runRecords, setRunRecords] = useState<Record<string, any[]>>({});
  const [logModal, setLogModal] = useState<{ open: boolean; id: string; logs: any[] }>({ open: false, id: "", logs: [] });

  const fetchRuns = async (id: string) => {
    const res = await fetch(`/api/sync/${id}/runs`);
    const d = await res.json();
    const runs = d.data?.runs || d.runs || d.Items || [];
    setRunRecords((prev) => ({ ...prev, [id]: runs }));
  };

  const viewLog = async (id: string, runId?: string) => {
    setLogModal({ open: true, id, logs: [] });
    const url = runId ? `/api/monitor/tasks/${id}/logs?runId=${encodeURIComponent(runId)}` : `/api/monitor/tasks/${id}/logs`;
    const res = await fetch(url);
    const data = await res.json();
    setLogModal({ open: true, id, logs: data.logs || [] });
  };
  const [mwaaUrl, setMwaaUrl] = useState("");
  const [mwaaLoginUrl, setMwaaLoginUrl] = useState("");
  const [mwaaRegion, setMwaaRegion] = useState("");
  // @kf-batch 50-WP4quater-reads(工单 SC-3)—— 🔴 Airflow 入口跟随当前视角:每个区一套 Airflow,
  // 把主控区的登录入口给别的区看,点进去是**别人的 DAG 列表**。
  const airflowTargetId = scope.kind === "target" ? scope.targetId : undefined;
  // 序 38 B-72 —— 该区调度器的形态,由 /api/workflow/airflow 的应答**分三态**读出来(原来只看「有没有登录 URL」,
  //   装的是 MWAA Serverless 的区同样没有 Web 控制台 ⇒ 被误报成「这个区还没有 Airflow 环境」,而执行环境页明明列着
  //   airflow-serverless 已安装 —— 2026-10-13 客户生产环境用户亲眼所见):
  //   · mwaa       = 经典 MWAA,有 Web 控制台(按钮);
  //   · serverless = airflow-serverless(接口 409 WORKFLOW_SCHEDULER_UNSUPPORTED「没有 Web 控制台」)⇒ 中性说明,不是告警;
  //   · missing    = 真没装(409 SCHEDULER_NOT_INSTALLED)⇒ 才显示告警 + 去补装;
  //   · unknown    = 接口没答上来(网络 / 5xx)⇒ 什么都不断言,不拿告警糊过去。
  const [schedulerKind, setSchedulerKind] = useState<"mwaa" | "serverless" | "missing" | "unknown">("unknown");
  useEffect(() => {
    setSchedulerKind("unknown"); setMwaaUrl(""); setMwaaLoginUrl(""); setMwaaRegion("");
    fetch(`/api/workflow/airflow?targetId=${encodeURIComponent(landingOfScope(scope))}`).then(r => r.json()).then(d => {
      const data = d.data || d;
      const code = typeof d?.error?.code === "string" ? d.error.code : "";
      if (data.loginUrl) {
        setMwaaLoginUrl(data.loginUrl);
        if (data.webServerHostname) setMwaaUrl(`https://${data.webServerHostname}`);
        if (data.region) setMwaaRegion(data.region);
        setSchedulerKind("mwaa");
      } else if (code === "WORKFLOW_SCHEDULER_UNSUPPORTED") {
        setSchedulerKind("serverless");
      } else if (code === "SCHEDULER_NOT_INSTALLED" || code === "MWAA_NOT_INSTALLED") {
        setSchedulerKind("missing");
      } else {
        setSchedulerKind("unknown");
      }
    }).catch(() => { setMwaaUrl(""); setMwaaLoginUrl(""); setSchedulerKind("unknown"); });
    // 🔴 切区要重取入口(护栏 4);上面开头先清空,界面上不会留着一个指向别区 Airflow 的按钮或别区的结论。
  }, [airflowTargetId]);
  const [refreshInterval, setRefreshInterval] = useState(0);
  const timerRef = useRef<NodeJS.Timeout>(undefined);
  const [filters, setFilters] = useState({ name: "", itemType: "", status: "", enabled: "", scheduleType: "" });

  const buildQs = (f: typeof filters, type: string) => {
    const params = new URLSearchParams();
    if (f.name) params.set("name", f.name);
    if (f.status) params.set("status", f.status);
    if (f.enabled === "true") params.set("scheduleEnabled", "true");
    else if (f.enabled === "false") params.set("scheduleEnabled", "false");
    // scheduleType maps to cron param for workflow API
    if (f.scheduleType === "auto") params.set("cron", "configured");
    else if (f.scheduleType === "manual") params.set("cron", "none");
    // 🔴 `global` 时 `toScopeParam` 回 null ⇒ 不带该参数,URL 与改动前逐字节相同(回滚点)
    if (scopeParam) params.set("scope", scopeParam);
    // @kf-batch 50-B09-carrier-drift —— 🔴 **本面板是唯一该常开这个开关的地方**:
    //   「调度配置」页的本职就是回答「我的定时任务到点会按我现在看到的定义跑吗」,
    //   而那正是 `withDrift` 查的东西。别的页面(清单/详情)不查,省掉每行一次 MSAF 只读调用。
    params.set("withDrift", "1");
    const qs = params.toString();
    return qs ? `?${qs}` : "";
  };

  // @kf-batch 50-B09-carrier-drift —— 🔴🔴 **这道守卫是被上面那个开关逼出来的**:
  //   带 `withDrift=1` 之后这两个请求要逐个已发布载体打一次 MSAF `get-workflow`,
  //   响应从几百毫秒变成数秒 ⇒ **竞态窗口是我自己拉大的**(切区/改筛选时,晚到的旧响应
  //   会盖掉新范围的结果 —— 本仓记过一次同形的:「某区视角显示别的区的数仓」,
  //   真根就是并发请求的陈旧响应竞态,而当时手工点是绿的)。
  //   谁把窗口拉大,谁就得同刀把它封上:记序号,只有最后一次发出的请求允许写 state。
  const seqRef = useRef(0);

  const fetchData = (f?: typeof filters) => {
    const cur = f || filters;
    const skip = cur.itemType;
    const seq = ++seqRef.current;
    setLoading(true);
    const only = (t: string) => !skip || skip === t;
    // 🔴 平台动作调度对象的列表只认执行范围(+ 是否查载体落后),名称筛选在本页内存里做
    const actionQs = `?${new URLSearchParams({ ...(scopeParam ? { scope: scopeParam } : {}), withDrift: "1" }).toString()}`;
    Promise.all([
      only("sync") ? fetch(`/api/sync${buildQs(cur, "sync")}`).then((r) => r.json()).then((d) => d.success ? d.data : d) : Promise.resolve([]),
      only("workflow") ? fetch(`/api/workflow${buildQs(cur, "workflow")}`).then((r) => r.json()).then((d) => d.success ? d.data : d) : Promise.resolve([]),
      only("governance") ? fetch(`/api/governance/schedules${actionQs}`).then((r) => r.json()).then((d) => d.success ? d.data : []) : Promise.resolve([]),
      only("genbi-card") ? fetch(`/api/genbi/cards/schedules${actionQs}`).then((r) => r.json()).then((d) => d.success ? d.data : []) : Promise.resolve([]),
      only("seed") ? fetch(`/api/seed/schedules${actionQs}`).then((r) => r.json()).then((d) => d.success ? d.data : []) : Promise.resolve([]),
    ]).then(([s, w, g, c, sd]) => {
      if (seq !== seqRef.current) return; // 陈旧响应:丢掉,不许写 state
      setSyncTasks(Array.isArray(s) ? s : []); setWorkflows(Array.isArray(w) ? w : []);
      setGovTasks(Array.isArray(g) ? g : []);
      setCardScheds(Array.isArray(c) ? c : []);
      setSeedScheds(Array.isArray(sd) ? sd : []);
    }).finally(() => { if (seq === seqRef.current) setLoading(false); });
  };

  const loadedRef = useRef(false);
  useEffect(() => { if (active && !loadedRef.current) { loadedRef.current = true; fetchData(); } }, [active]);

  // @kf-batch 50-WP4quater-reads —— 切范围要重拉(护栏 4)。🔴 只在本 Tab 已激活时拉:
  // 未激活就拉等于给每次切区多打两个请求,而且面板还没挂出来。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (active && loadedRef.current) fetchData(); }, [scopeParam]);

  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (active && refreshInterval > 0) timerRef.current = setInterval(() => fetchData(), refreshInterval * 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [refreshInterval, filters, active]);

  const saveCron = async () => {
    const item = cronModal.item;
    if (!item) return;
    // If schedule is already enabled, update cron via schedule/enable to regenerate DAG
    if (item.scheduleEnabled) {
      const res = await fetch("/api/schedule/enable", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId: item.itemId, taskType: item.itemType, cronExpression: cronModal.cron, enabled: true }),
      });
      const d = await res.json();
      d.success !== false ? message.success(t("调度已更新")) : message.error(d.error?.message || t("更新失败"));
    } else if (item.itemType === "genbi-card") {
      // 卡片定时:未启用时改 cron 走卡片自己的配置接口(只有卡片作者能配)
      const res = await fetch(`/api/genbi/cards/${item.cardId}/schedule`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cronExpression: cronModal.cron, enabled: false }),
      });
      const d = await res.json().catch(() => ({}));
      d?.success !== false ? message.success(t("Cron 已保存，启用调度后生效")) : message.error(d?.error?.message || t("更新失败"));
    } else if (item.itemType === "seed") {
      // @kf-batch 50-CAPSEED-seed-dispatch —— 未启用时改 cron = 改草稿(与治理同口径)
      const res = await fetch(`/api/seed/schedules/${item.itemId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cronExpression: cronModal.cron }),
      });
      const d = await res.json().catch(() => ({}));
      d?.success !== false ? message.success(t("Cron 已保存，启用调度后生效")) : message.error(d?.error?.message || t("更新失败"));
    } else if (item.itemType === "governance") {
      // @kf-batch 50-WP28-platform-action-node —— 未启用时改 cron = 改草稿(启用中不许改参数,先停用)
      const res = await fetch(`/api/governance/schedules/${item.itemId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cronExpression: cronModal.cron }),
      });
      const d = await res.json().catch(() => ({}));
      d?.success !== false ? message.success(t("Cron 已保存，启用调度后生效")) : message.error(d?.error?.message || t("更新失败"));
    } else {
      const url = item.itemType === "sync" ? `/api/sync/${item.itemId}` : `/api/workflow/${item.itemId}`;
      await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cronExpression: cronModal.cron }) });
      message.success(t("Cron 已保存，启用调度后生效"));
    }
    setCronModal({ open: false, cron: "" });
    fetchData();
  };

  const toggleSchedule = async (id: string, type: string, enabled: boolean, cron: string) => {
    const res = await fetch("/api/schedule/enable", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId: id, taskType: type, cronExpression: cron || "0 2 * * *", enabled }),
    });
    const d = await res.json();
    if (d.success !== false) {
      // @kf-batch 50-WP26-sync-schedule-carrier
      // 🔴 **照着服务端回的 `carrier` 说话,不自己编**。历史:这里原来无论什么类型都喊
      //   「调度已启用 (EventBridge Scheduler)」,而两个 region 里 EventBridge Scheduler 实测各 0 条
      //   —— 页面在替产品说一件做不到的事(2026-09-19 无头验收抓到)。
      //   WP-26 把载体交付了(单节点 sync 工作流发到**该区**的 MWAA Serverless)⇒ 现在 `carrier`
      //   会是 `mwaa-serverless`,而**万一**哪天又回到 `none`(载体没发成),这里照旧报警不报喜。
      const notice = d?.data?.notice as string | undefined;
      const carrier = d?.data?.carrier as string | undefined;
      if (enabled && carrier !== "mwaa-serverless" && notice) message.warning(notice, 8);
      else message.success(enabled ? t("调度已启用") : t("调度已停用"));
    } else {
      message.error(d.error?.message || t("调度配置失败"));
    }
    fetchData();
  };

  // @kf-batch 50-B09-carrier-drift —— 一键重新发布载体。
  // 🔴 **复用产品自己那两条发布通道**,不另开一条路:B-09 的病根就是「产物生成有两个作者」,
  //   要是这里再手写一遍下发,修完当天就又埋回去了。
  //   · 工作流 ⇒ `POST /api/workflow/{id}/publish`(内部走 `publishWorkflowDag` 单一作者)
  //   · 同步任务 ⇒ `POST /api/schedule/enable`(内部走 `publishSyncScheduleCarrier`)
  const [republishing, setRepublishing] = useState<string>("");
  const republishCarrier = async (r: any) => {
    setRepublishing(r.itemId);
    try {
      const res = r.itemType === "workflow"
        ? await fetch(`/api/workflow/${r.itemId}/publish`, { method: "POST" })
        : await fetch("/api/schedule/enable", {
            method: "POST", headers: { "Content-Type": "application/json" },
            // @kf-batch 50-WP28-platform-action-node —— 平台动作调度对象也走同一条启用通道(taskType 照实传)
            body: JSON.stringify({ taskId: r.itemId, taskType: r.itemType, cronExpression: r.cronExpression, enabled: true }),
          });
      const d = await res.json().catch(() => ({}));
      // 🔴 一次发布可能「一个区成、一个区没成」(`partial`)—— 那种情况**不许报成功**,
      //   否则用户以为都修好了,而另一个区还带着旧定义在跑。
      if (!res.ok || d?.success === false) message.error(d?.error?.message || d?.error || t("重新发布失败"));
      else if (d?.partial) message.warning(t("部分执行范围发布失败,请看逐区结果"), 8);
      else message.success(t("载体已重新发布"));
    } finally {
      setRepublishing("");
      fetchData(); // 重发完要**重新比一次**,别让页面留着旧结论
    }
  };

  const allItems = [
    ...syncTasks.map((t) => ({ ...t, key: t.taskId, itemId: t.taskId, itemType: "sync", itemName: t.name })),
    ...workflows.map((w) => ({ ...w, key: w.workflowId, itemId: w.workflowId, itemType: "workflow", itemName: w.name })),
    // @kf-batch 50-WP28-platform-action-node —— 定时治理任务(名称筛选在内存里做:那条列表接口只认执行范围)
    ...govTasks
      .filter((g) => !filters.name || String(g.name || "").toLowerCase().includes(filters.name.toLowerCase()))
      .filter((g) => !filters.enabled || String(Boolean(g.scheduleEnabled)) === filters.enabled)
      .map((g) => ({ ...g, key: g.taskId, itemId: g.taskId, itemType: "governance", itemName: g.name, status: g.scheduleEnabled ? "active" : "draft" })),
    // @kf-batch 50-WP28-platform-action-node —— 我的问数卡片定时刷新(名字不含标题:标题只在卡片自己的区)
    ...cardScheds
      .filter((g) => !filters.name || String(g.name || "").toLowerCase().includes(filters.name.toLowerCase()))
      .filter((g) => !filters.enabled || String(Boolean(g.scheduleEnabled)) === filters.enabled)
      .map((g) => ({ ...g, key: g.taskId, itemId: g.taskId, itemType: "genbi-card", itemName: g.name, status: g.scheduleEnabled ? "active" : "draft" })),
    // @kf-batch 50-CAPSEED-seed-dispatch —— 定时造数任务
    ...seedScheds
      .filter((g) => !filters.name || String(g.name || "").toLowerCase().includes(filters.name.toLowerCase()))
      .filter((g) => !filters.enabled || String(Boolean(g.scheduleEnabled)) === filters.enabled)
      .map((g) => ({ ...g, key: g.taskId, itemId: g.taskId, itemType: "seed", itemName: g.name, status: g.scheduleEnabled ? "active" : "draft" })),
  ];

  const columns = [
    { title: t("名称"), dataIndex: "itemName", key: "name",
      render: (v: string, r: any) => <a href={r.itemType === "workflow" ? `/workflow/${r.itemId}` : r.itemType === "governance" ? `/governance` : r.itemType === "genbi-card" ? `/genbi` : r.itemType === "seed" ? `/datasources` : `/sync/${r.itemId}`}
        data-testid={r.itemType === "governance" || r.itemType === "genbi-card" || r.itemType === "seed" ? `schedule-row-${r.itemType}-${r.itemId}` : undefined}><b>{v}</b></a> },
    { title: t("类型"), dataIndex: "itemType", key: "type", render: (v: string) => v === "governance"
      ? <Tag color="cyan" data-testid="schedule-type-governance">{t("治理任务")}</Tag>
      : v === "genbi-card"
      ? <Tag color="magenta" data-testid="schedule-type-genbi-card">{t("问数卡片")}</Tag>
      : v === "seed"
      ? <Tag color="gold" data-testid="schedule-type-seed">{t("造数")}</Tag>
      : <Tag color={v === "sync" ? "blue" : "purple"}>{v === "sync" ? t("同步任务") : t("工作流")}</Tag> },
    { title: t("Cron 表达式"), key: "cron", render: (_: any, r: any) => (
      <Space>
        <Tag style={{ cursor: "pointer" }} onClick={() => setCronModal({ open: true, item: r, cron: r.cronExpression || "0 2 * * *" })}>
          <ClockCircleOutlined /> {r.cronExpression || t("未配置")}
        </Tag>
      </Space>
    )},
    { title: t("启用"), key: "enabled", render: (_: any, r: any) => (
      <Switch size="small" checked={r.scheduleEnabled} onChange={(v) => toggleSchedule(r.itemId, r.itemType, v, r.cronExpression)} />
    )},
    // @kf-batch 50-WP26-sync-schedule-carrier
    // 🔴🔴 **绿标只给「真有载体」的那一行** —— 判据不看 `scheduleEnabled` 这个愿望字段,看**产物**
    //   (`deployments` 里有没有该区的 workflowArn)。
    //   历史:同步任务**本来没有调度载体**,而这里给它打「自动调度」绿标 = 界面说谎(实测 25 分钟零触发);
    //   上一版改成橙色「定时未交付」是**诚实但没功能**。WP-26 交付载体之后仍然不能回到「看 enabled 打绿标」——
    //   存量那些「enabled=true 但从没发过载体」的行必须区分出来,否则又是同一句谎话。
    //   三态:有产物 ⇒ 自动调度(绿)· enabled 但无产物 ⇒ 待发布载体(橙,给出路)· 其余 ⇒ 手动触发。
    { title: t("调度类型"), key: "scheduleType", render: (_: any, r: any) => {
      const armed = Object.values((r.deployments || {}) as Record<string, { workflowArn?: string } | undefined>)
        .some((x) => Boolean(x?.workflowArn));
      if (r.scheduleEnabled && r.cronExpression && armed) {
        return <Tooltip title={t("已发布到该执行范围的 MWAA Serverless,到点由它触发;运行记录与日志在任务监控里查")}>
          <Tag color="green" data-testid="schedule-armed">{t("自动调度")}</Tag>
        </Tooltip>;
      }
      if (r.scheduleEnabled && r.cronExpression) {
        return <Tooltip title={t("cron 已保存,但这一行还没有调度产物(存量数据或上次发布失败)—— 把「启用」关掉再打开,平台会重新发布载体")}>
          <Tag color="orange" data-testid="sync-schedule-not-armed">{t("待发布载体")}</Tag>
        </Tooltip>;
      }
      return <Tag>{t("手动触发")}</Tag>;
    }},
    // @kf-batch 50-B09-carrier-drift
    // 🔴🔴 **B-09:改了产物生成器,存量载体不会自动重发** —— 上面那一列答的是「有没有载体」,
    //   这一列答的是**完全不同的另一件事**:「那个载体上的定义,还是当前这套生成器产出的吗」。
    //   两件事**刻意不合并成一个标签**:合并之后「有载体但定义落后」只能被挤进绿标或橙标,
    //   而它既不是「在跑」也不是「没发」—— 那正是这个 bug 静默了一整轮的原因。
    // 🔴 五态逐个给出口,判别走**唯一作者** `carrierDriftView`(见那份文件的注释:
    //   「没查」「只查了一半」「判不了」一律不许显示成「最新」)。
    { title: t("载体定义"), key: "carrierDrift", render: (_: any, r: any) => {
      const v = carrierDriftView(r);
      if (v.kind === "n/a") return <span style={{ color: "#bfbfbf" }} data-testid="carrier-drift-na">—</span>;
      if (v.kind === "unchecked") {
        return <Tooltip title={t("这次没查载体上的定义(共 {n} 个执行范围没拿到结果)—— 「没查」不等于「最新」，点刷新重查", { n: v.missingAnswerFor.length })}>
          <Tag data-testid="carrier-drift-unchecked">{t("未检查")}</Tag>
        </Tooltip>;
      }
      if (v.kind === "stale") {
        return <Space size={4}>
          <Tooltip title={t("已发布的定义与当前生成器不一致：{list} —— 到点跑的还是旧定义，要重新发布才会生效", { list: v.staleTargets.join("、") })}>
            <Tag color="red" data-testid="carrier-drift-stale">{t("载体需重新发布")}</Tag>
          </Tooltip>
          <Button size="small" type="link" loading={republishing === r.itemId}
            data-testid="carrier-republish" onClick={() => republishCarrier(r)}>{t("重新发布")}</Button>
        </Space>;
      }
      if (v.kind === "indeterminate") {
        return <Tooltip title={t("查了，但判不出来：{states}{why} —— 如实告诉你判不了，不拿绿标糊过去", {
          states: JSON.stringify(v.states), why: v.reasons.length ? `（${v.reasons[0]}）` : "",
        })}>
          <Tag color="default" data-testid="carrier-drift-indeterminate">{t("无法确认")}</Tag>
        </Tooltip>;
      }
      return <Tooltip title={t("已发布的定义与当前生成器逐字节一致（{n} 个执行范围都比过）", { n: v.armed.length })}>
        <Tag color="green" data-testid="carrier-drift-ok">{t("最新")}</Tag>
      </Tooltip>;
    }},
    { title: t("状态"), dataIndex: "status", key: "status", render: (v: string) => <Badge status={v === "running" || v === "active" ? "processing" : v === "error" ? "error" : "default"} text={v === "active" ? t("已发布") : v} /> },
    { title: t("最近运行"), key: "lastRun", render: (_: any, r: any) => {
      const s = r.lastRunStatus;
      return s ? <Badge status={s === "succeeded" ? "success" : s === "failed" ? "error" : "processing"} text={s === "succeeded" ? t("成功") : s === "failed" ? t("失败") : s === "running" ? t("运行中") : s} /> : <Tag>{t("未运行")}</Tag>;
    }},
  ];

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 16 }}>
        <Space>
          {/* @kf-batch 50-WP4quater-reads(工单 SC-3)—— 护栏 2:按钮上复述这是**哪个区**的 Airflow。
              一个不带区的「Airflow Web UI」按钮在多区下就是个陷阱:点进去看到的可能是别人的 DAG。 */}
          {mwaaLoginUrl && (
            <Button type="link" href={mwaaLoginUrl} target="_blank" data-testid="airflow-web-ui">
              🔗 Airflow Web UI{mwaaRegion ? `(${mwaaRegion})` : ""}
            </Button>
          )}
          {/* 序 38 B-72:只有**真没装**才告警;装的是 airflow-serverless 时给中性说明(它本来就没有 Web 控制台) */}
          {schedulerKind === "serverless" && airflowTargetId && (
            <Tag color="processing" data-testid="airflow-serverless-no-ui">{t("这个区的调度由 Airflow Serverless 承载(没有 Web 控制台;定义与运行在本页和运行实例页查看)")}</Tag>
          )}
          {schedulerKind === "missing" && airflowTargetId && (
            <Tag color="warning" data-testid="airflow-not-installed">{t("这个区还没有 Airflow 环境(去执行环境补装调度组件)")}</Tag>
          )}
          <Select value={refreshInterval} onChange={setRefreshInterval} style={{ width: 130 }} options={[
            { label: t("手动刷新"), value: 0 }, { label: t("5秒自动"), value: 5 }, { label: t("10秒自动"), value: 10 }, { label: t("30秒自动"), value: 30 },
          ]} />
          <Button icon={<ReloadOutlined />} onClick={() => fetchData()}>{t("刷新")}</Button>
        </Space>
      </div>
      <Card size="small" style={{ marginBottom: 16 }}>
        <Space wrap>
          <Input placeholder={t("名称")} prefix={<SearchOutlined />} value={filters.name} onChange={(e) => setFilters({ ...filters, name: e.target.value })} onPressEnter={() => fetchData()} allowClear style={{ width: 180 }} />
          <Select placeholder={t("类型")} value={filters.itemType || undefined} onChange={(v) => { const f = { ...filters, itemType: v || "" }; setFilters(f); fetchData(f); }} allowClear style={{ width: 120 }}
            options={[{ label: t("同步任务"), value: "sync" }, { label: t("工作流"), value: "workflow" }, { label: t("治理任务"), value: "governance" }, { label: t("问数卡片"), value: "genbi-card" }, { label: t("造数"), value: "seed" }]} />
          <Select placeholder={t("状态")} value={filters.status || undefined} onChange={(v) => { const f = { ...filters, status: v || "" }; setFilters(f); fetchData(f); }} allowClear style={{ width: 120 }}
            options={[{ label: t("草稿"), value: "draft" }, { label: t("已发布"), value: "active" }, { label: t("已停止"), value: "stopped" }, { label: t("异常"), value: "error" }]} />
          <Select placeholder={t("启用")} value={filters.enabled || undefined} onChange={(v) => { const f = { ...filters, enabled: v || "" }; setFilters(f); fetchData(f); }} allowClear style={{ width: 110 }}
            options={[{ label: t("已启用"), value: "true" }, { label: t("未启用"), value: "false" }]} />
          <Select placeholder={t("调度类型")} value={filters.scheduleType || undefined} onChange={(v) => { const f = { ...filters, scheduleType: v || "" }; setFilters(f); fetchData(f); }} allowClear style={{ width: 120 }}
            options={[{ label: t("自动调度"), value: "auto" }, { label: t("手动触发"), value: "manual" }]} />
          <Button type="primary" icon={<SearchOutlined />} onClick={() => fetchData()}>{t("搜索")}</Button>
          <Button onClick={() => { const f = { name: "", itemType: "", status: "", enabled: "", scheduleType: "" }; setFilters(f); fetchData(f); }}>{t("重置")}</Button>
        </Space>
      </Card>
      <Table columns={columns} dataSource={allItems} loading={loading} pagination={{ pageSize: 20 }}
        expandable={{
          expandedRowRender: (record: any) => {
            const runs = runRecords[record.itemId] || [];
            return (
              <Table size="small" dataSource={runs} rowKey="runId" pagination={{ pageSize: 10, size: "small" }}
                locale={{ emptyText: t("暂无执行记录") }}
                columns={[
                  { title: t("运行ID"), dataIndex: "runId", width: 160, render: (v: string) => <code style={{fontSize:11}}>{v?.slice(0,16)}</code> },
                  { title: t("状态"), dataIndex: "status", width: 90, render: (v: string) => <Badge status={v === "succeeded" ? "success" : v === "failed" ? "error" : v === "running" ? "processing" : "default"} text={v === "succeeded" ? t("成功") : v === "failed" ? t("失败") : v === "running" ? t("运行中") : v} /> },
                  { title: t("触发方式"), dataIndex: "triggeredBy", width: 90, render: (v: string) => v === "schedule" ? <Tag color="green">{t("自动")}</Tag> : <Tag>{t("手动")}</Tag> },
                  { title: t("开始时间"), dataIndex: "startedAt", width: 170, render: (v: string) => v?.slice(0,19).replace("T"," ") },
                  { title: t("结束时间"), dataIndex: "finishedAt", width: 170, render: (v: string) => v ? v.slice(0,19).replace("T"," ") : "-" },
                  { title: t("耗时"), dataIndex: "duration", width: 70, render: (v: number) => v ? `${v}s` : "-" },
                  { title: t("错误"), dataIndex: "error", ellipsis: true, render: (v: string) => v ? <span style={{color:"#ff4d4f"}}>{v}</span> : "-" },
                  { title: t("操作"), width: 70, render: (_: any, r: any) => <Button size="small" type="link" onClick={() => viewLog(record.itemId, r.runId)}>{t("日志")}</Button> },
                ]}
              />
            );
          },
          onExpand: (expanded: boolean, record: any) => { if (expanded) fetchRuns(record.itemId); },
        }}
      />

      <Modal title={t("日志 - {id}", { id: logModal.id?.slice(-8) })} open={logModal.open} onCancel={() => setLogModal({ open: false, id: "", logs: [] })} footer={null} width={800}>
        <div style={{ maxHeight: 400, overflow: "auto", background: "#1e1e1e", color: "#d4d4d4", padding: 16, borderRadius: 8, fontFamily: "monospace", fontSize: 12, whiteSpace: "pre-wrap" }}>
          {logModal.logs.length > 0 ? logModal.logs.map((log: any, i: number) => (
            <div key={i}>{log.timestamp ? <span style={{ color: "#6a9955" }}>{new Date(log.timestamp).toISOString().slice(0,19)} </span> : null}{typeof log === "string" ? log : log.message}</div>
          )) : <span style={{ color: "#808080" }}>{t("暂无日志")}</span>}
        </div>
      </Modal>

      <Modal title={t("配置调度")} open={cronModal.open} onOk={saveCron} onCancel={() => setCronModal({ open: false, cron: "" })} width={520}>
        <div style={{ marginBottom: 8, fontWeight: 500 }}>{cronModal.item?.itemName}</div>
        <CronEditor value={cronModal.cron} onChange={(c) => setCronModal((prev) => ({ ...prev, cron: c }))} />
      </Modal>
    </div>
  );
}
