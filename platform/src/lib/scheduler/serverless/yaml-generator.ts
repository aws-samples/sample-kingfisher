// @kf-batch 50-WP15-airflow-serverless
// dag-factory YAML 定义生成器(SPEC v3.27 §3.15)。一个作业 × 一个 target = 一份 YAML = 一个 workflow(Name = dag_id)。
// 🔴 服务约束(spike 七跑 + 官方参数支持页):schedule 须合法 cron;start_date **必须在未来**(EventBridge Scheduler 照 cron 触发,不受它影响);
//    retries 0..3;execution_timeout ≤ 3600;不用 callback / trigger_rule / 分支 / ExternalTaskSensor;定义 < 50KB。
import { BGP_RUNTIME_MODULE } from "./runtime-py";
import type { PlaceWire } from "@/lib/place/wire";

export type ServerlessEngine = "redshift" | "glue" | "emr";

/** run_job 的 op_kwargs.spec —— 运行时模块唯一读的东西(字段名与 runtime-py.ts 一一对应)。 */
export interface ServerlessJobSpec {
  engine: ServerlessEngine;
  jobId: string;
  dagId: string;
  taskType: string;
  jobsTable: string;
  ctrlRegion: string;
  /**
   * @kf-batch 50-WP31-place-first-class —— 序 4(L6):**执行落点**(PlaceWire v1)。原来的 `execRegion` + 数仓三样
   * (`workgroup` / `database` / `secretArn`)四个平面字段合并于此;运行时用 `bgp_read_place` 读,缺 / 不合法即拒,
   * 且 `place.targetId` 必须等于 `stamp.targetId`。redshift 作业必须带数仓腿。
   */
  place: PlaceWire;
  lockAttr: string;
  stamp: { projectId: string; targetId: string };
  // @kf-batch 50-WP5-rungroup —— O2:定时触发的确定性分组(50 SPEC v3.44 §3.17.2)。
  // 🔴 **只有发布时扇出到 >1 个 target 才注入**:Python 侧只知道自己那个区,「这次是不是联动」
  //    只有发布期的 TS 知道 ⇒ 不注入就等于「单区定时不成组」(与 E-166 同一条口径)。
  // 🔴 `cron` 是**分组时间轴的唯一来源** —— 刻意不用 Airflow 的 run_id / logical_date
  //    (MWAA Serverless 下它退化成常量,拿它分组会把所有历次定时归成同一个组)。
  scheduledGroup?: {
    definitionKind: string;
    definitionId: string;
    cron: string;
    table: string;
    projectId: string;
    requestedTargets: string[];
    /** 本份产物的定义版本(E-168:跨区版本差要看得见;**刻意不进分组键**)。 */
    definitionVersion?: number;
  };
  // redshift(数仓落点在 place.redshift)
  statements?: string[];
  // glue
  glueJobName?: string;
  // emr
  applicationId?: string;
  executionRoleArn?: string;
  entryPoint?: string;
  entryPointArguments?: string[];
  sparkSubmitParameters?: string;
  logUri?: string;
  runName?: string;
}

const DAG_ID_RE = /^[A-Za-z0-9_.-]{1,200}$/;
const CRON_RE = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/;
export const MAX_DEFINITION_BYTES = 50 * 1024;

/** 极简 YAML 序列化:对象 / 数组 / 标量;字符串一律 JSON 双引号(JSON 双引号标量是合法 YAML)。 */
export function toYaml(v: unknown, indent = 0): string {
  const pad = " ".repeat(indent);
  if (Array.isArray(v)) {
    if (v.length === 0) return `${pad}[]`;
    return v.map((x) => (isScalar(x) ? `${pad}- ${scalar(x)}` : `${pad}-\n${toYaml(x, indent + 2)}`)).join("\n");
  }
  if (v && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
    if (entries.length === 0) return `${pad}{}`;
    return entries
      .map(([k, x]) => {
        if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(k)) throw new Error(`YAML 键非法:${JSON.stringify(k)}`);
        // 🔴🔴 **键必须加引号**(2026-09-11 真环境抓到):YAML 1.1 会把 `yes` / `no` / `on` / `off` / `y` / `n`
        //   读成**布尔**、把纯数字读成**整数**。而 task 名来自用户的节点名 ⇒ 一个叫 `no` 的节点会让
        //   `no:` 这个键变成 `false`,而 `dependencies: ["no"]` 里那个带引号的字符串仍是 `"no"`
        //   ⇒ 依赖指向一个**不存在**的 task ⇒ CreateWorkflow 直接 `Workflow validation failed`(段 slsw SW-7 首跑就是这么红的)。
        //   加引号一次性堵死整类(布尔 / 数字 / null / `~` / 版本号样式…),对 dag-factory 完全等价。
        const key = JSON.stringify(k);
        return isScalar(x) ? `${pad}${key}: ${scalar(x)}` : `${pad}${key}:\n${toYaml(x, indent + 2)}`;
      })
      .join("\n");
  }
  return `${pad}${scalar(v)}`;
}
function isScalar(x: unknown): boolean {
  return x === null || ["string", "number", "boolean"].includes(typeof x);
}
function scalar(x: unknown): string {
  if (x === null) return "null";
  if (typeof x === "string") return JSON.stringify(x);
  return String(x);
}

/** 生成日 +1(服务校验 start_date 必须在未来)。 */
export function futureStartDate(now = new Date()): string {
  const d = new Date(now.getTime() + 24 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

export function buildWorkflowYaml(args: { dagId: string; cron: string; spec: ServerlessJobSpec; now?: Date }): string {
  const { dagId, cron, spec } = args;
  if (!DAG_ID_RE.test(dagId)) throw new Error(`非法 dagId ${JSON.stringify(dagId)}`);
  if (!CRON_RE.test(cron.trim())) throw new Error(`cron 须为 5 段表达式,收到 ${JSON.stringify(cron)}`);
  if (spec.dagId !== dagId) throw new Error("spec.dagId 与 dagId 不一致");
  const doc = {
    [dagId]: {
      schedule: cron.trim(),
      start_date: futureStartDate(args.now),
      default_args: { retries: 0, execution_timeout: 3600 },
      tasks: {
        run_job: {
          operator: "airflow.providers.standard.operators.python.PythonOperator",
          python_callable: `${BGP_RUNTIME_MODULE}.run_job`,
          op_kwargs: { spec },
        },
      },
    },
  };
  const text = toYaml(doc) + "\n";
  if (Buffer.byteLength(text, "utf8") > MAX_DEFINITION_BYTES) {
    throw new Error(`workflow 定义 ${Buffer.byteLength(text, "utf8")} 字节超过服务上限 ${MAX_DEFINITION_BYTES}(SQL 语句过长:请拆分作业)`);
  }
  return text;
}
