Quarantine —隔离异常快照
=========================

这些文件内部实际数据截止日为2026-07-26，但因旧日期识别逻辑错误被命名为2026-07-27。

隔离日期：2026-07-27
原因：旧日期识别逻辑错误命名
不应被 /compare 或 archive 索引读取。

文件清单：
  development_2026-07-27_WRONG_DATE_actual_2026-07-26.xlsx
    原文件名：development_2026-07-27.xlsx
    内部截止日：2026-07-26

  hijack_2026-07-27_WRONG_DATE_actual_2026-07-26.xlsx
    原文件名：hijack_2026-07-27.xlsx
    内部截止日：2026-07-26

development_2026-06-26_WRONG_RANGE_actual_2026-06-30.xlsx
  原文件名：development_2026-06-26.xlsx
  隔离日期：2026-07-27
  原因：文件名为2026-06-26，但汇总总行包含2026-06-01至2026-06-30全月数据
  不应被 /compare 或 archive 索引读取
