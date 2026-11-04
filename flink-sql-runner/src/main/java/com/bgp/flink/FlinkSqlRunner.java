package com.bgp.flink;

import com.amazonaws.services.kinesisanalytics.runtime.KinesisAnalyticsRuntime;
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment;
import org.apache.flink.table.api.StatementSet;
import org.apache.flink.table.api.bridge.java.StreamTableEnvironment;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.TreeMap;

/**
 * 通用 Flink SQL 流作业 runner(模块 32)。
 *
 * 平台把用户编写的多语句 Flink SQL 通过 MSAF 运行时属性(property group "bgp", key "sql")注入;
 * 本 runner 解析并执行:DDL/SET 即时执行,INSERT 收集进 StatementSet 一次提交(支持多 sink)。
 *
 * 不在 JAR 里硬编码任何账号/流名/桶名 —— 全部来自运行时属性 + SQL 文本(由平台按账号派生)。
 */
public class FlinkSqlRunner {
    public static void main(String[] args) throws Exception {
        StreamExecutionEnvironment env = StreamExecutionEnvironment.getExecutionEnvironment();
        StreamTableEnvironment tableEnv = StreamTableEnvironment.create(env);

        Map<String, Properties> appProps = KinesisAnalyticsRuntime.getApplicationProperties();
        String sql = assembleSql(appProps);
        if (sql.trim().isEmpty()) {
            throw new IllegalArgumentException("缺少运行时属性 bgp.sql(Flink SQL 脚本)");
        }

        StatementSet statementSet = tableEnv.createStatementSet();
        boolean hasInsert = false;
        for (String raw : splitStatements(sql)) {
            String stmt = raw.trim();
            if (stmt.isEmpty()) continue;
            String upper = stmt.toUpperCase();
            if (upper.startsWith("INSERT")) {
                statementSet.addInsertSql(stmt);
                hasInsert = true;
            } else {
                // CREATE TABLE / CREATE VIEW / SET 等即时执行
                tableEnv.executeSql(stmt);
            }
        }
        if (!hasInsert) {
            throw new IllegalArgumentException("SQL 脚本未包含 INSERT 语句(无 sink,流作业不会产出)");
        }
        // StatementSet.execute() 在 MSAF 上提交并长驻运行流作业。
        statementSet.execute();
    }

    /**
     * 还原平台注入的完整 SQL —— 兼容【单值】与【分片】两种编码:
     *  · 老格式:bgp 组的 "sql" 单值(SQL 规范化后 < 2048 字节时使用);
     *  · 分片格式:SQL 超过 MSAF 单 value 2048 字节上限时,平台按字节切片存为
     *    "sql.0","sql.1",... 并在片数超过单组 48 键时滚动到 bgp1/bgp2/... 组
     *    (MSAF 每组 ≤50 键、每 value ≤2048 字节;分片彻底移除 SQL 长度上限)。
     *  收集所有 bgp* 组里的 sql / sql.N,按 N 升序拼接("sql" 视作序号 -1 排最前),无损还原。
     */
    static String assembleSql(Map<String, Properties> appProps) {
        TreeMap<Integer, String> parts = new TreeMap<>();
        for (Map.Entry<String, Properties> e : appProps.entrySet()) {
            String gid = e.getKey();
            if (!gid.equals("bgp") && !gid.matches("bgp\\d+")) continue;
            for (String key : e.getValue().stringPropertyNames()) {
                if (key.equals("sql")) {
                    parts.put(-1, e.getValue().getProperty(key));
                } else if (key.startsWith("sql.")) {
                    try {
                        parts.put(Integer.parseInt(key.substring(4)), e.getValue().getProperty(key));
                    } catch (NumberFormatException ignore) { /* 非分片键,跳过 */ }
                }
            }
        }
        StringBuilder sb = new StringBuilder();
        for (String v : parts.values()) sb.append(v);
        return sb.toString();
    }

    /**
     * 按语句分隔符 ';' 切分多语句 SQL —— 但【先剥离注释、并忽略字符串/标识符内的分号】。
     *
     * 修复:朴素 sql.split(";") 会把【注释里】或【字符串/反引号字面量里】的分号当作语句分隔符。
     * 例如 CDC 默认模板首行注释 "-- 源:...直接读 binlog;需选 VPC..." 含一个分号,被切成"只剩
     * 注释"的碎片,executeSql 解析到 EOF 报 `Encountered "<EOF>"`。这里做一遍字符级扫描:
     *  · 跳过 `--` 行注释(到行尾)与 `/* *​/` 块注释;
     *  · 处于单引号字符串 / 反引号标识符内的 ';' 不算分隔符;
     *  · 🔴 串内【转义 '' / 反引号内 ``】不结束字面量(否则 'it''s;x' 会被误切);
     *  · 仅在"代码态"遇到 ';' 才切分,且只输出去空白后非空的语句片段。
     */
    static List<String> splitStatements(String sql) {
        List<String> out = new ArrayList<>();
        StringBuilder cur = new StringBuilder();
        int n = sql.length();
        boolean inSingle = false, inBacktick = false;
        for (int i = 0; i < n; i++) {
            char c = sql.charAt(i);
            char next = i + 1 < n ? sql.charAt(i + 1) : '\0';
            if (!inSingle && !inBacktick) {
                // 行注释 --... 到行尾(整段丢弃,不进入 cur)
                if (c == '-' && next == '-') {
                    int j = i + 2;
                    while (j < n && sql.charAt(j) != '\n') j++;
                    i = j; // 跳过换行交给循环递增;若到末尾则结束
                    if (i < n) cur.append('\n');
                    continue;
                }
                // 块注释 /* ... */
                if (c == '/' && next == '*') {
                    int j = i + 2;
                    while (j + 1 < n && !(sql.charAt(j) == '*' && sql.charAt(j + 1) == '/')) j++;
                    i = j + 1;
                    continue;
                }
            }
            // 单引号:串内 '' 转义(不结束串);反引号标识符内 `` 转义同理。
            if (c == '\'' && !inBacktick) {
                if (inSingle && next == '\'') { cur.append(c).append(next); i++; continue; }
                inSingle = !inSingle; cur.append(c); continue;
            }
            if (c == '`' && !inSingle) {
                if (inBacktick && next == '`') { cur.append(c).append(next); i++; continue; }
                inBacktick = !inBacktick; cur.append(c); continue;
            }
            if (c == ';' && !inSingle && !inBacktick) {
                out.add(cur.toString());
                cur.setLength(0);
                continue;
            }
            cur.append(c);
        }
        if (cur.toString().trim().length() > 0) out.add(cur.toString());
        return out;
    }
}
