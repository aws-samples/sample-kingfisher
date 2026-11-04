// @kf-batch 42-ux-feedback —— 同步向导 / 同步列表的 UX 兜底接线判据(用户 2026-10-15 反馈 ② ③ ④ ⑤)。
// 「写了」≠「接上了」:草稿模块、筛选器、错误兜底、自动刷新都必须在**调用点**出现,且旧形态不许回来。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(HERE, "..", rel), "utf8");
const strip = (raw: string) => raw.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

describe("③ 向导「完成」不许静默:整条提交路径在 try 里,异常落成 message.error;草稿保存成功才清", () => {
  const src = strip(read("SyncTaskModal.tsx"));
  it("handleSubmit 先按用户的话校验前两步必填(validateUpTo(1)),再包一层 try/catch 调 handleSubmitInner;catch 里 message.error 带错误原话", () => {
    expect(src).toMatch(/const handleSubmit = async \(\) => \{\s*if \(!validateUpTo\(1\)\) return;\s*try \{\s*await handleSubmitInner\(\);\s*\} catch \(e: any\) \{\s*message\.error\(t\("保存失败:\{m\}"/);
    expect(src).toMatch(/const validateStep = \(\) => validateUpTo\(step, step\);/); // 「下一步」仍只校验当前步
    expect(src).toMatch(/const handleSubmitInner = async \(\) => \{/);
  });
  it("两条成功路径(直接成功 / 覆盖确认后成功)都先 clearSyncDraft 再 onSuccess;失败路径不清草稿", () => {
    expect((src.match(/clearSyncDraft\(draftKey\); onSuccess\(\);/g) || []).length).toBe(2);
    expect(src).not.toMatch(/\? onSuccess\(\) :/); // 旧的三目形态不许回来(它绕过清草稿)
  });
  it("Modal 的确定按钮文案是「完成」且带 testid;草稿横幅 / 恢复 / 丢弃三个 testid 在", () => {
    expect(src).toMatch(/okText=\{t\("完成"\)\}\s*okButtonProps=\{\{ "data-testid": "sync-wizard-finish", style: step === 0 \? \{ display: "none" \} : undefined \}/);
    for (const id of ["sync-draft-banner", "sync-draft-restore", "sync-draft-discard"]) expect(src).toContain(`data-testid="${id}"`);
    expect(src).toMatch(/setPendingDraft\(loadSyncDraft\(editing\?\.taskId\)\)/); // 打开时读草稿
    expect(src).toMatch(/onValuesChange=\{\(\) => saveDraftNow\(\)\}/);           // 每次改值都存
    expect(src).toMatch(/useEffect\(\(\) => \{ saveDraftNow\(\);[\s\S]*\}, \[open, step, selectedTables, templateTables, fieldMappings\]\)/); // 步骤 / 选表 / 映射变了也存
  });
});

describe("④ 选表步:搜索筛选 + 只看已选 + 计数;不许再用 Checkbox.Group 承载已选值", () => {
  const src = strip(read("SyncTaskModal.tsx"));
  it("筛选器 / 只看已选 / 全选筛出 / 清空 / 计数五个 testid 在;Checkbox.Group 不再出现", () => {
    for (const id of ["sync-table-picker", "sync-table-filter", "sync-table-only-selected", "sync-table-select-shown", "sync-table-clear", "sync-table-count", "sync-table-row"]) {
      expect(src, id).toContain(`data-testid="${id}"`);
    }
    expect(src).not.toContain("<Checkbox.Group");
  });
  it("筛选按表名子串、不分大小写;只看已选按 selectedTables 过滤;单个 Checkbox 的 checked 来自 selectedTables", () => {
    expect(src).toMatch(/const kw = tableFilter\.trim\(\)\.toLowerCase\(\);/);
    expect(src).toMatch(/String\(tbl\.name\)\.toLowerCase\(\)\.includes\(kw\)/);
    expect(src).toMatch(/!onlySelected \|\| selectedTables\.includes\(tbl\.name\)/);
    expect(src).toMatch(/<Checkbox checked=\{selectedTables\.includes\(tbl\.name\)\} onChange=\{\(e\) => toggle\(String\(tbl\.name\), e\.target\.checked\)\}/);
  });
});

describe("⑤ /sync 自动刷新:只在开关开 + 有非终态任务时轮询;开关与轮询态暴露到 DOM", () => {
  const src = strip(read("page.tsx"));
  it("事实(非终态清单 / 间隔)从纯模块 import,页面自己**不许** export 常量(Next page 文件多一个 export 就 build 失败,2026-10-15 真挂过);effect 依赖 autoRefresh 与 anyInFlight", () => {
    expect(src).toMatch(/import \{ SYNC_AUTO_REFRESH_MS, anySyncInFlight \} from "@\/lib\/sync\/auto-refresh";/);
    expect(src).not.toMatch(/export const SYNC_/);
    expect((src.match(/^export\s/gm) || []).length).toBe(1); // 只剩 export default
    expect(src).toMatch(/const anyInFlight = anySyncInFlight\(data\);/);
    expect(src).toMatch(/if \(!autoRefresh \|\| !anyInFlight\) return;\s*const timer = setInterval\(\(\) => \{ fetchData\(\); \}, SYNC_AUTO_REFRESH_MS\);\s*return \(\) => clearInterval\(timer\);/);
  });
  it("开关 testid 带 data-on / data-polling 两个事实属性;默认开", () => {
    expect(src).toMatch(/data-testid="sync-auto-refresh" data-on=\{autoRefresh \? "true" : "false"\} data-polling=\{autoRefresh && anyInFlight \? "true" : "false"\}/);
    expect(src).toMatch(/useState\(true\);\s*$/m);
  });
});

describe("② 多页签右键菜单:三项都接到 closeMany,规则在纯模块", () => {
  const src = strip(readFileSync(resolve(HERE, "../../../components/layout/MultiTabs.tsx"), "utf8"));
  it("Dropdown contextMenu 包住页签标题;三项 onClick 各调 closeMany 一种模式;closeTabsBy 只从纯模块 import", () => {
    expect(src).toMatch(/<Dropdown trigger=\{\["contextMenu"\]\} menu=\{\{ items: menuFor\(tb, i\) \}\}>/);
    // 菜单项点击必须先 stopPropagation 再 closeMany(否则冒泡到 Tabs 的 tab 节点被当成切页签,「关闭全部」从非当前页签发起会落到被右键那页;p42b T1-c 真抓到)
    expect(src).toMatch(/=> \(\{ domEvent \}\) => \{\s*domEvent\.stopPropagation\(\);\s*closeMany\(tb\.path, mode\);\s*\}/);
    for (const mode of ["others", "right", "all"]) expect(src).toContain(`onClick: act("${mode}", tb)`);
    expect(src).toMatch(/import \{ closeTabsBy, HOME_TAB_PATH, type CloseTabsMode, type TabItem \} from "\.\/multitabs-close";/);
    expect(src).not.toMatch(/export function closeTabsBy/);
    for (const id of ["multitab-label", "multitab-close-others", "multitab-close-right", "multitab-close-all"]) expect(src).toContain(`data-testid="${id}"`);
  });
});

// @kf-batch 44-sync-switch-datasource —— 编辑任务换数据源(用户 2026-10-15 反馈 ②;…7698 探针坐实:旧源已选表残留、先发后到的旧源表清单盖掉新源)
describe("序 44 ② 换数据源:请求序号防竞态 + 用户换源后清掉不在新源里的已选表", () => {
  const src = strip(read("SyncTaskModal.tsx"));
  it("dsReqSeq 序号:每次选源自增;拉表 / 映射 / workgroup 三处结果落地前都比对序号;过期结果直接 return", () => {
    expect(src).toMatch(/const dsReqSeq = useRef\(0\);/);
    expect(src).toMatch(/const onDatasourceChange = async \(dsId: string, opts\?: \{ userSwitched\?: boolean \}\) => \{[\s\S]*?const seq = \+\+dsReqSeq\.current;/);
    expect((src.match(/if \(seq !== dsReqSeq\.current\) return;/g) || []).length).toBe(2);
    expect(src).toMatch(/if \(Array\.isArray\(d\) && seq === dsReqSeq\.current\) setRsWorkgroups\(d\);/);
  });
  it("userSwitched 只由下拉 onChange 传入;换源后不在新表清单里的已选表被移除并 message.info 点名", () => {
    expect(src).toMatch(/<Select onChange=\{\(v\) => \{ void onDatasourceChange\(String\(v\), \{ userSwitched: true \}\); \}\}/);
    expect((src.match(/userSwitched: true/g) || []).length).toBe(1); // 自动回填 / 草稿恢复不带它
    expect(src).toMatch(/if \(opts\?\.userSwitched\) \{\s*setDdlPreview\(\{\}\); setChannelRec\(null\); setCapabilityError\(null\);\s*const names = new Set\(tableList\.map\(\(x: any\) => String\(x\.name\)\)\);\s*const dropped = selectedTables\.filter\(\(x\) => !names\.has\(x\)\);\s*if \(dropped\.length\) \{\s*setSelectedTables\(selectedTables\.filter\(\(x\) => names\.has\(x\)\)\);\s*message\.info\(/);
  });
});

// 序 49 ⑥ UX ②(用户 2026-10-20 拍板:第一步「给缺省 + 只留 Next」)
describe("⑥ 新建向导第一步:三个选择题有缺省(唯一作者 SYNC_WIZARD_DEFAULTS),「完成」第 2 步起才出现", () => {
  const src = strip(read("SyncTaskModal.tsx"));
  it("缺省值模块:三个值都落在向导下拉 / 单选的闭合选项里(不是编出来的值)", async () => {
    const { SYNC_WIZARD_DEFAULTS } = await import("@/lib/sync/wizard-defaults");
    expect(src).toContain(`value: "${SYNC_WIZARD_DEFAULTS.syncMode}"`);
    expect(src).toContain(`value: "${SYNC_WIZARD_DEFAULTS.writeMode}"`);
    expect(src).toContain(`<Radio.Button value="${SYNC_WIZARD_DEFAULTS.targetType}">`);
    expect(SYNC_WIZARD_DEFAULTS).toEqual({ syncMode: "full", writeMode: "overwrite", targetType: "redshift" });
  });
  it("打开向导:新建用缺省(编辑用任务自己的值),targetType 状态同源;缺省只从唯一作者 import", () => {
    expect(src).toContain('import { SYNC_WIZARD_DEFAULTS } from "@/lib/sync/wizard-defaults"');
    // 序 53:编辑存量任务时先补回「记录没存就按 5.1」的 Glue 版本(withRecordGlueVersion),新建仍是唯一作者的缺省
    expect(src).toContain("form.setFieldsValue(editing ? withRecordGlueVersion(editing) : SYNC_WIZARD_DEFAULTS)");
    expect(src).toContain("setTargetType(editing?.targetType || SYNC_WIZARD_DEFAULTS.targetType)");
    expect(src).not.toContain("form.setFieldsValue(editing || {})");
  });
  it("第一步页脚只有「下一步」:Modal 确定按钮(完成)在 step === 0 时 display:none;下一步按钮仍只在非末步显示", () => {
    expect(src).toContain('style: step === 0 ? { display: "none" } : undefined');
    expect(src).toMatch(/\{step < STEPS\.length - 1 && <Button type="primary" onClick=\{\(\) => \{ if \(validateStep\(\)\) setStep\(step \+ 1\); \}\}>\{t\("下一步"\)\}<\/Button>\}/);
  });
});
