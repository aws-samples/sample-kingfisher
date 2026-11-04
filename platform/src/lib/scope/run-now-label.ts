// @kf-batch 50-run-now-label
// 「立即运行」按钮文案的**唯一作者**(护栏 2 / INTERACTION §9.3-2:写操作必须在按钮上复述目标)。
//
// 🔴 为什么要抽出来:2026-09-19 无头验收抓到 —— `/etl-jobs` 的 Glue/Redshift 作业按钮写着
//   「立即运行 · us-west-2」,而**同一页**里的 EMR Serverless 面板只写「立即运行」:
//   同一个页面上,两个同样会在某个区真跑一次的写操作,一个复述了目标、一个没有。
//   用户点下去之前看不出这一下会打到哪个区 —— 护栏 2 就是为这件事立的,而它只接了一半
//   (「机制建好了只是那条路径没接」= 本仓反复出现的元 bug)。
//
// 🔴 复述的是**作业自己的绑定**(targets),不是顶栏当前视角:真跑落在哪个区由绑定决定,
//   按钮要说的是「这一下会发生什么」,说成视角就是误导。
// 🔴 拿不到 region 时**退回原文案**,绝不显示 targetId 充数(targetId 不是用户语言)。

export interface RunNowLabelInput {
  /** 作业绑定的执行目标(单区 ⇒ 复述 region;多区 ⇒ 复述「几个区各跑一次」) */
  targets: string[];
  /** 单区时那个区的 region;拿不到给空串 */
  regionOfSingle: string;
  /** i18n 取词器(页面传进来,本模块不依赖 React;形状与 `useT()` 逐字一致) */
  t: (zh: string, params?: Record<string, string | number>) => string;
}

export function runNowLabel({ targets, regionOfSingle, t }: RunNowLabelInput): string {
  if ((targets?.length ?? 0) > 1) return t("立即运行({n} 个区各跑一次)", { n: targets.length });
  return regionOfSingle ? `${t("立即运行")} · ${regionOfSingle}` : t("立即运行");
}
