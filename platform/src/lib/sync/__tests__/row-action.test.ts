// 行上「启动 / 停止」判别 + 状态文案 + 接线(列表与详情页都用唯一作者,不再各写 `status === "running"`)。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { syncTaskCanStop, syncToggleAction, SYNC_STATUS_META, SYNC_STOPPABLE_STATUSES } from "@/lib/sync/row-action";

const SRC = resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(resolve(SRC, rel), "utf8");

describe("syncTaskCanStop / syncToggleAction", () => {
  it("running 与 provisioning 都可停(原形:DMS 启动后那几分钟没有停止入口)", () => {
    expect(SYNC_STOPPABLE_STATUSES).toEqual(["running", "provisioning"]);
    expect(syncTaskCanStop("running")).toBe(true);
    expect(syncTaskCanStop("provisioning")).toBe(true);
  });
  it("draft / stopped / succeeded / error / failed / 空 ⇒ 显示「启动」", () => {
    for (const s of ["draft", "stopped", "succeeded", "error", "failed", "", undefined, null]) expect(syncTaskCanStop(s)).toBe(false);
  });
  it("动作尾段:可停 ⇒ stop;DMS 启动 ⇒ start-realtime(不管 syncMode);其它 ⇒ start", () => {
    expect(syncToggleAction("provisioning", "dms")).toBe("stop");
    expect(syncToggleAction("running", "glue")).toBe("stop");
    expect(syncToggleAction("draft", "dms")).toBe("start-realtime");
    expect(syncToggleAction("stopped", "dms")).toBe("start-realtime");
    expect(syncToggleAction("draft", "glue")).toBe("start");
    expect(syncToggleAction("draft", undefined)).toBe("start");
  });
  it("状态文案含 provisioning「启动中」(不再把英文裸值摆给用户)", () => {
    expect(SYNC_STATUS_META.provisioning).toEqual({ color: "processing", text: "启动中" });
    for (const k of ["draft", "running", "succeeded", "stopped", "error"]) expect(SYNC_STATUS_META[k]?.text).toBeTruthy();
  });
});

describe("接线:列表页与详情页都用唯一作者(「写了」≠「接上了」)", () => {
  it("app/sync/page.tsx:import syncToggleAction / syncTaskCanStop / SYNC_STATUS_META;不再自己写 status === \"running\" 判停止;状态格用 SYNC_STATUS_META", () => {
    const src = read("app/sync/page.tsx");
    expect(src).toMatch(/import \{[^}]*\bsyncToggleAction\b[^}]*\} from "@\/lib\/sync\/row-action"/);
    expect(src).toMatch(/\bsyncTaskCanStop\(/);
    expect(src).toMatch(/\bsyncToggleAction\(/);
    expect(src).toMatch(/SYNC_STATUS_META\[/);
    expect(src).not.toMatch(/record\.status === "running" \?/);
    expect(src).not.toMatch(/const statusMap/);
  });
  it("app/sync/[id]/page.tsx:停止按钮与动作都经唯一作者", () => {
    const src = read("app/sync/[id]/page.tsx");
    expect(src).toMatch(/import \{[^}]*\bsyncToggleAction\b[^}]*\} from "@\/lib\/sync\/row-action"/);
    expect(src).toMatch(/\bsyncTaskCanStop\(task\.status\)/);
    expect(src).toMatch(/\bsyncToggleAction\(task\.status, task\.channel\)/);
    expect(src).not.toMatch(/task\.channel === "dms" && task\.status !== "running"/);
  });
});
