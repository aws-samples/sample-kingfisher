// 同步运行的行数指标**从作业日志的机器可读标记取真值**(单一作者,纯函数)。
//
// 脚本(glue-script-generator.ts)按表打印三类标记:
//   · ROWS_READ table=<源表> rows=N                                  —— 本次从源读到的行数(每张表一条)
//   · REDSHIFT_ROWS_WRITTEN table=<schema.table> rows=N              —— 写进 Redshift 的行数(每张表一条)
//   · SYNC_VERIFY target=(s3tables|redshift) table=<表> scope=<table|partitions|merge> source_rows=N target_rows=M
//                                                                     —— 覆盖 / 合并写后对数(每个目标每张表一条)
// rowsWritten 的取法(按优先级):
//   ① 有 REDSHIFT_ROWS_WRITTEN ⇒ 照旧:各表之和(写 Redshift 的任务,含 both);
//   ② 否则有 s3tables 的 SYNC_VERIFY ⇒ 各表 target_rows 之和(S3 覆盖 / 合并:写后目标里本批对应的行数,是真值);
//   ③ 都没有且运行成功 ⇒ 维持 rowsRead 兜底。🔴 这个兜底是**对的**而不是偷懒:纯 append 的 S3 路径是
//      `INSERT INTO … SELECT * FROM <整份 df>` —— 读到多少就写进多少(没有过滤、没有去重、没有对数),写入行数在定义上
//      等于读到的行数;要是写失败,状态不是 succeeded,也不会走到这里。
// 原来 ② 不存在:S3 目标一律抄 rowsRead,于是 merge 任务读 2 行 upsert 后监控页写「写入 2」而实际目标多了 1 行、
// 覆盖任务 target_rows 与 source_rows 对不上时也看不出来 —— 监控数字必须来自写入侧。

export interface SyncRunMetrics {
  rowsRead: number;
  rowsWritten: number;
}

const READ_RE = /ROWS_READ\s+table=\S+\s+rows=(\d+)/g;
const RS_WRITE_RE = /REDSHIFT_ROWS_WRITTEN\s+table=\S+\s+rows=(\d+)/g;
const VERIFY_RE = /SYNC_VERIFY\s+target=(s3tables|redshift)\s+table=\S+\s+scope=\S+\s+source_rows=(\d+)\s+target_rows=(\d+)/g;

function sumAll(re: RegExp, text: string, group: number): { sum: number; seen: boolean } {
  re.lastIndex = 0;
  let sum = 0;
  let seen = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    sum += parseInt(m[group], 10) || 0;
    seen = true;
  }
  return { sum, seen };
}

/** 从一次运行的全部日志行解析行数指标。`status` = 运行终态(只有 succeeded 才允许 ③ 的兜底)。 */
export function parseSyncRunMetrics(logs: readonly string[], status: string): SyncRunMetrics {
  const joined = logs.join("\n");
  const rowsRead = sumAll(READ_RE, joined, 1).sum;
  const rs = sumAll(RS_WRITE_RE, joined, 1);
  if (rs.seen) return { rowsRead, rowsWritten: rs.sum };
  // 只取 s3tables 的 SYNC_VERIFY(redshift 的已由 REDSHIFT_ROWS_WRITTEN 覆盖;两者并存时上面已经返回)
  VERIFY_RE.lastIndex = 0;
  let s3Sum = 0;
  let s3Seen = false;
  let vm: RegExpExecArray | null;
  while ((vm = VERIFY_RE.exec(joined)) !== null) {
    if (vm[1] !== "s3tables") continue;
    s3Sum += parseInt(vm[3], 10) || 0;
    s3Seen = true;
  }
  if (s3Seen) return { rowsRead, rowsWritten: s3Sum };
  return { rowsRead, rowsWritten: status === "succeeded" ? rowsRead : 0 };
}
