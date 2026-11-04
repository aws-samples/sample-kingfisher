import { describe, it, expect } from "vitest";
import { adviseFailure, FAILURE_PATTERN_COUNT } from "../failure-advisor";

// 故障顾问单测(纯函数,不打 AWS)。故障文本取自 2026-07-25 真机日志原文,
// 保证正则对【真实堆栈】生效,而非对臆造的示例生效。
// 见 docs/design/32-realtime-compute/DESIGN-flink-s3tables-412-rootfix.md §10。

// 真机原文(用户从 Flink 作业异常面板复制):CDC 位点过期。
const REAL_BINLOG_EXPIRED = `
java.lang.RuntimeException: One or more fetchers have encountered exception
	at org.apache.flink.connector.base.source.reader.fetcher.SplitFetcherManager.checkErrors(SplitFetcherManager.java:333)
Caused by: java.lang.IllegalStateException: The connector is trying to read binlog starting at Struct{version=1.9.8.Final,connector=mysql,name=mysql_binlog_source,ts_ms=1784986751379,db=,server_id=0,file=mysql-bin-changelog.000082,pos=4,row=0}, but this is no longer available on the server. Reconfigure the connector to use a snapshot when needed.
	at org.apache.flink.cdc.connectors.mysql.debezium.task.context.StatefulTaskContext.loadStartingOffsetState(StatefulTaskContext.java:207)
`.trim();

// 真机原文:S3 Tables manifest 撞名 412。
const REAL_412 = `
org.apache.flink.runtime.checkpoint.CheckpointException: Could not complete snapshot 1 for operator IcebergFilesCommitter -> IcebergSink s3t.realtime.rt_gmv_by_product: Writer (1/1)#0. Failure reason: Checkpoint was declined.
Caused by: software.amazon.awssdk.services.s3.model.S3Exception: At least one of the pre-conditions you specified did not hold (Service: S3, Status Code: 412, Request ID: EN08ZESZYDY3GFWV)
	at org.apache.iceberg.aws.s3.S3OutputStream.completeUploads(S3OutputStream.java:444)
`.trim();

const REAL_HADOOP_NOISE =
  "Hadoop FS is not available (not packaged with this application): NoClassDefFoundError org/apache/hadoop/conf/Configuration";

describe("adviseFailure(故障顾问·把堆栈翻成人话+可执行建议)", () => {
  it("空/无错误 → 不臆造建议(返回 null,前端只展示原始错误)", () => {
    expect(adviseFailure(undefined)).toBeNull();
    expect(adviseFailure(null)).toBeNull();
    expect(adviseFailure("")).toBeNull();
  });

  it("未登记的陌生错误 → 返回 null(不硬套建议,避免误导)", () => {
    expect(adviseFailure("java.lang.NullPointerException: something we never saw")).toBeNull();
  });

  it("🔴 真机原文:CDC binlog 位点过期 → 识别为 blocker + 给出「放弃旧位点」推荐项", () => {
    const a = adviseFailure(REAL_BINLOG_EXPIRED)!;
    expect(a.code).toBe("CDC_BINLOG_POSITION_EXPIRED");
    expect(a.severity).toBe("blocker");
    // 人话结论不得含 Java 术语(用户看的是结论,不是堆栈)
    expect(a.summary).not.toMatch(/Exception|binlog starting at|Struct/);
    const rec = a.actions.filter((x) => x.recommended);
    expect(rec).toHaveLength(1);
    expect(rec[0].id).toBe("restart_without_state");
    // 每个选项都必须写清后果(知情决策)
    for (const act of a.actions) expect(act.consequence.length).toBeGreaterThan(10);
  });

  it("🔴 位点过期的其他措辞变体也识别(MySQL 服务端直报,非 Debezium 措辞)", () => {
    // 用户 2026-07-26 提醒:位点过期这一类错误必须覆盖全。这些是 MySQL/binlog 侧的等价报错,
    // 后果同为"从快照/checkpoint 恢复必崩且不自愈",都应判为同一故障码。
    const variants = [
      "com.github.shyiko.mysql.binlog... Client requested master to start replication from position > file size; the first event ...",
      "Could not find first log file name in binary log index file",
    ];
    for (const v of variants) {
      const a = adviseFailure(v);
      expect(a?.code).toBe("CDC_BINLOG_POSITION_EXPIRED");
    }
    // 反向:正常 binlog 日志行不得误命中
    expect(adviseFailure("Connected to MySQL binlog reader at mysql-bin.000108")).toBeNull();
  });

  it("🔴 真机原文:S3 Tables 412 撞名 → 识别为 blocker + 推荐走快照恢复", () => {
    const a = adviseFailure(REAL_412)!;
    expect(a.code).toBe("S3TABLES_MANIFEST_CONFLICT_412");
    expect(a.severity).toBe("blocker");
    expect(a.actions.filter((x) => x.recommended)[0].id).toBe("resume_from_snapshot");
  });

  it("Hadoop INFO 噪音 → 只标 warning,并明确「不是故障原因」(防误诊)", () => {
    const a = adviseFailure(REAL_HADOOP_NOISE)!;
    expect(a.code).toBe("HADOOP_FS_INFO_NOISE");
    expect(a.severity).toBe("warning");
    expect(a.summary).toMatch(/无害|不是故障/);
  });

  it("位点过期优先于 412 命中(两者共存时先报必须人工决策的那个)", () => {
    // 崩溃循环时日志可能同时含历史 412;应报 blocker 且需用户决策的位点过期。
    const a = adviseFailure(`${REAL_BINLOG_EXPIRED}\n${REAL_412}`)!;
    expect(a.code).toBe("CDC_BINLOG_POSITION_EXPIRED");
  });

  it("漂移守卫:新增故障模式必须同步补测(当前 3 种)", () => {
    expect(FAILURE_PATTERN_COUNT).toBe(3);
  });
});
