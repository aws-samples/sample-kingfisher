"""
**在某个执行环境所在的 region 就地生成**游戏广告转化分析数据集(与 scripts/seed_game.py 同一套业务模型),
写成 Parquet 落该区**自己的数据湖桶** + 注册进**该区的** Glue Catalog(库 `gamedata`)。

🔴 为什么要「就地生成」而不是「从主控区同步过去」:
  源库(MySQL)只在主控区,跨区去读它=数据出境;而「多 region 用真实数据跑完全流程」要求那个区
  **自己有数据**。同步搬运的逐区下推是(产品 fail-closed:章不是 home 就 409,绝不偷偷在 home 跑)
  —— 「真实数据」必须**生在本区**才符合驻留。数据是**确定性生成**的(seed 固定 + 行数由 scale 决定),
  所以两个区可以造出**同构可比**的数据。

🔴 **schema 必须与 seed_game.py 逐列相同**(2026-09-18 真环境抓到的缺陷):
  此前这里的列名是另一套(spend_usd / install_ts / is_payer / started_at / max_level / item_sku / paid_at /
  event_ts,事件名集合也不同),于是「同一个 ETL 作业在每个区都跑」在第二个区当场 `column does not exist`
  —— 而文件头写的正是「同构可比」。两套 schema 就是两套业务模型,任何跨区可比的分析都写不出来。
  ⇒ 以下每张表的列名 / 顺序 / 取值集合都对齐 seed_game.py 的 CREATE TABLE(改一处必须两处同改)。

参数:--datalake <桶> --scale <玩家数,默认 20000> --db <Glue 库名,默认 gamedata>
表(与源库那套同名同列同关系):
  ad_channels 6 · ad_campaigns 40 · players N · game_sessions 5N · payments N/2 · ad_events 10N · player_events 25N
"""
import sys
from awsglue.utils import getResolvedOptions
from pyspark.sql import SparkSession
from pyspark.sql import functions as F

args = getResolvedOptions(sys.argv, ["JOB_NAME", "datalake", "scale", "db"])
LAKE = args["datalake"]
N = int(args["scale"])
DB = args["db"]

spark = (SparkSession.builder.appName(args["JOB_NAME"])
         .config("spark.sql.catalogImplementation", "hive")
         .config("spark.sql.parquet.writeLegacyFormat", "true")
         .getOrCreate())
spark.sparkContext.setLogLevel("WARN")

# 与 seed_game.py 同一套取值集合(channel_type: paid / organic;事件名四种;产品四档)
CHANNELS = [(1, "Google Ads", "paid"), (2, "Meta", "paid"), (3, "TikTok", "paid"),
            (4, "AppLovin", "paid"), (5, "Unity Ads", "paid"), (6, "Organic", "organic")]
COUNTRIES = ["US", "JP", "KR", "DE", "BR", "CN", "GB", "FR"]
OSES = ["iOS", "Android"]
EVENTS = ["login", "level_up", "purchase", "tutorial_done"]
PRODUCTS = ["gems_pack_s", "gems_pack_m", "gems_pack_l", "vip"]
STATUSES = ["active", "paused", "ended"]


def pick(arr, idx_col):
    return F.element_at(F.array(*[F.lit(x) for x in arr]), idx_col)


def write(df, name):
    path = f"s3://{LAKE}/gamedata/{name}/"
    df.write.mode("overwrite").parquet(path)
    spark.sql(f"CREATE DATABASE IF NOT EXISTS {DB}")
    spark.sql(f"DROP TABLE IF EXISTS {DB}.{name}")
    spark.sql(f"CREATE TABLE {DB}.{name} USING parquet LOCATION '{path}'")
    n = spark.read.parquet(path).count()
    print(f"[region-seed] {name}: {n} 行 → {path}")
    return n


counts = {}
# ad_channels(channel_id, channel_name, channel_type, created_at)
ch = (spark.createDataFrame(CHANNELS, "channel_id int, channel_name string, channel_type string")
      .withColumn("created_at", F.lit("2026-05-01 00:00:00").cast("timestamp")))
counts["ad_channels"] = write(ch, "ad_channels")

# ad_campaigns(campaign_id, channel_id, campaign_name, target_country, cost_usd, start_date, status)
camp = (spark.range(1, 41).withColumnRenamed("id", "campaign_id")
        .withColumn("channel_id", (F.col("campaign_id") % 6 + 1).cast("int"))
        .withColumn("campaign_name", F.concat(F.lit("camp_"), F.col("campaign_id")))
        .withColumn("target_country", pick(COUNTRIES, (F.col("campaign_id") % 8 + 1).cast("int")))
        .withColumn("cost_usd", F.round(F.rand(seed=11) * 50000 + 500, 2))
        .withColumn("start_date", F.date_add(F.lit("2026-06-01").cast("date"), (F.col("campaign_id") % 30).cast("int")))
        .withColumn("status", pick(STATUSES, (F.col("campaign_id") % 3 + 1).cast("int"))))
counts["ad_campaigns"] = write(camp, "ad_campaigns")

# players(player_id, install_time, source_channel_id, source_campaign_id, country, os, is_paying)
# source_channel_id 与所归因活动的 channel_id 同一规则派生(campaign % 6 + 1),两列自洽。
players = (spark.range(1, N + 1).withColumnRenamed("id", "player_id")
           .withColumn("install_time", F.expr("timestamp'2026-06-01 00:00:00' + make_interval(0,0,0,0,0, cast(player_id % 43200 as int))"))
           .withColumn("source_campaign_id", (F.col("player_id") % 40 + 1).cast("int"))
           .withColumn("source_channel_id", (F.col("source_campaign_id") % 6 + 1).cast("int"))
           .withColumn("country", pick(COUNTRIES, (F.col("player_id") % 8 + 1).cast("int")))
           .withColumn("os", pick(OSES, (F.col("player_id") % 2 + 1).cast("int")))
           .withColumn("is_paying", (F.rand(seed=7) < 0.06).cast("int"))
           .select("player_id", "install_time", "source_channel_id", "source_campaign_id", "country", "os", "is_paying"))
counts["players"] = write(players, "players")

# game_sessions(session_id, player_id, start_time, duration_sec, level_reached)
sess = (spark.range(1, N * 5 + 1).withColumnRenamed("id", "session_id")
        .withColumn("player_id", (F.col("session_id") % N + 1).cast("long"))
        .withColumn("start_time", F.expr("timestamp'2026-06-02 00:00:00' + make_interval(0,0,0,0,0, cast(session_id % 86400 as int))"))
        .withColumn("duration_sec", (F.rand(seed=13) * 3600).cast("int"))
        .withColumn("level_reached", (F.rand(seed=17) * 80 + 1).cast("int"))
        .select("session_id", "player_id", "start_time", "duration_sec", "level_reached"))
counts["game_sessions"] = write(sess, "game_sessions")

# payments(payment_id, player_id, amount_usd, product_id, pay_time)
pay = (spark.range(1, N // 2 + 1).withColumnRenamed("id", "payment_id")
       .withColumn("player_id", (F.col("payment_id") % N + 1).cast("long"))
       .withColumn("amount_usd", F.round(F.rand(seed=19) * 99 + 0.99, 2))
       .withColumn("product_id", pick(PRODUCTS, (F.col("payment_id") % 4 + 1).cast("int")))
       .withColumn("pay_time", F.expr("timestamp'2026-06-03 00:00:00' + make_interval(0,0,0,0,0, cast(payment_id % 86400 as int))")))
counts["payments"] = write(pay, "payments")

# ad_events(event_id, campaign_id, channel_id, device_id, event_type, country, os, cost_usd, event_time)
ade = (spark.range(1, N * 10 + 1).withColumnRenamed("id", "event_id")
       .withColumn("campaign_id", (F.col("event_id") % 40 + 1).cast("int"))
       .withColumn("channel_id", (F.col("campaign_id") % 6 + 1).cast("int"))
       .withColumn("device_id", F.concat(F.lit("dev_"), (F.col("event_id") % (N * 2) + 1).cast("long")))
       .withColumn("event_type", F.when(F.col("event_id") % 10 == 0, F.lit("click")).otherwise(F.lit("impression")))
       .withColumn("country", pick(COUNTRIES, (F.col("event_id") % 8 + 1).cast("int")))
       .withColumn("os", pick(OSES, (F.col("event_id") % 2 + 1).cast("int")))
       .withColumn("cost_usd", F.round(F.rand(seed=23) * 0.5, 4))
       .withColumn("event_time", F.expr("timestamp'2026-06-01 00:00:00' + make_interval(0,0,0,0,0, cast(event_id % 172800 as int))")))
counts["ad_events"] = write(ade, "ad_events")

# player_events(event_id, player_id, event_name, level, event_time)—— 最大事实表
pe = (spark.range(1, N * 25 + 1).withColumnRenamed("id", "event_id")
      .withColumn("player_id", (F.col("event_id") % N + 1).cast("long"))
      .withColumn("event_name", pick(EVENTS, (F.col("event_id") % 4 + 1).cast("int")))
      .withColumn("level", (F.rand(seed=29) * 80 + 1).cast("int"))
      .withColumn("event_time", F.expr("timestamp'2026-06-02 00:00:00' + make_interval(0,0,0,0,0, cast(event_id % 259200 as int))")))
counts["player_events"] = write(pe, "player_events")

print("[region-seed] 完成:" + " · ".join(f"{k}={v}" for k, v in counts.items()))
