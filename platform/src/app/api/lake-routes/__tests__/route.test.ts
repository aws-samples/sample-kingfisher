// 数据湖只读路径(2026-11-09):页面读「路由集 / 表桶候选」不再走 /api/admin/**。
//   事实:网关中间件对 /api/admin/** 不分读写一律要求 bgp-admin;而两条读接口的作者意图是「任何登录用户可读」,
//   数据开发账号在同步向导 / 作业高级属性里拿到的就是 403 ⇒ 下拉报错为空。
//   修法 = 只读路径 GET /api/lake-routes · GET /api/lake-buckets/candidates(同一处理器),管理面旧路径保留为再导出别名一版。
//   处理器行为(路由集形态 / 非管理员可读 / 401 / 400)由 app/api/admin/lake-routes/__tests__/route.test.ts 经同一函数钉住;
//   这里钉:① 别名恒等(同一函数引用)② 新路径只读 + 落点点名 ③ 页面读调用点都在新路径上、不留 /api/admin 读点 ④ 网关规则一字未动(不许用「单放两条 GET」替代)。
import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("@/lib/auth/identity", () => ({ resolveIdentity: vi.fn(async () => null) }));

import * as routes from "../route";
import * as routesAdmin from "@/app/api/admin/lake-routes/route";
import * as candidates from "@/app/api/lake-buckets/candidates/route";
import * as candidatesAdmin from "@/app/api/admin/lake-buckets/candidates/route";

const SRC = resolve(__dirname, "../../../..");
const read = (f: string) => readFileSync(resolve(SRC, f), "utf8");

describe("① 管理面旧路径 = 只读路径的别名(同一函数引用,不是复制一份)", () => {
  it("GET /api/admin/lake-routes 与 GET /api/lake-routes 同一函数;候选清单同理;别名文件不另写实现", () => {
    expect(routesAdmin.GET).toBe(routes.GET);
    expect(candidatesAdmin.GET).toBe(candidates.GET);
    expect(read("app/api/admin/lake-buckets/candidates/route.ts")).toContain('export { dynamic, GET } from "@/app/api/lake-buckets/candidates/route";');
    expect(read("app/api/admin/lake-routes/route.ts")).toContain('export { GET } from "@/app/api/lake-routes/route";');
    expect(read("app/api/admin/lake-routes/route.ts")).not.toContain("handleListRoutes");
  });
});

describe("② 只读路径只有 GET;落点经点名作者,缺 ⇒ 400、未登录 ⇒ 401", () => {
  it("两条新路径不导出任何写方法(写只在管理面)", () => {
    for (const m of [routes, candidates] as Record<string, unknown>[]) {
      expect(Object.keys(m).sort()).toEqual(["GET", "dynamic"]);
      expect(m.dynamic).toBe("force-dynamic");
    }
  });
  it("缺 targetId ⇒ 400(不默认主控区);有落点但未登录 ⇒ 401(处理器自己也核登录,不只靠网关)", async () => {
    expect((await routes.GET(new NextRequest("http://x/api/lake-routes"))).status).toBe(400);
    expect((await routes.GET(new NextRequest("http://x/api/lake-routes?targetId=tgt_home"))).status).toBe(401);
    expect((await candidates.GET(new NextRequest("http://x/api/lake-buckets/candidates"))).status).toBe(401);
    expect((await candidates.GET(new NextRequest("http://x/api/lake-buckets/candidates?targetId=tgt_home"))).status).toBe(401);
    for (const f of ["app/api/lake-routes/route.ts", "app/api/lake-buckets/candidates/route.ts"]) {
      expect(read(f), f).toMatch(/requestedTargetId\(req\.nextUrl\.searchParams\.get\("targetId"\)/);
    }
  });
});

describe("③ 页面读调用点全在只读路径上;/api/admin 之下不再有读点", () => {
  it("三个数据湖组件的 GET 读 = /api/lake-routes 或 /api/lake-buckets/candidates;写(POST / PATCH / DELETE)仍在 /api/admin/lake-routes", () => {
    const card = read("components/lake/LakeRoutesCard.tsx");
    const block = read("components/lake/JobLakeBucketsBlock.tsx");
    const picker = read("components/lake/TableBucketPicker.tsx");
    expect(card).toContain("fetch(`/api/lake-routes?targetId=${encodeURIComponent(targetId)}`)");
    expect(block).toContain("fetch(`/api/lake-routes?targetId=${encodeURIComponent(targetId)}`)");
    expect(picker).toContain("fetch(`/api/lake-buckets/candidates?targetId=${encodeURIComponent(targetId)}`)");
    // 读点形态 fetch(`/api/admin/lake-…?targetId=…`) 一个不留(写点是 fetch("/api/admin/lake-routes", { method }) / deleteJson,不在此形态内)
    for (const [f, s] of [["LakeRoutesCard.tsx", card], ["JobLakeBucketsBlock.tsx", block], ["TableBucketPicker.tsx", picker]] as const) {
      expect(s, f).not.toMatch(/fetch\(`\/api\/admin\/lake-[a-z-]+(?:\/[a-z-]+)*\?targetId=/);
    }
    expect(card).toContain('fetch("/api/admin/lake-routes", {');
    expect(card).toContain("deleteJson(`/api/admin/lake-routes?targetId=");
  });
});

describe("④ 网关对 /api/admin/** 的管理员门一字未动(修法是挪读点,不是给两条 GET 开洞)", () => {
  it("middleware.ts 仍对 /api/admin 前缀任何方法要求 bgp-admin,且没有按路径放行 lake-*", () => {
    const mw = read("middleware.ts");
    expect(mw).toContain('if (pathname.startsWith("/api/admin") && !groups.includes("bgp-admin")) return forbidden(cid);');
    expect(mw).not.toMatch(/lake-routes|lake-buckets/);
  });
});
