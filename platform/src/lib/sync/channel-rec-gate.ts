// 同步向导「通道推荐」的取数闸:只认最后一次请求,且应答回来时表单里选的还是发请求时的那个数据源。
//
// 【为什么存在】通道可不可用取决于数据源所在的执行区(有的通道只在主控区提供,见 lib/sync/channel-place.ts)。
//   向导里换了数据源之后,按旧源取回来的推荐不许再摆在页面上,也不许晚到之后盖掉按新源取的那一份:
//   · 2026-11 之前「作废旧推荐 + 按新源重取」排在「等新源的表清单返回」之后 —— 经 Glue 连接读表要 1–3 分钟,
//     这期间页面上仍是旧源的通道单选(执行区的数据源会看到「Zero-ETL 推荐、已选中」,点保存才被拒);
//   · 取推荐的请求没有序号,先发后到的旧应答会盖掉新的。
// 闸只回答「这份应答还作不作数」「换源时要不要重取」,不发请求、不碰页面状态,所以能脱离页面单测。

/** 一次取推荐请求的凭据:发请求前取,应答回来时交回闸里核。 */
export interface ChannelRecTicket {
  readonly seq: number;
  readonly datasourceId: string | undefined;
}

export interface ChannelRecGate {
  /** 发请求之前取票;同时记下「这个向导已经在显示(或正在取)通道推荐」。 */
  begin(datasourceId: string | undefined): ChannelRecTicket;
  /** 应答回来:它是最后一次请求、且表单当前选的数据源仍是发请求时的那个 ⇒ 作数;否则丢弃。 */
  accepts(ticket: ChannelRecTicket, currentDatasourceId: string | undefined): boolean;
  /** 这个向导是否已经显示过(或正在取)通道推荐 —— 用户换数据源时据此决定要不要按新源重取。 */
  readonly wanted: boolean;
  /** 向导重新打开 / 恢复草稿:在途的应答全部作废,回到「还没显示过」。 */
  reset(): void;
}

export function createChannelRecGate(): ChannelRecGate {
  let seq = 0;
  let wanted = false;
  return {
    begin(datasourceId) {
      wanted = true;
      seq += 1;
      return { seq, datasourceId };
    },
    accepts(ticket, currentDatasourceId) {
      return ticket.seq === seq && ticket.datasourceId === currentDatasourceId;
    },
    get wanted() {
      return wanted;
    },
    reset() {
      wanted = false;
      seq += 1;
    },
  };
}
