// 模块 32 — Flink 作业故障顾问(FailureAdvisor)。
//
// 【为什么存在】有些故障平台**不能替用户自动消解**,只能识别并把选择权交还用户。典型代表:
// CDC 作业的快照位点已被源端 binlog 回收(停机过久)——此时"从快照恢复"必崩、"丢状态冷启动"
// 会重扫全量,取舍涉及业务语义(能否容忍重复/回溯),平台无权替用户决定。
// 若不做这一层,用户在页面上只会看到一坨 Java 堆栈,不知道发生了什么、更不知道下一步做什么。
//
// 【设计原则】
//  ① **数据驱动**:故障模式是一张表(PATTERNS),新增一种故障只加一条数据,不改判定逻辑;
//  ② **只诊断不代劳**:输出「人话结论 + 为什么 + 可执行选项」,由用户在页面上选,平台不擅自动作
//     (对齐 [[network-advisor-readonly-only]]:顾问给建议+教步骤,不擅自改底层);
//  ③ **与引擎解耦**:纯函数(正则 → 结论),零 AWS 调用、零 IO,可单测、可被诊断/告警/知识库复用;
//  ④ **不遮蔽原始证据**:始终保留 rawError,顾问结论是**附加**信息,不替换事实。
//
// 消费方:①作业详情页错误区(人话 + 建议按钮);②AI 诊断(作为高置信先验注入);③告警富化。
// 见 docs/design/32-realtime-compute/DESIGN-flink-s3tables-412-rootfix.md §10(故障顾问)。

/** 一个可执行的修复选项(展示给用户,由用户点选;平台不自动执行)。 */
export interface FailureAction {
  /** 稳定标识(前端据此决定点击行为;新增动作只加常量,不改既有语义)。 */
  id: "restart_without_state" | "resume_from_snapshot" | "extend_binlog_retention" | "open_logs" | "edit_sql";
  label: string;
  /** 选它的后果——必须诚实写清代价,让用户知情决策。 */
  consequence: string;
  /** 是否为推荐项(至多一个)。 */
  recommended?: boolean;
}

export interface FailureAdvice {
  /** 故障模式稳定 ID(供告警去重/知识库关联)。 */
  code: string;
  /** 一句话人话结论(不含堆栈术语)。 */
  summary: string;
  /** 为什么会这样(讲清机理,让用户理解而非照做)。 */
  cause: string;
  /** 可执行选项(顺序即展示顺序)。 */
  actions: FailureAction[];
  /** 严重度:blocker=必须处理否则一直崩;warning=可继续但需知晓。 */
  severity: "blocker" | "warning";
}

interface Pattern extends Omit<FailureAdvice, "summary"> {
  /** 命中即判定(对原始错误文本)。 */
  match: RegExp;
  summary: string;
}

/** 故障模式表 —— 新增一种故障只在此加一条(判定逻辑零改动)。 */
const PATTERNS: Pattern[] = [
  {
    // 实测(2026-07-25):快照仅 2.5h 却已不可恢复——其位点所在 binlog 在 retention=None 时期被清净。
    // 后果:fullRestarts 持续攀升且【不自愈】,必须人工决策。
    code: "CDC_BINLOG_POSITION_EXPIRED",
    // 覆盖真实世界的多种措辞:①Debezium/Flink CDC「binlog ... no longer available」+「Reconfigure ... snapshot」;
    // ②MySQL 服务端直报「requested ... replication from ... position > file size」/「Could not find first log file name」
    //   —— 这几种都指向"保存的位点已不在源端 binlog 中",后果一致(从快照/checkpoint 恢复必崩且不自愈)。
    match: /binlog[\s\S]{0,200}?(no longer available|is no longer available on the server)|Reconfigure the connector to use a snapshot when needed|requested[\s\S]{0,80}?replication from[\s\S]{0,80}?(position\s*>\s*file size|impossible position)|Could not find first log file name in binary log index/i,
    severity: "blocker",
    summary: "作业要接着上次的位置读 MySQL 变更日志,但源库已把那段日志清理掉了,所以反复重启。",
    cause:
      "作业上次停止时保存了「读到哪儿」的位点(binlog 位置)。MySQL 只保留最近一段时间的变更日志," +
      "停机时间超过保留期后,那个位点对应的日志文件已被删除且不可恢复 —— 于是每次启动都读不到、崩溃重启。" +
      "这不是配置错误,是停机时长超出了日志保留窗口。",
    actions: [
      {
        id: "restart_without_state",
        label: "放弃旧位点,重新开始读(推荐)",
        consequence:
          "作业会先全量扫一遍源表、再转入增量。产出表可能出现历史数据重算/重复写入(取决于你的 sink 是否幂等)," +
          "但作业能立刻恢复正常。适合「结果可重算」的聚合场景。",
        recommended: true,
      },
      {
        id: "extend_binlog_retention",
        label: "调大源库日志保留期(防下次再犯)",
        consequence:
          "把 MySQL binlog 保留期设得比预期最长停机时间更长(如 72 小时),今后停机再启动就能接着读。" +
          "注意:只对【此后新产生】的日志生效,救不回已被删除的 —— 所以本次仍需先选上面那项恢复作业。",
      },
      { id: "open_logs", label: "查看完整日志", consequence: "打开运行日志核对原始堆栈与时间点。" },
    ],
  },
  {
    // 本轮根治的主角:冷启动致 checkpointId 归 1 撞历史残留 manifest。
    code: "S3TABLES_MANIFEST_CONFLICT_412",
    match: /pre-conditions you specified did not hold|Status Code: 412/i,
    severity: "blocker",
    summary: "写 S3 Tables 时和上一次运行留下的临时文件重名,被存储层拒绝,导致首个检查点失败并重启。",
    cause:
      "Flink 写 Iceberg 表时会生成临时清单文件,其文件名由「作业ID+检查点编号」等固定字段拼成,不含随机值。" +
      "若作业【丢状态冷启动】,检查点编号会从 1 重新开始,于是和上一次运行的同名文件相撞;" +
      "而 S3 Tables 不允许覆盖已存在的文件 → 412。根因通常是「本该从快照恢复、却退化成了冷启动」。",
    actions: [
      {
        id: "resume_from_snapshot",
        label: "确认开启快照并从快照恢复(推荐)",
        consequence:
          "开启快照后,停止会自动保存状态、启动会接着上次的检查点编号,文件名不再相撞。" +
          "这是根治路径(平台默认已开启;若被显式关闭请在编辑页打开)。",
        recommended: true,
      },
      {
        id: "restart_without_state",
        label: "换一张新的结果表",
        consequence:
          "若这张表已积累了冲突的历史临时文件、且无法从快照恢复,改写到一张新表可绕开撞名。" +
          "代价:历史产出留在旧表,需要自行处理两表衔接。",
      },
      { id: "open_logs", label: "查看完整日志", consequence: "打开运行日志核对 412 出现的检查点编号。" },
    ],
  },
  {
    code: "HADOOP_FS_INFO_NOISE",
    match: /Hadoop FS is not available/i,
    severity: "warning",
    summary: "日志里的「Hadoop FS is not available」是无害提示,不是故障原因。",
    cause:
      "这是 Flink 安全令牌模块探测到运行环境未内置 Hadoop 后跳过的正常 INFO 提示,与数据读写无关。" +
      "判断作业是否真有问题,应看作业状态、重启次数、检查点是否失败。",
    actions: [{ id: "open_logs", label: "查看完整日志", consequence: "按「重启次数/检查点失败」定位真实故障。" }],
  },
];

/**
 * 从原始错误文本识别已知故障模式,给出人话诊断 + 可执行建议。
 * 纯函数:命中返回建议,未命中返回 null(此时前端只展示原始错误,不臆造建议)。
 *
 * 🔴 刻意的设计边界:**只诊断、不代劳**。返回的 actions 是给用户在页面上选的,
 * 平台不据此自动改配置/自动重启 —— 因为取舍(能否容忍重复数据/重算)涉及业务语义。
 */
export function adviseFailure(rawError?: string | null): FailureAdvice | null {
  if (!rawError) return null;
  for (const p of PATTERNS) {
    if (p.match.test(rawError)) {
      const { match: _m, ...advice } = p;
      return advice;
    }
  }
  return null;
}

/** 按稳定故障码直取建议(不依赖正则匹配文本)。
 *  用于平台**主动**识别出的前置条件(如启动预检判定位点过期)—— 此时故障码已确定,
 *  不该再拿提示文案去反向猜模式。未登记的码返回 null。 */
export function adviceByCode(code?: string | null): FailureAdvice | null {
  if (!code) return null;
  const p = PATTERNS.find((x) => x.code === code);
  if (!p) return null;
  const { match: _m, ...advice } = p;
  return advice;
}

/** 已登记的故障模式数量(供漂移守卫单测:新增模式必须同步补测)。 */
export const FAILURE_PATTERN_COUNT = PATTERNS.length;
