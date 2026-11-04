// 模块 55 — 映射器吸收判据:路由既有「错误 ⇒ Response」映射器的产物变成 LongOpHttpError(状态 + 原信封),不认领 ⇒ 原样重抛。
import { describe, it, expect } from "vitest";
import { apiError } from "@/lib/api-response";
import { httpErrorFromMappers, rethrowAsHttpError } from "../http-error";
import { LongOpHttpError } from "../store";

class TargetCold extends Error {}
const coldMapper = (e: unknown) => (e instanceof TargetCold ? apiError(`执行环境 tgt_x 现在不能承接:${e.message}`, 409, { code: "CONFLICT", detail: { reason: "target-not-ready", targetId: "tgt_x" } }) : null);

describe("模块 55 http-error", () => {
  it("认领 ⇒ LongOpHttpError(status / message / code / detail / body = 映射器的原信封;cause = 原错误)", async () => {
    const cause = new TargetCold("冷启动中");
    const err = (await httpErrorFromMappers(cause, [coldMapper]))!;
    expect(err).toBeInstanceOf(LongOpHttpError);
    expect(err.status).toBe(409);
    expect(err.message).toBe("执行环境 tgt_x 现在不能承接:冷启动中");
    expect(err.code).toBe("CONFLICT");
    expect(err.detail).toEqual({ reason: "target-not-ready", targetId: "tgt_x" });
    expect(err.body).toEqual({ success: false, error: { message: "执行环境 tgt_x 现在不能承接:冷启动中", code: "CONFLICT", detail: { reason: "target-not-ready", targetId: "tgt_x" } } });
    expect(err.cause).toBe(cause);
  });

  it("不认领 ⇒ null;已是 LongOpHttpError ⇒ 原对象;rethrowAsHttpError 不认领时原样重抛同一对象", async () => {
    expect(await httpErrorFromMappers(new Error("别的"), [coldMapper])).toBeNull();
    const already = new LongOpHttpError(422, "x");
    expect(await httpErrorFromMappers(already, [coldMapper])).toBe(already);
    const plain = new Error("别的");
    await expect(rethrowAsHttpError(plain, [coldMapper])).rejects.toBe(plain);
    await expect(rethrowAsHttpError(new TargetCold("冷"), [coldMapper])).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
  });
});
