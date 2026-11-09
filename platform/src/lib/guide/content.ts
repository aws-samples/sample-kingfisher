// 「操作指引」—— 全部指引文案的**单一作者**(53 DESIGN §2)。
//
// 用户 2026-09-06 原话:「你需要给网页上增加一个操作指引,不然现在的系统没几个人会用」。
// 三块内容:① 每个菜单页「本页怎么用」(作用 / 步骤 / 要点 / 相关页);② 按角色的「快速上手」动线;③「多区域与合规」专线。
// 🔴 纪律:步骤里只写页面上**真有的按钮 / 标签文案**(与 t() 源串逐字同);每个菜单叶子都必须有一条(门禁 content.test.ts 按 routes.tsx 逐叶点名);
//    文案里不写 ASCII 双引号(用「」);中文源串即 i18n key,英文由 messages/en.ts 提供,缺则回落中文。

export interface PageGuide {
  /** 菜单叶子 key(路由前缀) */
  path: string;
  /** 与 routes.tsx 的菜单 label 逐字同 */
  title: string;
  what: string;
  steps: string[];
  tips?: string[];
  /** 相关页(路由前缀,必须是菜单叶子) */
  related?: string[];
}

export interface JourneyStep {
  title: string;
  desc: string;
  path: string;
  /**
   * 这一步在**目标页面上**要高亮的控件(它自己的 `data-testid`)。
   *
   * 🔴 有它 ⇒ 导览会在导航到该页后**再高亮一次那个真控件**(「点这个按钮」);
   *    没有 ⇒ 只能停在「点左侧菜单进这一页」那一步 = 指引只走了一半。
   *    缺口由棘轮 `TOUR_UNANCHORED_LIMIT` 盯着(只减不增),**不许静默当成完整导览**。
   */
  target?: string;
  /** 高亮那个控件时的一句人话动作(缺省用 `desc`)。 */
  hint?: string;
}

export interface Journey {
  key: "admin" | "dev" | "analyst";
  label: string;
  steps: JourneyStep[];
}

export const GUIDE_VERSION = "v1";
export const GUIDE_SEEN_KEY = `bgp-guide-seen-${GUIDE_VERSION}`;
export const GUIDE_AUTO_KEY = "bgp-guide-auto";

export const PAGE_GUIDES: Record<string, PageGuide> = {
  "/": {
    path: "/", title: "首页",
    what: "平台总览:资源数量、今日运行与成功率、近 7 日趋势;右上角 ❓ 随时打开操作指引。",
    steps: ["先看「新手引导」卡片,按角色选一条动线开始", "KPI 卡片点进对应页面(数据源 / 同步任务 / ETL 作业 / EMR 作业)", "运行状态分布与趋势用于判断今天有没有失败要处理"],
    related: ["/projects", "/exec-envs", "/etl-jobs"],
  },
  "/copilot/plans": {
    path: "/copilot/plans", title: "Copilot 计划中心",
    what: "把一句业务诉求交给 Copilot,生成分步执行计划(建源 / 同步 / 建作业 / 调度),逐步确认执行。",
    steps: ["输入诉求后点「生成计划」", "逐条查看计划步骤,确认后执行;每一步落成真实资源", "执行后到「任务监控」看运行结果"],
    tips: ["长诉求建议拆成几条聚焦诉求,计划更完整", "计划用的模型在「系统设置 → AI 模型」里配置"],
    related: ["/monitor", "/settings"],
  },
  "/datasources": {
    path: "/datasources", title: "数据源管理",
    what: "登记外部数据源(MySQL / PostgreSQL / S3 / Kafka / DynamoDB 等),供同步任务与查询使用。",
    steps: ["点「新建数据源」,选类型、填连接信息", "需要走 VPC 的源(JDBC / MSK),在网络接入区选 VPC、子网、安全组后点「保存网络接入」", "列表里「刷新」查看连接状态;进入详情浏览表"],
    tips: ["源的归属执行目标(ownerTargetId)新建即盖章,之后不可改", "JDBC 源要放行数据库端口的安全组入站,否则浏览表为 0"],
    related: ["/sync", "/exec-envs"],
  },
  "/sync": {
    path: "/sync", title: "数据同步",
    what: "把数据源的数据同步到 S3 数据湖或 Redshift 数仓;支持全量 / 增量 / CDC 与流式(Kinesis / MSK)。",
    steps: ["点「新建同步任务」,选源与目标", "选「同步模式」与「同步通道」(Glue / EMR / DMS / Flink 等)", "保存后运行;状态列显示运行中 / 成功 / 失败", "要把 dev 里调好的任务发到 prod:进任务详情点「发布到环境」—— 发到 staging 直接生效,发到 prod 需审批(项目空间 owner 在「待我审批」批准后 prod 才有这一份);顶栏「环境」切到 prod 即可看到"],
    tips: ["DMS 与 Zero-ETL 通道有持续计费,不用时及时停", "同步任务的绑定区域必须是源可达的区(网络方案 = 每区独立源)", "Table Bucket 下拉只列可写路由(显示 桶 · 别名 · 分层);客户自有表桶要先在「系统设置 → 数据湖表桶与路由」登记,主控区与执行区同一规则"],
    related: ["/datasources", "/monitor", "/settings"],
  },
  "/etl-jobs": {
    path: "/etl-jobs", title: "离线计算",
    what: "三种离线作业:Redshift SQL、Glue PySpark、EMR Serverless(PySpark);一个作业可绑多个执行区域,一次运行每区各跑一次。",
    steps: ["点「新建」,选作业类型(Glue PySpark 脚本作业 / Redshift SQL 作业 / EMR Serverless),填名称后「创建」", "在「执行区域(可多选)」勾区,或点「全选当前活跃区」", "在脚本编辑器写 SQL / PySpark(也可「AI 生成代码」),点「保存」", "点「立即运行(N 个区各跑一次)」;Redshift 作业可先「试运行」", "切到「运行历史」看每个区的一条 run;填 cron 后「发布到 MWAA 调度」", "要把 dev 里做好的作业发到 prod:作业卡「发布到环境」→「发布到 staging」直接生效;「发布到 prod(需审批)」会生成审批单,项目空间 owner 在「待我审批」批准后 prod 才有这一份,通知里的「切到 prod 环境查看」直达;作业卡的环境状态标写明 staging ✓ / prod ✓ 与版本号"],
    tips: ["跨法域区首次操作会弹免责告知,同意后才执行", "运行历史的「审计」列可回查每次运行的区域审计记录", "「发布到环境」只带作业定义(脚本 / 绑定区 / 参数),不带运行历史;「发布到 MWAA 调度」是在当前环境挂定时,两者不是一回事", "「高级属性 → 数据湖表桶」:作业缺省能用本区全部路由的目录(别名见「本作业可用的目录」),跨桶读写直接写 <别名>.<命名空间>.<表> 三段名;只用部分桶或自建角色要最小权限时,勾选子集并给每个桶标读 / 写,保存时按桶量权限"],
    related: ["/workflow", "/monitor", "/exec-envs", "/settings"],
  },
  "/workflow": {
    path: "/workflow", title: "ETL 编排",
    what: "把多个作业编成有依赖的工作流,发布到 Airflow(MWAA)按计划运行。",
    steps: ["点「新建工作流」,在画布里添加节点并连线", "配置调度周期与 SLA,点「发布到调度」(发布到 Airflow)", "在「最近运行」看每次 DAG 运行;失败可重跑或补数", "要把工作流发到 prod:详情里「发布到环境」—— staging 直发、prod 需审批(项目空间批准后生效),顶栏「环境」切到 prod 查看"],
    tips: [
      "切换了调度的工作流会重新生成 DAG;同一作业不会并发重复运行(作业级运行锁)",
      "离线作业节点:把本项目里绑定了本工作流执行区的离线计算作业(Glue / Redshift)或 EMR Serverless 作业拖进 DAG,与同步节点串成一条链;发布时作业必须绑在工作流的执行区(否则 400 点名节点),作业运行历史会出现「由工作流触发」的一行;被工作流引用的作业不能删(409)",
    ],
    related: ["/etl-jobs", "/backfill", "/monitor"],
  },
  "/redshift": {
    path: "/redshift", title: "Redshift 查询",
    what: "对一个或多个执行区域的 Redshift 直接查询;多区时每区一个结果 sheet,可对比或合并。",
    steps: ["在「执行区域(可多选)」选区,或点「全选当前活跃区」", "在编辑器写 SQL,点「执行」", "多区结果按 sheet 查看;「⚖ 对比」看差异,「合并为一张表」合并", "「执行历史」里可回看 SQL;跨法域的原文「留在区域」,点查看按需读取"],
    tips: ["跨法域区首次查询会弹免责告知(每人每区只弹一次)", "sheet 头的「审计 #」是该次查询的区域审计记录 ID"],
    related: ["/exec-envs", "/audit"],
  },
  "/athena": {
    path: "/athena", title: "Athena 查询",
    what: "对 S3 数据湖(含 S3 Tables)做交互式 SQL 查询。",
    steps: ["左侧选库表(「刷新表」可重新拉取)", "写 SQL 后点「执行」", "查看结果并按需导出"],
    related: ["/sync", "/governance"],
  },
  "/realtime-compute": {
    path: "/realtime-compute", title: "实时计算",
    what: "Flink 流式作业:从 Kinesis / MSK / CDC 源读数,写入数据湖或数仓。",
    steps: ["新建作业,写 Flink SQL 或点「AI 生成」", "需要自定义连接器时「上传连接器 JAR」", "点「保存」后启动;查看运行状态与日志"],
    tips: ["长 SQL 会自动规范化并分片写入应用属性(2048 字节上限)"],
    related: ["/datasources", "/monitor"],
  },
  "/genbi": {
    path: "/genbi", title: "智能问数",
    what: "用自然语言问数据:自动检索相关表、生成并执行 SQL、给出结论。",
    steps: ["输入问题,回车提问", "点「查看生成的 SQL」核对取数逻辑", "在「最近提问」里回看历史对话"],
    tips: ["问题里点到具体表名或指标名,检索更准", "用的模型与来源可在「系统设置 → AI 模型」查看和更换"],
    related: ["/knowledge", "/settings"],
  },
  "/skills": {
    path: "/skills", title: "技能 Skills",
    what: "把业务口径、常用查询封装成技能,问数与 Copilot 会话自动加载,零部署生效。",
    steps: ["点「注册技能」,填名称、触发方式与内容", "保存后在智能问数里直接触发验证"],
    related: ["/genbi", "/observability"],
  },
  "/observability": {
    path: "/observability", title: "可观测看板",
    what: "AI 能力的调用可观测:技能命中、调用量与耗时。",
    steps: ["查看技能调用统计;点「刷新」拉最新", "无数据时先到智能问数发起几次提问"],
    related: ["/skills", "/genbi"],
  },
  "/bi": {
    path: "/bi", title: "报表搭建器",
    what: "拖拽式搭建报表与仪表盘,取数源为数仓查询;支持筛选器注入。",
    steps: ["新建报表,选取数源并写查询", "添加图表组件与筛选器", "保存后在报表库里查看与分享"],
    tips: ["历史的 dataapi 取数源已下线,相关卡片显示「数据服务已下线」"],
    related: ["/redshift", "/genbi"],
  },
  "/requirements": {
    path: "/requirements", title: "需求工作台",
    what: "业务提数据需求,开发用大模型生成实现并直接建成 ETL 作业。",
    steps: ["业务方新建需求并描述", "开发方点「大模型生成实现」,核对后「创建 ETL 作业」", "用「添加评论」协作,状态流转到完成"],
    related: ["/etl-jobs", "/copilot/plans"],
  },
  "/governance": {
    path: "/governance", title: "数据治理",
    what: "敏感数据扫描与脱敏规则、跨地域元数据总览(每个执行区域一行,含 🌍 法域标签)。",
    steps: ["点「开始扫描」识别敏感列;「同步 Redshift 列」刷新元数据", "配置脱敏规则并「保存」(需平台管理员)", "在跨地域元数据总览里看各区的表 / 列计数与陈旧状态"],
    related: ["/governance-workbench", "/multi-region"],
  },
  "/governance-workbench": {
    path: "/governance-workbench", title: "治理工作台",
    what: "治理任务的工作台视图:待处理项、质量与合规指标。",
    steps: ["查看待处理项并逐条处置", "点「刷新」同步最新状态"],
    related: ["/governance"],
  },
  "/modeling": {
    path: "/modeling", title: "数据建模",
    what: "维度 / 码表 / 分层建模,并把建模产物落地到各个执行区域的数仓。",
    steps: ["点「新建」或「新建分层」定义模型,「保存」", "在落地面板选「执行区域」逐区落地;看板显示每区落地状态与 drift", "不再需要时在落地面板逐区〔解绑并清理〕(残留会显式可见)"],
    tips: ["删除有落地产物的定义会被拦下(409),要先清理或显式保留"],
    related: ["/multi-region", "/governance"],
  },
  "/knowledge": {
    path: "/knowledge", title: "业务口径与规则",
    what: "维护业务口径、指标定义与规则,供智能问数与治理引用。",
    steps: ["点「新建条目」填口径与规则", "「保存」后在智能问数里验证是否被引用"],
    related: ["/genbi", "/skills"],
  },
  "/openmetadata": {
    path: "/openmetadata", title: "数据治理中心",
    what: "内置的 OpenMetadata:血缘、表描述、数据质量的统一目录。",
    steps: ["状态为运行中时进入治理中心", "在目录里搜表、看血缘与描述;描述会回流到问数检索"],
    tips: ["未就绪时页面会提示「请检查部署状态」"],
    related: ["/governance"],
  },
  "/monitor": {
    path: "/monitor", title: "任务监控",
    what: "所有运行实例的统一视图:按项目 / 区域筛选,看日志、重跑、补数,并可回查审计。",
    steps: ["用筛选器按状态 / 区域过滤运行实例", "点一条运行看「运行日志」;失败可重跑", "「审计」列回查跨法域运行的区域审计记录"],
    related: ["/etl-jobs", "/backfill", "/alerting"],
  },
  "/multi-region": {
    path: "/multi-region", title: "多 Region 看板",
    what: "每个作业 / 建模产物在各执行区域的版本一致性矩阵:漏发、版本不齐、失败一眼可见。",
    steps: ["按行看每个对象在各区的格:绿=一致、红=失败、⊘=待重新落地(写入通道交付前的旧记录)", "建模产物可直接「落地到此 region」(需平台管理员)", "格里的问题回到对应页面处理后「刷新」"],
    related: ["/exec-envs", "/modeling", "/etl-jobs"],
  },
  "/backfill": {
    path: "/backfill", title: "补数中心",
    what: "对历史日期区间重跑作业或工作流:自动展开日期 × 节点实例、限并发、按依赖推进。",
    steps: ["选作业 / 工作流与日期区间,预览实例数", "点「确认创建」生成补数计划", "在列表里看进度;失败项可只续跑失败的"],
    tips: ["补数运行与在线调度隔离,不污染成功率与 SLA 统计"],
    related: ["/monitor", "/workflow"],
  },
  "/alerting": {
    path: "/alerting", title: "告警中心",
    what: "任务失败 / 断流 / SLA 预警的规则与通道管理。",
    steps: ["点「新建告警规则」,选对象与触发条件(失败 / 断流 / SLA)", "绑定通知通道后「保存」并「启用」", "SLA 基线由历史运行自动学习,破线前预警"],
    related: ["/monitor", "/incidents"],
  },
  "/finops": {
    path: "/finops", title: "成本治理 FinOps",
    what: "把账单下钻到任务 / 运行级:大盘看趋势、排行找烧钱任务、预算越档推送。",
    steps: ["看大盘与趋势,定位成本突增", "排行里找到高成本任务,回到作业页优化", "设置预算与告警阈值"],
    tips: ["成本行带执行目标章,后续可按区域归因"],
    related: ["/monitor", "/alerting"],
  },
  "/ops": {
    path: "/ops", title: "运维大屏",
    what: "今日运行、最近运行时间线(甘特)与失败分布的一屏总览。",
    steps: ["用于值班巡检;点「手动刷新」拉最新", "从甘特里点到具体运行去任务监控处理"],
    related: ["/monitor", "/incidents"],
  },
  "/incidents": {
    path: "/incidents", title: "运维知识库",
    what: "失败任务的 AI 诊断按故障指纹归并成条目,你在这里维护「已验证修复手册」。",
    steps: ["打开一条故障类别,查看历次诊断", "写下验证有效的修复方法,点「保存修复手册」", "需要外发时用「脱敏导出」"],
    related: ["/monitor", "/alerting"],
  },
  "/projects": {
    path: "/projects", title: "项目空间",
    what: "资源按项目隔离;这里建项目、加成员、审批加入申请、切换当前空间。",
    steps: ["点「创建」建项目;在成员里添加用户并指定角色(owner / editor / viewer)", "「切换到此」切换顶栏当前项目空间", "处理「待审批(访问 / 角色申请)」"],
    tips: ["数据源 / 作业 / 编排等资源都只在当前项目空间可见", "删项目会逐类盘点项目下的资源(作业 / 同步 / 编排 / 报表 / 问数卡片 / 定时治理与造数 / 未收口的 Copilot 与补数计划等),任一类不为 0 或读不到就拒绝并点名", "系统代管的每区数仓凭证在删项目时自动回收"],
    related: ["/admin/users", "/exec-envs"],
  },
  "/exec-envs": {
    path: "/exec-envs", title: "执行环境",
    what: "管理多个 region 的执行环境:注册 → 平台自动部署 → 探活 → 启用 → 授权项目,之后作业与查询即可选它。",
    steps: ["点「新建执行环境」,选 region 与法域;组件是完整的一套、按法域自动确定(只读,不用勾);跨法域需勾免责告知;最后一步「开始部署」", "部署成功后由管理员跑一次 redeploy-platform 放行该区,再回详情页「检测初始化」,探活全绿后「启用」", "在「授权项目」卡选全部项目或白名单", "升级平台后用「重新部署」(预演 → 审批 → 部署);缺组件用「补充部署」", "「已同意告知」卡可回查谁在何时同意了哪版告知", "删除:从没装出来的点「弃置」;装过的先「停止承接」,再看影响预览、输入 region 名确认、经审批后销毁(数据桶 / 表桶 / 最终快照保留,需人工清理)"],
    tips: ["只能在控制面同一账号的其他 region 建环境;一个 region 只能有一套", "被组织 SCP 拦住的 region 在向导里列出但不可选,并写明被拦的动作;显示「未能核实组织策略」的可点「刷新」重查"],
    related: ["/multi-region", "/etl-jobs", "/redshift"],
  },
  "/admin/users": {
    path: "/admin/users", title: "用户管理",
    what: "平台账号与角色组(bgp-admin / bgp-manager / bgp-developer / bgp-analyst)的管理。",
    steps: ["点「创建用户」,设初始密码与角色组", "禁用 / 「启用」账号;改角色组", "运营分析账号只能用智能问数与提需求(网关层收口)"],
    related: ["/projects", "/audit"],
  },
  "/audit": {
    path: "/audit", title: "审计日志",
    what: "平台操作审计:谁在何时做了什么;跨法域操作只留摘要(原文留在区域审计表)。",
    steps: ["按动作 / 资源 / 时间筛选,点「刷新」", "跨法域记录看 residency.* 动作与 auditId;原文按 auditId 到区域侧回查"],
    related: ["/exec-envs", "/monitor"],
  },
  "/settings": {
    path: "/settings", title: "系统设置",
    what: "平台级设置:AI 模型(所有 AI 能力共用,秒级生效)、接线健康状态、各执行环境的数据湖表桶与路由。",
    steps: ["「AI 模型」卡看当前生效模型与来源;管理员点「更换全局默认」,探测通过后保存", "出问题时「恢复出厂默认」", "「刷新状态」查看各接线是否健康"],
    tips: ["「数据湖表桶与路由」卡:把客户自己的 S3 Tables 表桶登记为路由(别名 / 分层 / 命名空间归属 / 可写),作业脚本就能用 <别名>.<命名空间>.<表> 三段名读写它、同步任务能把它选为 Table Bucket,无需手写 Spark 配置;同一命名空间出现在两条路由里要声明归属"],
    related: ["/genbi", "/copilot/plans", "/etl-jobs", "/sync"],
  },
};

export const JOURNEYS: Journey[] = [
  {
    key: "admin", label: "管理员(平台上线)",
    steps: [
      { title: "建项目空间、加成员", desc: "项目空间 → 「创建」→ 成员里加人并定角色", path: "/projects",
        target: "proj-create-btn", hint: "先点「新建项目空间」建一个空间;建好后在行内「成员」里加人并定角色" },
      { title: "建账号与角色组", desc: "用户管理 → 「创建用户」→ 分到 bgp-manager / developer / analyst", path: "/admin/users",
        target: "user-create-btn", hint: "点「创建用户」;创建时选角色组(bgp-manager / developer / analyst),权限跟着组走" },
      { title: "接入数据源", desc: "数据源管理 → 「新建数据源」→ 需要 VPC 的源「保存网络接入」", path: "/datasources",
        target: "ds-create-btn", hint: "点「新建数据源」;库在 VPC 里的源建完还要在行内「网络接入」里保存一次(否则浏览表是 0 张)" },
      { title: "注册第二个 region 的执行环境", desc: "执行环境 → 「新建执行环境」→ 「开始部署」→ 放行该区 → 「检测初始化」→ 「启用」→ 「授权项目」", path: "/exec-envs",
        target: "exec-env-new-btn", hint: "点「新建执行环境」走向导:选 region、填法域(组件是完整的一套,不用勾);跨法域要勾免责告知。最后一步「开始部署」" },
      { title: "配置 AI 模型", desc: "系统设置 → 「AI 模型」卡 → 更换全局默认(探测通过才能保存)", path: "/settings",
        target: "ai-model-card", hint: "就是这张「AI 模型」卡:点「更换模型」,平台会先真发一次探测,通了才允许保存" },
      { title: "巡检审计", desc: "审计日志看操作记录;跨法域操作按 auditId 回查", path: "/audit",
        target: "audit-search", hint: "在这里搜操作者 / 操作 / 资源;跨法域操作把运行历史里的「审计 #」贴进来就能回查" },
    ],
  },
  {
    key: "dev", label: "数据开发",
    steps: [
      { title: "同步数据进湖 / 仓", desc: "数据同步 → 「新建同步任务」→ 选模式与通道 → 运行", path: "/sync",
        target: "sync-create-btn", hint: "点「新建同步任务」:选源与目标(S3 Tables / Redshift)、全量还是增量、走哪条通道;建好在行内「运行」" },
      { title: "写离线作业并多区运行", desc: "离线计算 → 「新建」(Redshift SQL / Glue PySpark / EMR)→ 「全选当前活跃区」→ 「保存」→ 「立即运行」", path: "/etl-jobs",
        // 锚点已核实存在(src/app/etl-jobs/page.tsx);绑了多个区时点它会先问「这次在哪些区跑」
        // 🔴 锚点必须是这一页上**无条件存在**的控件:`etl-run-btn` 在「选中一个作业」之后才渲染
        //    (page.tsx 的 `!sel ? <Empty/> : (…)`)⇒ 新用户走到这一步只会看到「控件当前不在页面上」。
        //    真环境实测过这个故障形态(段 `guide` GT-3 首跑),换成总在的「新建」按钮,文案里再说清后一步。
        target: "etl-new-btn", hint: "先点「新建」建一个作业(Redshift SQL / Glue PySpark / EMR);建好并选中它,右边才会出现「立即运行」——绑了多个区它会先问你这次在哪些区跑" },
      { title: "编排与调度", desc: "ETL 编排 → 「新建工作流」→ 连线 → 「发布到调度」(Airflow)", path: "/workflow",
        target: "wf-create-btn", hint: "点「新建工作流」:把作业拖进画布连线,再「发布到调度」(MWAA Serverless,按任务秒计费);要发到 prod 环境用详情里的「发布到环境」" },
      { title: "多区直查核对", desc: "Redshift 查询 → 全选活跃区 → 「执行」→ 每区一个 sheet,可对比 / 合并", path: "/redshift",
        target: "rs-exec-targets", hint: "在这里勾选要查的执行区域,一条 SQL 可以同时打多个区" },
      { title: "看运行、补数", desc: "任务监控看日志重跑;补数中心对历史日期重跑", path: "/monitor",
        target: "monitor-search-btn", hint: "先用这里的条件筛出你要看的运行(可按执行区域 / 状态 / 时间窗),再点行内「日志」或「重跑」" },
      { title: "建模并落地各区", desc: "数据建模 → 定义 → 落地面板逐区落地;不用了逐区解绑并清理", path: "/modeling",
        target: "modeling-tabs", hint: "这几个页签就是各类定义(分层 / 数据域 / 码表 / 维度 / 指标);码表与维度建完要在行内「落地」到具体的区才算物化" },
    ],
  },
  {
    key: "analyst", label: "业务分析",
    steps: [
      { title: "自然语言问数", desc: "智能问数 → 提问 → 「查看生成的 SQL」核对", path: "/genbi",
        target: "genbi-ask-input", hint: "在这里用人话提问;答完一定点「查看生成的 SQL」核对一遍口径,再决定要不要保存成卡片" },
      { title: "搭报表", desc: "报表搭建器 → 选取数源 → 加图表与筛选器", path: "/bi",
        target: "bi-new-analysis-btn", hint: "点「新建分析看板」:选取数来源(可视化配置 / 自由 SQL / 从报表库导入),再往画布上加图表与筛选器" },
      { title: "提数据需求", desc: "需求工作台 → 新建需求 → 开发生成实现并建作业", path: "/requirements",
        target: "req-tabs", hint: "这几个页签是需求的流转箱(待处理 / 进行中 / 已完成);新建需求后由研发指派并生成实现" },
      { title: "维护口径", desc: "业务口径与规则 → 「新建条目」,问数会引用", path: "/knowledge",
        target: "kb-create-btn", hint: "点「新建条目」写下口径 / 规则;智能问数生成 SQL 时会引用它们,写清楚等于把口径钉住" },
    ],
  },
];

export const MULTI_REGION_FLOW: JourneyStep[] = [
  { title: "注册执行环境", desc: "执行环境 → 「新建执行环境」:选 region、法域(组件完整一套、自动确定);跨法域要勾免责告知;「开始部署」", path: "/exec-envs" },
  { title: "放行、探活、启用", desc: "部署成功后管理员跑 redeploy-platform 放行该区 → 详情页「检测初始化」探活全绿 → 「启用」;之后作业与查询可选它", path: "/exec-envs" },
  { title: "授权项目", desc: "「授权项目」卡选全部或白名单;白名单外的项目看不到该区", path: "/exec-envs" },
  { title: "作业绑多区一次运行", desc: "离线计算 → 「全选当前活跃区」→ 「立即运行(N 个区各跑一次)」→ 运行历史每区一条", path: "/etl-jobs" },
  { title: "多区直查", desc: "Redshift 查询 → 全选活跃区 → 每区一个 sheet;跨法域 sheet 带 🌍 法域与「审计 #」", path: "/redshift" },
  { title: "跨法域首次操作:免责告知", desc: "第一次对跨法域区做数据操作会弹告知,点「同意并继续」后留存(用户 / 目标 / 版本 / 时间),之后不再弹", path: "/redshift" },
  { title: "审计回查", desc: "运行历史 / 监控的「审计」列、执行环境详情「已同意告知」卡、审计日志的 residency.* 动作", path: "/audit" },
  { title: "看板兜底", desc: "多 Region 看板:漏发 / 版本不齐 / 失败的格显红;⊘ 表示待重新落地(写入通道交付前的旧记录)", path: "/multi-region" },
];

/** 按路径找「本页怎么用」:精确匹配优先,否则最长前缀(根 / 只精确匹配)。 */
export function guideForPath(pathname: string): PageGuide | null {
  if (!pathname) return null;
  if (PAGE_GUIDES[pathname]) return PAGE_GUIDES[pathname];
  const keys = Object.keys(PAGE_GUIDES).filter((k) => k !== "/" && pathname.startsWith(k + "/"));
  if (!keys.length) return null;
  keys.sort((a, b) => b.length - a.length);
  return PAGE_GUIDES[keys[0]];
}
