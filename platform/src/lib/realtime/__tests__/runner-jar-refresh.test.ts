/**
 * 执行区的 Flink runner / 模块 JAR 必须跟着主控区桶里的源对象**一起刷新**(2026-11-05 Flink 1.20.4 安全升级抓到的缺口)。
 *
 * 缺口原形:`ensureRunnerJar` 原来 HeadObject 命中即 return ⇒ 执行区副本在第一次复制之后永远不再刷新;
 *   `uberCacheKey` 只按(基础 key + 模块集合 + 用户连接器)算 ⇒ 升级脚本重传了模块 JAR,组合没变 ⇒ 缓存命中 ⇒ 永远拼旧包。
 *   两条路径都让「仓库里升了 Flink、主控区桶也传了新包」在执行区一个字节都不生效。
 *
 * 只 mock 真外部(S3 客户端工厂 / DynamoDB 文档客户端);被测函数真跑。判据钉事实:复制与否、复制了什么、key 变不变。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import AdmZip from "adm-zip";

type Head = { Metadata?: Record<string, string>; ContentLength?: number; ETag?: string };
/** 一个假 S3:对象表按 `bucket/key` 存 head(可带 body);记录 CopyObject / PutObject。 */
class FakeS3 {
  objects = new Map<string, Head & { body?: Buffer }>();
  copies: Array<{ Bucket: string; Key: string; CopySource: string }> = [];
  puts: Array<{ Bucket: string; Key: string }> = [];
  constructor(public region: string) {}
  async send(cmd: { constructor: { name: string }; input: Record<string, string> }) {
    const name = cmd.constructor.name;
    const id = `${cmd.input.Bucket}/${cmd.input.Key}`;
    if (name === "HeadObjectCommand") {
      const o = this.objects.get(id);
      if (!o) throw Object.assign(new Error("NotFound"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });
      return { Metadata: o.Metadata, ContentLength: o.ContentLength, ETag: o.ETag };
    }
    if (name === "CopyObjectCommand") {
      this.copies.push({ Bucket: cmd.input.Bucket, Key: cmd.input.Key, CopySource: cmd.input.CopySource });
      const src = SOURCES.get(cmd.input.CopySource);
      if (!src) throw new Error(`fake copy: source ${cmd.input.CopySource} missing`);
      this.objects.set(id, { ...src }); // 默认 MetadataDirective=COPY ⇒ metadata 跟着走
      return {};
    }
    if (name === "GetObjectCommand") {
      const o = this.objects.get(id);
      if (!o?.body) throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
      const body = o.body;
      return { Body: { transformToByteArray: async () => new Uint8Array(body) } };
    }
    if (name === "PutObjectCommand") {
      this.puts.push({ Bucket: cmd.input.Bucket, Key: cmd.input.Key });
      this.objects.set(id, { ContentLength: 1 });
      return {};
    }
    throw new Error(`fake s3: unexpected ${name}`);
  }
}
/** 跨区复制的源表(home 桶的对象),两个假客户端共用 */
const SOURCES = new Map<string, Head & { body?: Buffer }>();
const HOME = new FakeS3("us-east-1");
const USW2 = new FakeS3("us-west-2");

vi.mock("@/lib/exec-env/target-clients", () => ({
  s3ClientFor: async (region: string) => (region === "us-east-1" ? HOME : USW2),
  kdaClientFor: async () => ({}),
  logsClientFor: async () => ({}),
  cloudWatchClientFor: async () => ({}),
  secretsClientFor: async () => ({}),
  resolveTargetFlink: async () => { throw new Error("not used"); },
}));
vi.mock("@/lib/aws/clients", () => ({ sdkClient: () => HOME }));
vi.mock("@/lib/aws/dynamodb", () => ({ docClient: { send: async () => ({}) }, TABLES: { FLINK_CONNECTORS: "t" } }));

process.env.AWS_REGION = "us-east-1";
process.env.KF_HOME_REGION = "us-east-1";
process.env.FLINK_CODE_BUCKET = "home-bucket";

const place = {
  targetId: "tgt_usw2_a", region: "us-west-2", account: "acct", roleArn: "r", codeBucket: "usw2-bucket",
  outputBucket: "o", s3tablesBucket: "t", subnetIds: [], securityGroupIds: [], logGroup: "l",
} as unknown as import("../flink-place").FlinkPlace;

function reset() {
  HOME.objects.clear(); USW2.objects.clear(); HOME.copies = []; USW2.copies = []; HOME.puts = []; USW2.puts = []; SOURCES.clear();
}
function homeObject(key: string, head: Head) {
  HOME.objects.set(`home-bucket/${key}`, head); SOURCES.set(`home-bucket/${key}`, head);
}

describe("ensureRunnerJar — 执行区副本按源对象身份刷新(不再「有就跳过」)", () => {
  beforeEach(reset);
  const KEY = "flink/flink-sql-runner.jar";

  it("执行区没有副本 ⇒ 从主控区复制一份(与以前一致)", async () => {
    homeObject(KEY, { Metadata: { sha256: "aaa" }, ContentLength: 10 });
    const { ensureRunnerJar } = await import("../flink-place");
    await ensureRunnerJar(place, KEY);
    expect(USW2.copies).toEqual([{ Bucket: "usw2-bucket", Key: KEY, CopySource: `home-bucket/${KEY}` }]);
    expect(USW2.objects.get(`usw2-bucket/${KEY}`)?.Metadata?.sha256).toBe("aaa"); // metadata 跟着 copy 走
  });

  it("副本与源同一 sha256 ⇒ 不复制(幂等,启动不多付一次跨区复制)", async () => {
    homeObject(KEY, { Metadata: { sha256: "aaa" }, ContentLength: 10 });
    USW2.objects.set(`usw2-bucket/${KEY}`, { Metadata: { sha256: "aaa" }, ContentLength: 10 });
    const { ensureRunnerJar } = await import("../flink-place");
    await ensureRunnerJar(place, KEY);
    expect(USW2.copies).toEqual([]);
  });

  it("🔴 主控区升了 JAR(sha256 变)⇒ 执行区副本被重新复制 —— 这就是升级能到执行区的那一步", async () => {
    homeObject(KEY, { Metadata: { sha256: "bbb-1.20.4" }, ContentLength: 12 });
    USW2.objects.set(`usw2-bucket/${KEY}`, { Metadata: { sha256: "aaa-1.20.0" }, ContentLength: 10 });
    const { ensureRunnerJar } = await import("../flink-place");
    await ensureRunnerJar(place, KEY);
    expect(USW2.copies.length).toBe(1);
    expect(USW2.objects.get(`usw2-bucket/${KEY}`)?.Metadata?.sha256).toBe("bbb-1.20.4");
  });

  it("老对象(两边都没有 metadata)⇒ 长度相同不复制、长度不同复制(升级脚本第一次重传后就带 metadata 了)", async () => {
    homeObject(KEY, { ContentLength: 10 });
    USW2.objects.set(`usw2-bucket/${KEY}`, { ContentLength: 10 });
    const { ensureRunnerJar } = await import("../flink-place");
    await ensureRunnerJar(place, KEY);
    expect(USW2.copies).toEqual([]);
    reset();
    homeObject(KEY, { ContentLength: 11 });
    USW2.objects.set(`usw2-bucket/${KEY}`, { ContentLength: 10 });
    await ensureRunnerJar(place, KEY);
    expect(USW2.copies.length).toBe(1);
  });

  it("源有 metadata、副本是老对象 ⇒ 身份不同 ⇒ 复制一次,之后副本带上 metadata 不再复制", async () => {
    homeObject(KEY, { Metadata: { sha256: "ccc" }, ContentLength: 10 });
    USW2.objects.set(`usw2-bucket/${KEY}`, { ContentLength: 10 });
    const { ensureRunnerJar } = await import("../flink-place");
    await ensureRunnerJar(place, KEY);
    expect(USW2.copies.length).toBe(1);
    await ensureRunnerJar(place, KEY);
    expect(USW2.copies.length).toBe(1);
  });

  it("🔴 主控区桶里没有源对象 ⇒ 抛且点名桶 / key(不许带着缺失的 JAR 启动)", async () => {
    const { ensureRunnerJar } = await import("../flink-place");
    await expect(ensureRunnerJar(place, KEY)).rejects.toThrow(/home-bucket\/flink\/flink-sql-runner\.jar/);
    expect(USW2.copies).toEqual([]);
  });

  it("本区代码桶就是源桶(主控区)⇒ 一次 S3 调用都不发", async () => {
    const { ensureRunnerJar } = await import("../flink-place");
    const spy = vi.spyOn(HOME, "send");
    await ensureRunnerJar({ ...place, region: "us-east-1", codeBucket: "home-bucket" } as typeof place, KEY);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("runnerJarIdentity:sha256 优先、老对象退到长度、读不到为 null", async () => {
    const { runnerJarIdentity } = await import("../flink-place");
    expect(runnerJarIdentity({ Metadata: { sha256: "x" }, ContentLength: 3 })).toBe("sha256:x");
    expect(runnerJarIdentity({ ContentLength: 3 })).toBe("len:3");
    expect(runnerJarIdentity(null)).toBeNull();
  });
});

describe("uberCacheKey / assembleModularUberJar — 源对象身份折进缓存 key(模块升级 ⇒ 缓存失效 ⇒ 重新拼装)", () => {
  beforeEach(reset);
  function jar(entries: Record<string, string>): Buffer {
    const z = new AdmZip();
    for (const [n, c] of Object.entries(entries)) z.addFile(n, Buffer.from(c, "utf8"));
    return z.toBuffer();
  }
  const SQL = `CREATE TABLE src (a INT) WITH ('connector'='kinesis','format'='json'); INSERT INTO out SELECT a FROM src;`;
  function seedHome(sha: string) {
    homeObject("flink/modules/flink-module-base.jar", { Metadata: { sha256: `base-${sha}` }, ContentLength: 1, body: jar({ "a/Base.class": "b" }) });
    homeObject("flink/modules/flink-module-kinesis.jar", { Metadata: { sha256: `kinesis-${sha}` }, ContentLength: 1, body: jar({ "a/Kinesis.class": "k" }) });
    homeObject("flink/modules/flink-module-json.jar", { Metadata: { sha256: `json-${sha}` }, ContentLength: 1, body: jar({ "a/Json.class": "j" }) });
  }

  it("uberCacheKey:同组合 + 同身份 ⇒ 同 key;身份变 ⇒ key 变;身份顺序由调用方(模块有序)决定", async () => {
    const { uberCacheKey } = await import("../flink-connectors");
    const a = uberCacheKey("base", ["json", "kinesis"], [], ["sha256:1", "sha256:2", "sha256:3"]);
    const b = uberCacheKey("base", ["json", "kinesis"], [], ["sha256:1", "sha256:2", "sha256:3"]);
    const c = uberCacheKey("base", ["json", "kinesis"], [], ["sha256:1", "sha256:2", "sha256:NEW"]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(uberCacheKey("base", ["json", "kinesis"], [])); // 不带身份 = 旧 key 空间,不与新 key 混用
  });

  it("🔴 首次拼装写进作业所在区的桶;同身份第二次命中缓存零重建;升级脚本重传模块(身份变)⇒ 新 key ⇒ 重新拼装", async () => {
    seedHome("v1");
    const { assembleModularUberJar } = await import("../flink-connectors");
    const r1 = await assembleModularUberJar(SQL, [], { region: "us-west-2", codeBucket: "usw2-bucket" });
    expect(r1.cached).toBe(false);
    expect(USW2.puts.map((p) => p.Key)).toEqual([r1.key]);
    const r2 = await assembleModularUberJar(SQL, [], { region: "us-west-2", codeBucket: "usw2-bucket" });
    expect(r2.cached).toBe(true);
    expect(r2.key).toBe(r1.key);
    expect(USW2.puts.length).toBe(1);
    seedHome("v2-1.20.4"); // 升级:三个源对象的 metadata sha256 都变了,key / 组合没变
    const r3 = await assembleModularUberJar(SQL, [], { region: "us-west-2", codeBucket: "usw2-bucket" });
    expect(r3.cached).toBe(false);
    expect(r3.key).not.toBe(r1.key);
    expect(USW2.puts.length).toBe(2);
  });

  it("源对象没有 metadata(用户上传的连接器)⇒ 用 ETag 当身份;ETag 变同样失效", async () => {
    seedHome("v1");
    HOME.objects.set("home-bucket/flink/connectors/u.jar", { ETag: '"e1"', ContentLength: 1, body: jar({ "u/U.class": "u" }) });
    const { assembleModularUberJar } = await import("../flink-connectors");
    const r1 = await assembleModularUberJar(SQL, ["flink/connectors/u.jar"], { region: "us-west-2", codeBucket: "usw2-bucket" });
    HOME.objects.set("home-bucket/flink/connectors/u.jar", { ETag: '"e2"', ContentLength: 1, body: jar({ "u/U.class": "u2" }) });
    const r2 = await assembleModularUberJar(SQL, ["flink/connectors/u.jar"], { region: "us-west-2", codeBucket: "usw2-bucket" });
    expect(r2.key).not.toBe(r1.key);
    expect(r2.cached).toBe(false);
  });
});
