// 「发版号可读」的判据。
//   两轮冷启动演练都把「现网是哪个版本」列为新手第一缺口(AGENTS §9 此前只能靠部署记录推断)。
//   钉的事实:① 运行时只读环境变量、取不到就 known=false(不编造);② 一行标识 tag 优先、只有提交 ⇒ 未发版;
//   ③ 🔴 键名三处逐字一致 —— infra 的 build-arg 作者 ↔ Dockerfile ARG / ENV ↔ platform 的读取作者(跨包无法 import,
//      只能靠守卫;任一处改名另两处不改 ⇒ 页面永远「构建信息不可用」而没有任何报错);
//   ④ 接缝有调用点:平台镜像 fromAsset 真带 buildArgs、路由真调 readBuildInfo、登录页与系统设置页真渲染载体;
//   ⑤ 路由真跑:GET /api/public/version 回标准信封。真环境那一半(页脚 / 卡片 DOM 读到 tag 或提交)由页面驱动段盯。
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { readBuildInfo, buildLabelParts, BUILD_INFO_ENV_KEYS } from "@/lib/build-info";

const PLATFORM = process.cwd();
const REPO = path.resolve(PLATFORM, "..");
const read = (abs: string) => fs.readFileSync(abs, "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const KEYS = Object.values(BUILD_INFO_ENV_KEYS);

describe("🔴 发版号可读:读取作者", () => {
  it("四个变量齐 ⇒ known,各字段原样;空串 / 缺失 ⇒ null;两者都没 ⇒ known=false(不编造)", () => {
    const full = readBuildInfo({
      BGP_BUILD_RELEASE_TAG: "release-2026-10-13-b103",
      BGP_BUILD_PRODUCT_COMMIT: "1ec5deb",
      BGP_BUILD_PRODUCT_COMMIT_AT: "2026-10-21T04:30:00+00:00",
      BGP_BUILD_VERSION: "2.0.0",
    });
    expect(full).toEqual({
      known: true,
      releaseTag: "release-2026-10-13-b103",
      productCommit: "1ec5deb",
      productCommitAt: "2026-10-21T04:30:00+00:00",
      version: "2.0.0",
    });
    const unreleased = readBuildInfo({ BGP_BUILD_RELEASE_TAG: "", BGP_BUILD_PRODUCT_COMMIT: " 1ec5deb ", BGP_BUILD_VERSION: "2.0.0" });
    expect(unreleased.known).toBe(true);
    expect(unreleased.releaseTag).toBeNull();
    expect(unreleased.productCommit).toBe("1ec5deb");
    expect(unreleased.productCommitAt).toBeNull();
    const none = readBuildInfo({});
    expect(none).toEqual({ known: false, releaseTag: null, productCommit: null, productCommitAt: null, version: null });
  });

  it("一行标识:有 tag ⇒ tag 为主且不是未发版;只有提交 ⇒ 提交为主 + 未发版;都没有 ⇒ primary=null", () => {
    expect(buildLabelParts(readBuildInfo({ BGP_BUILD_RELEASE_TAG: "release-2026-10-13", BGP_BUILD_PRODUCT_COMMIT: "abc1234" }))).toEqual({
      primary: "release-2026-10-13",
      unreleased: false,
    });
    expect(buildLabelParts(readBuildInfo({ BGP_BUILD_PRODUCT_COMMIT: "abc1234" }))).toEqual({ primary: "abc1234", unreleased: true });
    expect(buildLabelParts(readBuildInfo({}))).toEqual({ primary: null, unreleased: false });
  });
});

describe("🔴🔴 键名三处逐字一致(infra 作者 ↔ Dockerfile ↔ platform 作者)", () => {
  it("infra/lib/shared/build-info.ts 的 BUILD_ARG_KEYS 值集合 == platform BUILD_INFO_ENV_KEYS 值集合", () => {
    const infraSrc = strip(read(path.join(REPO, "infra/lib/shared/build-info.ts")));
    const block = infraSrc.slice(infraSrc.indexOf("export const BUILD_ARG_KEYS"), infraSrc.indexOf("as const;"));
    const infraKeys = Array.from(block.matchAll(/"(BGP_BUILD_[A-Z_]+)"/g)).map((m) => m[1]).sort();
    expect(infraKeys).toEqual([...KEYS].sort());
    expect(infraKeys.length).toBe(4);
  });

  it("Dockerfile runner 段:每个键都有 ARG <键>=\"\" 且 ENV 把同名 ARG 传进容器;builder 段不碰(缓存不受版本标签影响)", () => {
    const docker = read(path.join(PLATFORM, "Dockerfile"));
    const runnerAt = docker.indexOf("AS runner");
    expect(runnerAt).toBeGreaterThan(0);
    const runner = docker.slice(runnerAt);
    const builder = docker.slice(0, runnerAt);
    for (const key of KEYS) {
      expect(runner, `runner 段缺 ARG ${key}`).toMatch(new RegExp(`^ARG ${key}=""$`, "m"));
      expect(runner, `runner 段 ENV 没把 ${key} 传进容器`).toMatch(new RegExp(`^ENV .*\\b${key}=\\$${key}\\b`, "m"));
      expect(builder, `builder 段不许出现 ${key}(会让构建缓存随版本标签失效)`).not.toContain(key);
    }
  });
});

describe("🔴 接缝有调用点", () => {
  it("平台镜像 fromAsset 真带 buildArgs: platformImageBuildArgs()(infra 作者的唯一调用点),且 import 自 shared/build-info", () => {
    const stack = strip(read(path.join(REPO, "infra/lib/platform-stack.ts")));
    expect(stack).toContain('ecs.ContainerImage.fromAsset("../platform", { buildArgs: platformImageBuildArgs() })');
    expect(stack).toMatch(/import \{ platformImageBuildArgs \} from "\.\/shared\/build-info";/);
    // 旧的裸 fromAsset 不留
    expect(stack).not.toMatch(/fromAsset\("\.\.\/platform"\)/);
  });

  it("路由 /api/public/version 调 readBuildInfo;登录页 useBuildInfo + <BuildLabel>;系统设置页 <BuildInfoCard>;载体只 fetch 公开路由", () => {
    const route = strip(read(path.join(PLATFORM, "src/app/api/public/version/route.ts")));
    expect(route).toContain("apiOk(readBuildInfo())");
    const login = strip(read(path.join(PLATFORM, "src/app/login/page.tsx")));
    expect(login).toContain("const buildInfo = useBuildInfo();");
    expect(login).toContain("<BuildLabel info={buildInfo} />");
    const settings = strip(read(path.join(PLATFORM, "src/app/settings/page.tsx")));
    expect(settings).toContain("<BuildInfoCard");
    const carrier = strip(read(path.join(PLATFORM, "src/components/common/BuildInfo.tsx")));
    expect(carrier).toContain('fetch("/api/public/version")');
    expect(carrier).toContain('data-testid="build-label"');
    expect(carrier).toContain("buildLabelParts(info)");
  });
});

describe("🔴 路由真跑", () => {
  const saved: Record<string, string | undefined> = {};
  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("GET /api/public/version ⇒ 200 标准信封,data = 环境里的构建事实;变量缺失 ⇒ known=false 而不是 500", async () => {
    for (const key of KEYS) saved[key] = process.env[key];
    process.env.BGP_BUILD_RELEASE_TAG = "release-2026-10-13-b103";
    process.env.BGP_BUILD_PRODUCT_COMMIT = "ea055fd";
    process.env.BGP_BUILD_PRODUCT_COMMIT_AT = "2026-10-21T00:30:00+00:00";
    process.env.BGP_BUILD_VERSION = "2.0.0";
    const { GET } = await import("@/app/api/public/version/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toEqual({
      known: true,
      releaseTag: "release-2026-10-13-b103",
      productCommit: "ea055fd",
      productCommitAt: "2026-10-21T00:30:00+00:00",
      version: "2.0.0",
    });
    for (const key of KEYS) delete process.env[key];
    const res2 = await GET();
    expect(res2.status).toBe(200);
    expect((await res2.json()).data.known).toBe(false);
  });
});

describe("🔴 产品包的构建事实文件:打包器写的目录与 infra 作者的 PRODUCT_DIRS 同一口径", () => {
  it("scripts/package-release.sh 计算产品提交用的目录列表 == infra/lib/shared/build-info.ts 的 PRODUCT_DIRS;文件名两侧一致", () => {
    const infraSrc = strip(read(path.join(REPO, "infra/lib/shared/build-info.ts")));
    const dirs = /PRODUCT_DIRS: readonly string\[\] = \[([^\]]+)\]/.exec(infraSrc);
    expect(dirs, "infra 作者里找不到 PRODUCT_DIRS 字面量").not.toBeNull();
    const list = (dirs as RegExpExecArray)[1].split(",").map((d) => d.trim().replace(/^"|"$/g, ""));
    const packager = read(path.join(REPO, "scripts/package-release.sh"));
    expect(packager).toContain(`--format=%h "$COMMIT" -- ${list.join(" ")}`);
    expect(packager).toContain(`--format=%cI "$COMMIT" -- ${list.join(" ")}`);
    const file = /BUILD_FACTS_FILE = "([^"]+)"/.exec(infraSrc);
    expect(file).not.toBeNull();
    expect(packager).toContain(`/${(file as RegExpExecArray)[1]}"`);
  });
});
