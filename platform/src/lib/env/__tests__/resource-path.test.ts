// @kf-batch 50-SEQ47a-promote-ux —— 资源类型 → 页面路径(闭合清单,少一个 tsc 就红;这里钉值)。
import { describe, it, expect } from "vitest";
import { resourcePath } from "../resource-path";

describe("resourcePath", () => {
  it("详情型资源带 id,列表型资源回列表页;id 做 URL 编码", () => {
    expect(resourcePath("workflow", "wf 1")).toBe("/workflow/wf%201");
    expect(resourcePath("sync", "t/1")).toBe("/sync/t%2F1");
    expect(resourcePath("etl-job", "j1")).toBe("/etl-jobs");
    expect(resourcePath("engine-job", "e1")).toBe("/etl-jobs");
    expect(resourcePath("redshift-task", "r1")).toBe("/redshift");
  });
});
