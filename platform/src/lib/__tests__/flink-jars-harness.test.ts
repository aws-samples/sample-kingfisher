/**
 * `scripts/lib/flink-jars.sh` 的离线替身必须**真的在门禁里跑**(「写了」≠「接上了」)。
 *
 * 🔴 为什么:Flink 运行器 / 连接器模块 JAR 只在安装 / 升级时同步一次,跑错的后果是「仓库里升了 Flink、现网 MSAF 还跑旧包」
 *   (2026-11-05 Flink 1.20.4 安全升级时抓到:安装脚本「桶里有就跳过」、升级脚本根本不碰 JAR)。真桶上没法反复排练。
 *   scripts/lib 下被 source 的作者也是登记表 infra/prod-only-layers.json 意义上的「层」(发现规则按 git 跟踪的 scripts/**;文件未 git add 时发现不到 ⇒ 别被假绿骗),
 *   登记项指向替身 infra/test/flink-jars/test_flink_jars.sh,这里负责把它真跑进门禁。
 *   这里 spawn 真 bash 跑替身:假 aws(目录当桶、.meta 当 metadata)/ 假 mvn 真跑函数,零凭证、不联网;逐条点名它必须覆盖的事实。
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const REPO = resolve(__dirname, "..", "..", "..", "..");

describe("flink-jars.sh 离线替身(首装 / 幂等 / 老对象 / 哈希不同 / 源更新重建 / 缺 mvn / 上传失败 / 接线 / 单一事实源)", () => {
  it("🔴 替身全过,且真的跑了每一组判据", () => {
    const r = spawnSync("bash", ["infra/test/flink-jars/test_flink_jars.sh"], { cwd: REPO, encoding: "utf8" });
    const all = `${r.stdout || ""}${r.stderr || ""}`;
    expect(r.status, all.slice(-2000)).toBe(0);
    expect(all).toContain("✅ flink-jars 离线判据全过");
    for (const needle of [
      "① mvn 调用次数(5)",
      "① 上传次数(5)",
      "① metadata sha256 = 本地 jar 的 sha256",
      "① 父 pom 目录不被当成模块",
      "② 上传次数(0)",
      "② 「unchanged」行数(5)",
      "③ 重传的是无 metadata 的那个",
      "④ 重传的是 sha 不同的那个",
      "⑤ mvn 只重建过期的那一个(1)",
      "⑤ 桶里是新内容(rebuilt-1.20.4)",
      "⑥ 退出码仍为 0(不中止安装)(0)",
      "⑥ 桶里的旧对象还在(old)",
      "⑦ 「upload failed」行数 = 5(每个都试了,都继续)(5)",
      "⑧ deploy-all 旧跳过循环已删",
      "⑧ redeploy-platform 调用",
      "⑨ 清单有 flink/flink-sql-runner-s3t-kafka.jar",
    ]) {
      expect(all, `替身少跑了这条:${needle}`).toContain(`✅ ${needle}`);
    }
    expect(all).not.toContain("❌");
  }, 60_000);
});
