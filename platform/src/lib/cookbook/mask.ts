// SQL 词法遮蔽(guard 安全匹配的前提)。修复设计审核 🔴A 高危
//
// 问题:guard 的 antiPattern 正则若直接打在【原始 SQL 文本】上,会误伤【字符串字面量/注释】里
// 恰好出现的 anti-pattern。例如合法 SQL:
//   INSERT INTO log(note) VALUES ('CREATE TABLE IF NOT EXISTS foo AS ...');   -- 这是数据,不是 DDL
// 若不遮蔽,CTAS 规则会把字符串【内容】改成 DDL,损坏用户数据。
//
// 方案:输出一份与原文【等长、逐字符对齐】的 masked 文本,把【注释 + 单引号字符串】替换成等长空白
// (换行保留)。guard 在 masked 上判定命中 + 定位 match 区间 [start,end),再把 fix 应用到【原始文本的
// 同一区间】。因 masked 与原文等长对齐,masked 上的 index/length 可直接映射回原文,fix 不触碰被遮蔽内容。
//
// 【关键设计抉择:只遮蔽注释 + 单引号字符串,不遮蔽双引号/反引号标识符】——
//  · 单引号字符串 & 注释 = 任意文本/数据,是真正的误伤源(🔴A 案例),必须遮蔽。
//  · 双引号标识符("schema"."tbl")= 真实的库表对象名,正是 anti-pattern 要【捕获】的目标;
//    若遮蔽它,像 `CREATE TABLE IF NOT EXISTS "my"."tbl" AS` 这种真违规反而匹配不到(假阴性)。故【保留】。
//  · 反引号标识符(`col`)= Redshift 方言规则的【纠正目标】,必须可见才能被规则命中。故【保留】。
//  · 注:Redshift/Athena/Flink SQL 里双引号恒为标识符(非字符串),故保留双引号不会漏遮字符串。
//
// 但双引号/反引号区间仍需被【正确词法识别并跳过】——否则其内部若含单引号(如标识符 "it's"),
// 会被误当字符串起点,吞掉后面一大段。所以扫描器识别全部区间类型(注释/单引号/双引号/反引号),
// 只是对双引号/反引号【保留原字符不置空、但作为整体跳过】。

const SPACE = " ";

// 用等长空白替换 [start, end) 区间(保留换行,便于行号/可读性;其余填空格)。
function blankOut(src: string, out: string[], start: number, end: number): void {
  for (let i = start; i < end; i++) {
    out[i] = src[i] === "\n" ? "\n" : SPACE;
  }
}

export interface MaskResult {
  masked: string; // 与原文等长;注释/单引号字符串区间被置空(换行保留);双引号/反引号保留
  hasMaskedRegions: boolean; // 是否存在被遮蔽区间(便于调用方判断"原文是否含字符串/注释")
}

// 生成遮蔽后的文本。masked 与 src 等长、逐字符对齐(除被遮蔽处外原样保留)。
export function maskSqlLiterals(src: string): MaskResult {
  if (!src) return { masked: src || "", hasMaskedRegions: false };
  const out = src.split(""); // 可变副本;默认原样,仅对"遮蔽区间"置空
  let i = 0;
  const n = src.length;
  let hasMaskedRegions = false;

  while (i < n) {
    const c = src[i];
    const c2 = i + 1 < n ? src[i + 1] : "";

    // 行注释 -- … 到行尾 → 遮蔽
    if (c === "-" && c2 === "-") {
      let j = i + 2;
      while (j < n && src[j] !== "\n") j++;
      blankOut(src, out, i, j);
      hasMaskedRegions = true;
      i = j;
      continue;
    }

    // 块注释 /* … */(不嵌套)→ 遮蔽
    if (c === "/" && c2 === "*") {
      let j = i + 2;
      while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j++;
      const end = j < n ? j + 2 : n; // 未闭合则吃到结尾
      blankOut(src, out, i, end);
      hasMaskedRegions = true;
      i = end;
      continue;
    }

    // 单引号字符串 '…'('' = 转义引号)→ 遮蔽(真正的误伤源)
    if (c === "'") {
      let j = i + 1;
      while (j < n) {
        if (src[j] === "'" && src[j + 1] === "'") { j += 2; continue; } // 转义引号,跳过两个
        if (src[j] === "'") { j++; break; } // 闭合
        j++;
      }
      blankOut(src, out, i, j);
      hasMaskedRegions = true;
      i = j;
      continue;
    }

    // 双引号标识符 "…"("" = 转义)→ 【保留原字符】,仅作为整体跳过(防内部单引号被误判为字符串起点)
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '"' && src[j + 1] === '"') { j += 2; continue; }
        if (src[j] === '"') { j++; break; }
        j++;
      }
      i = j; // 不 blankOut:标识符是 anti-pattern 的捕获目标,须保留可见
      continue;
    }

    // 反引号标识符 `…` → 【保留原字符】,仅整体跳过(反引号本身是方言规则的纠正目标)
    if (c === "`") {
      let j = i + 1;
      while (j < n && src[j] !== "`") j++;
      const end = j < n ? j + 1 : n;
      i = end; // 不 blankOut:反引号规则需要看到它
      continue;
    }

    i++;
  }

  return { masked: out.join(""), hasMaskedRegions };
}
