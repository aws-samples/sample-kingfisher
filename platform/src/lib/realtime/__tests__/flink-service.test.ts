import { describe, it, expect } from "vitest";
import { pickRestoreType, resolveRestoreType, estimateKpu, isSnapshotUnrecoverable, normalizeFlinkSql, buildSqlGroups, reassembleSqlFromGroups, buildKafkaAuthProps, mskSourceSql, type SnapshotProbe } from "../flink-service";
import { guard, guardCode } from "@/lib/cookbook";

// 架构补强(2026-07-25):flink-service 此前零单测。本文件为「启动恢复语义 + 资源规整」加回归网,
// 配合根治 S3Tables 首帧 412。根因(真机 CloudTrail 实测):平台 TaskRole 缺
// kinesisanalytics:ListApplicationSnapshots → AccessDenied 被 `catch {}` 静默吞 → 误判"无快照"
// → 恒发 SKIP_RESTORE → checkpointId 归 1 → delta manifest 撞同名残留 → S3 Tables 拒覆盖 → 412。
// 修法:探测结果三态化(available/none/unknown),unknown 绝不退化为冷启动。
// 见 docs/design/32-realtime-compute/DESIGN-flink-s3tables-412-rootfix.md。纯函数,不打 AWS。

describe("pickRestoreType(启动恢复决策·根治 412 核心纯函数)", () => {
  it("开快照 + 确认有快照 → RESTORE_FROM_LATEST(checkpointId 续编,永不撞残留)", () => {
    expect(pickRestoreType(true, "available")).toBe("RESTORE_FROM_LATEST_SNAPSHOT");
  });

  it("开快照 + 确认无快照 → SKIP(首启/空表,无残留可撞)", () => {
    expect(pickRestoreType(true, "none")).toBe("SKIP_RESTORE_FROM_SNAPSHOT");
  });

  it("🔴 回归守卫:开快照 + 探测失败(unknown) → 仍 RESTORE,【绝不】退化为冷启动", () => {
    // 这条是 412 的直接守卫。曾经的 bug 把探测异常当成"没有快照"→ 恒 SKIP → checkpointId 归 1
    // → 撞残留 manifest → 412。unknown 必须走 RESTORE(无快照时 AWS 自动全新启动,严格更安全)。
    expect(pickRestoreType(true, "unknown")).toBe("RESTORE_FROM_LATEST_SNAPSHOT");
  });

  it("🔴 回归守卫:开快照 + 快照过期(stale) → SKIP,避免从过期 binlog 位点恢复致崩溃循环", () => {
    // 实测事故(2026-07-25):快照 11:13 打、13:07 恢复(相隔 1h54m),源 binlog 位点已被 RDS 回收
    // → IllegalStateException: binlog ... no longer available → fullRestarts 持续攀升且不自愈。
    // 故过期快照必须主动冷启动,而不是崩一次才发现。
    expect(pickRestoreType(true, "stale")).toBe("SKIP_RESTORE_FROM_SNAPSHOT");
  });

  it("关快照(高级用户显式) → 恒 SKIP,无论探测结果如何(尊重用户选择)", () => {
    const probes: SnapshotProbe[] = ["available", "none", "stale", "unknown"];
    for (const p of probes) {
      expect(pickRestoreType(false, p)).toBe("SKIP_RESTORE_FROM_SNAPSHOT");
    }
  });

  it("全组合矩阵:仅「开快照 且 probe∈{available,unknown}」走 RESTORE(8 组合穷举)", () => {
    const probes: SnapshotProbe[] = ["available", "none", "stale", "unknown"];
    const combos: Array<[boolean, SnapshotProbe]> = [true, false].flatMap((s) => probes.map((p) => [s, p] as [boolean, SnapshotProbe]));
    const restore = combos.filter(([s, p]) => pickRestoreType(s, p) === "RESTORE_FROM_LATEST_SNAPSHOT");
    expect(restore).toEqual([[true, "available"], [true, "unknown"]]);
  });
});

describe("resolveRestoreType(叠加用户决策·缺陷2 盲区根治:让「放弃旧位点重启」真正冷启动)", () => {
  it("🔴 核心守卫:用户确认丢弃进度(discardStateConfirmed=true) → 无条件 SKIP,凌驾任何探测结果", () => {
    // 位点过期在真机几乎总以【运行中崩溃循环】暴露,预检判不出 stale(SHOW BINLOG EVENTS 无 Timestamp)
    // → probe 退化为 available/unknown。若不凌驾,用户点"放弃旧位点重启"仍走 RESTORE → 又回过期快照 → 继续崩。
    const probes: SnapshotProbe[] = ["available", "none", "stale", "unknown"];
    for (const p of probes) {
      expect(resolveRestoreType(true, p, true)).toBe("SKIP_RESTORE_FROM_SNAPSHOT");
    }
  });

  it("未确认(false/缺省) → 逐字节等同 pickRestoreType(既有行为零改动)", () => {
    const probes: SnapshotProbe[] = ["available", "none", "stale", "unknown"];
    for (const s of [true, false]) {
      for (const p of probes) {
        expect(resolveRestoreType(s, p, false)).toBe(pickRestoreType(s, p));
        expect(resolveRestoreType(s, p)).toBe(pickRestoreType(s, p));
      }
    }
  });

  it("确认丢弃 + 关快照 → 仍 SKIP(与既有一致,无冲突)", () => {
    expect(resolveRestoreType(false, "available", true)).toBe("SKIP_RESTORE_FROM_SNAPSHOT");
  });
});

describe("isSnapshotUnrecoverable(快照位点是否已被源端清掉·防 CDC 崩溃循环)", () => {
  it("无快照 → 不否定恢复(交由 none 分支处理)", () => {
    expect(isSnapshotUnrecoverable(undefined, new Date("2026-07-25T12:00:00Z"))).toBe(false);
  });

  it("查不到源端最老 binlog → 不主动否定恢复(交由 unknown 语义,不猜)", () => {
    expect(isSnapshotUnrecoverable(new Date("2026-07-25T11:13:00Z"), undefined)).toBe(false);
  });

  it("快照晚于最老 binlog → 位点仍在,可恢复", () => {
    expect(isSnapshotUnrecoverable(
      new Date("2026-07-25T11:13:00Z"),   // 快照
      new Date("2026-07-25T09:00:00Z"),   // 最老 binlog 更早 → 位点被覆盖范围内
    )).toBe(false);
  });

  it("🔴 实测事故场景:快照早于源端现存最老 binlog → 位点已被清 → 必须冷启动", () => {
    // 2026-07-25 真机:快照 11:13(位点 000082),但现存 binlog 仅 000108~000112
    // (在 binlog retention=None 时期被清净)。快照只有 2.5h "很新",却完全不可恢复
    // → 证明【年龄判据不可用】,必须比对源端实际 binlog 可达性。
    expect(isSnapshotUnrecoverable(
      new Date("2026-07-25T11:13:00Z"),   // 快照(仅 2.5h,按年龄判据会误判为可用)
      new Date("2026-07-25T13:20:00Z"),   // 现存最老 binlog 反而更晚 → 快照位点已不存在
    )).toBe(true);
  });
});

// SQL 注入编码(2026-07-26):根治 MSAF PropertyValue ≤2048 字节硬上限致的 ValidationException。
// 实测事故:CDC 模板经 Monaco 累进缩进膨到 2007 字节,注入凭证后 2052 > 2048 → UpdateApplication
// 抛 ValidationException → 被旧 catch{} 静默吞 → 平台拿空/旧 SQL 启动。根治=规范化(缩体积)+
// 【无上限】分片(跨 bgp* 组滚动,彻底移除长度天花板)+ runner 侧无损拼回。见 flink-service.ts。
const enc = (s: string) => new TextEncoder().encode(s).length;

describe("normalizeFlinkSql(注入前规范化·从源头缩体积,挡住 Monaco 累进缩进膨胀)", () => {
  it("逐行去首尾空白、删空行与整行注释,不改变语句顺序", () => {
    const raw = "  -- 注释\n\n  CREATE TABLE t (a INT);  \n   \nINSERT INTO t SELECT 1;\n";
    expect(normalizeFlinkSql(raw)).toBe("CREATE TABLE t (a INT);\nINSERT INTO t SELECT 1;");
  });

  it("🔴 累进缩进(Monaco 逐行自动缩进的产物)被压平,体积大幅下降", () => {
    // 复刻真机 DDB 那份 2007 字节 SQL 的成因:每行缩进递增。规范化后应显著变短。
    const bloated = Array.from({ length: 20 }, (_, i) => " ".repeat(i * 4) + "col_" + i + " BIGINT,").join("\n");
    expect(enc(normalizeFlinkSql(bloated))).toBeLessThan(enc(bloated));
  });

  it("幂等:规范化两次 = 规范化一次", () => {
    const raw = "  CREATE TABLE t (a INT);\n\n  INSERT INTO t SELECT 1;  ";
    expect(normalizeFlinkSql(normalizeFlinkSql(raw))).toBe(normalizeFlinkSql(raw));
  });

  it("不触碰行内内容(字符串字面量、行内 -- 不误删)", () => {
    // 行首非 -- 的行整行保留;字面量里的内容不动。
    const sql = "SELECT 'a -- not comment' FROM t;";
    expect(normalizeFlinkSql(sql)).toBe(sql);
  });
});

describe("buildSqlGroups + reassembleSqlFromGroups(SQL 注入编码·无 2048 上限)", () => {
  it("短 SQL(<2048B) → 老格式单值 bgp.sql,向后兼容(旧 runner 也能读)", () => {
    const sql = "CREATE TABLE t (a INT);\nINSERT INTO t SELECT 1;";
    const groups = buildSqlGroups(sql);
    expect(groups).toHaveLength(1);
    expect(groups[0].PropertyGroupId).toBe("bgp");
    expect(groups[0].PropertyMap.sql).toBe(sql);
  });

  it("🔴 长 SQL(>2048B)→ 自动分片,每片值都 ≤2048 字节(MSAF 硬约束)", () => {
    const big = "x".repeat(10000);
    const groups = buildSqlGroups(big);
    expect(groups.length).toBeGreaterThan(0);
    for (const g of groups) {
      expect(/^bgp\d*$/.test(g.PropertyGroupId)).toBe(true);
      expect(Object.keys(g.PropertyMap).length).toBeLessThanOrEqual(50); // 每组 ≤50 键
      for (const v of Object.values(g.PropertyMap)) expect(enc(v)).toBeLessThanOrEqual(2048); // 每值 ≤2048B
    }
  });

  it("🔴 编码→还原 无损往返(分片路径):任意长度 SQL 拼回 = 原文", () => {
    const big = Array.from({ length: 500 }, (_, i) => `CREATE TABLE t${i} (a INT);`).join("\n");
    expect(enc(big)).toBeGreaterThan(2048); // 确保走分片路径
    expect(reassembleSqlFromGroups(buildSqlGroups(big))).toBe(big);
  });

  it("编码→还原 无损往返(单值路径):短 SQL 拼回 = 原文", () => {
    const sql = "INSERT INTO t SELECT 1;";
    expect(reassembleSqlFromGroups(buildSqlGroups(sql))).toBe(sql);
  });

  it("🔴 无长度上限:极长 SQL(~200KB)片数溢出单组时滚动到 bgp1/bgp2/…,仍无损还原且不抛错", () => {
    // 用户红线:不能有 2048 上限,超过就完蛋。此测证明【任意长度都不失败】。
    const huge = "s".repeat(200_000);
    const groups = buildSqlGroups(huge);
    const gids = groups.map((g) => g.PropertyGroupId);
    expect(gids).toContain("bgp");
    expect(gids.some((g) => /^bgp[1-9]/.test(g))).toBe(true); // 确实滚动到了多组
    for (const g of groups) {
      expect(Object.keys(g.PropertyMap).length).toBeLessThanOrEqual(50);
      for (const v of Object.values(g.PropertyMap)) expect(enc(v)).toBeLessThanOrEqual(2048);
    }
    expect(reassembleSqlFromGroups(groups)).toBe(huge); // 无损
  });

  it("多字节 UTF-8(中文注释/标识符)不被切在字符中间,往返无损", () => {
    const zh = "CREATE TABLE 支付明细 (金额 DECIMAL);\n".repeat(200); // 含大量多字节字符且够长
    expect(enc(zh)).toBeGreaterThan(2048);
    const groups = buildSqlGroups(zh);
    for (const g of groups) for (const v of Object.values(g.PropertyMap)) expect(enc(v)).toBeLessThanOrEqual(2048);
    expect(reassembleSqlFromGroups(groups)).toBe(zh); // 未破坏多字节边界
  });

  it("reassemble 兼容乱序键与跨组:sql / sql.N 混合按序拼回", () => {
    // 模拟 MSAF describe 返回顺序不定 + 跨组
    const groups = [
      { PropertyGroupId: "bgp1", PropertyMap: { "sql.49": "E", "sql.48": "D" } },
      { PropertyGroupId: "bgp", PropertyMap: { "sql.1": "B", "sql.0": "A", "sql.2": "C" } },
    ];
    expect(reassembleSqlFromGroups(groups)).toBe("ABCDE");
  });

  it("reassemble 对无 bgp* 组返回 undefined(用于'MSAF 尚无 SQL'判断)", () => {
    expect(reassembleSqlFromGroups([{ PropertyGroupId: "other", PropertyMap: { x: "1" } }])).toBeUndefined();
    expect(reassembleSqlFromGroups([])).toBeUndefined();
    expect(reassembleSqlFromGroups(undefined)).toBeUndefined();
  });
});

describe("estimateKpu(资源规整回归保护)", () => {
  it("默认配置 = 1 运行 KPU + 1 协调 KPU = 2", () => {
    expect(estimateKpu()).toBe(2);
  });

  it("并行度随 parallelism/parallelismPerKPU 换算 + 1 协调", () => {
    // ceil(8/2) + 1 = 5
    expect(estimateKpu({ parallelism: 8, parallelismPerKPU: 2 })).toBe(5);
  });

  it("越界值被 clamp(parallelism 上限 64),不炸", () => {
    // ceil(64/1) + 1 = 65(parallelism clamp 到 64)
    expect(estimateKpu({ parallelism: 9999, parallelismPerKPU: 1 })).toBe(65);
  });
});

// ── 模块42 P42.6b:MSK/Kafka 源认证注入(§11.3)+ 裸占位符 guard 兼容(§11.4)──
describe("buildKafkaAuthProps(MSK 认证块展开·纯函数·§11.3)", () => {
  const BS = "b-1.demo.kafka:9098,b-2.demo.kafka:9098";

  it("IAM:SASL_SSL + AWS_MSK_IAM + IAMLoginModule/IAMClientCallbackHandler,无密钥", () => {
    const p = buildKafkaAuthProps("iam", BS);
    expect(p).toContain(`'properties.bootstrap.servers' = '${BS}'`);
    expect(p).toContain("'properties.security.protocol' = 'SASL_SSL'");
    expect(p).toContain("'properties.sasl.mechanism' = 'AWS_MSK_IAM'");
    expect(p).toContain("software.amazon.msk.auth.iam.IAMLoginModule required;");
    expect(p).toContain("software.amazon.msk.auth.iam.IAMClientCallbackHandler");
    // 🔴 IAM 无密钥:不得出现任何 username/password 字样
    expect(p).not.toContain("password");
    expect(p).not.toContain("username");
    // 前置逗号:接在 'format'='json' 行后合法
    expect(p.startsWith(",")).toBe(true);
  });

  it("SCRAM:SCRAM-SHA-512 + ScramLoginModule,账密内联(由调用方注入,函数本身不读 secret)", () => {
    const p = buildKafkaAuthProps("scram", BS, "myuser", "PLACEHOLDER_PW");
    expect(p).toContain("'properties.sasl.mechanism' = 'SCRAM-SHA-512'");
    expect(p).toContain("org.apache.kafka.common.security.scram.ScramLoginModule");
    expect(p).toContain('username="myuser"');
    expect(p).toContain('password="PLACEHOLDER_PW"');
    expect(p).not.toContain("AWS_MSK_IAM");
  });

  it("未知认证 → 回落 IAM(最宽默认,不静默产出坏 SQL)", () => {
    expect(buildKafkaAuthProps("weird", BS)).toContain("AWS_MSK_IAM");
  });

  it("🔴 传输加密不变量:任何认证输入恒产出 SASL_SSL,绝不 PLAINTEXT(安全审查 2026-07-27)", () => {
    // 对照 Apache 官网 mTLS 示例的核心安全诉求(data-in-transit 加密):我们两认证均走加密通道。
    // 穷举各种输入(含空/大小写/注入尝试),security.protocol 必恒为 SASL_SSL,永不退化明文。
    for (const a of ["iam", "scram", "IAM", "", "plaintext", "ssl", "weird", "sasl_plaintext"]) {
      const p = buildKafkaAuthProps(a, BS, "u", "p");
      expect(p).toContain("'properties.security.protocol' = 'SASL_SSL'");
      expect(p).not.toContain("PLAINTEXT");
      expect(p).not.toContain("'properties.security.protocol' = 'SSL'"); // 未启用 mTLS 裸 SSL 路径
    }
  });
});

describe("mskSourceSql + 认证注入 经 guard(§11.4 裸占位符兼容,stream 范式新情况)", () => {
  it("MSK 源模板经 guard('flink') 不被阻断(blocked=false)", () => {
    const g = guard("flink", mskSourceSql());
    expect(g.blocked).toBe(false);
  });

  it("🔴 裸占位符 ${KAFKA_AUTH_PROPS}/${KAFKA_TOPIC} 经 guardCode 原样保留(不被词法改写)", () => {
    const coded = guardCode("flink", mskSourceSql());
    expect(coded).toContain("${KAFKA_AUTH_PROPS}");
    expect(coded).toContain("${KAFKA_TOPIC}");
  });

  it("注入 IAM 认证块 + topic 后的 finalSql 仍经 guard 放行(启动前置校验不拦)", () => {
    const injected = mskSourceSql()
      .replace(/\$\{KAFKA_AUTH_PROPS\}/g, buildKafkaAuthProps("iam", "b-1.demo:9098"))
      .replace(/\$\{KAFKA_TOPIC\}/g, "orders")
      .replace(/\$\{OUTPUT_PATH\}/g, "s3://bucket/out/");
    const g = guard("flink", injected);
    expect(g.blocked).toBe(false);
    // connector=kafka 词法命中(供 resolveModules 拼 kafka 模块)
    expect(injected).toContain("'connector' = 'kafka'");
    expect(injected).toContain("AWS_MSK_IAM");
  });
});
