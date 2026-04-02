# MirageWhisper

基于 **GFS 分层温度数据** 识别逆温层，并对未来多天的：
- 海市蜃楼倾向
- 绿闪倾向

进行可视化展示的静态网页。

## 功能

- 人口排名前 100 的城市池，兼顾沿海与内陆
- 白天（日出到日落）低空逆温层监测，用于海市蜃楼倾向判断
- 日出 / 日落双端绿闪判断
- 逆温层关键指标：底高、顶高、厚度、强度（°C/km）
- 沿海城市尝试接入海温作为辅助修正项
- 当日城市排行
- 城市列表从独立 JSON 加载，便于后续继续扩充

## 数据来源

- Open-Meteo GFS API
  - hourly: `temperature_1000hPa...temperature_500hPa`, `cloud_cover`
  - daily: `sunrise`, `sunset`
- Open-Meteo Marine API（沿海城市尽量接入）
  - hourly: `sea_surface_temperature`

## 本地运行

直接打开 `index.html` 即可（推荐通过静态服务器访问）。

```bash
python3 -m http.server 8000
# 然后访问 http://localhost:8000
```

## 判别说明（首版）

- 逆温段：相邻层出现温度随高度上升（dT/dz > 0）
- 时刻逆温：取“最强逆温段”
- 海市蜃楼：围绕白天（日出→日落）窗口评估低空逆温持续性、强度、底高，并叠加海气热力差作为辅助信号
- 绿闪：分别对日出与日落窗口评估逆温与云量条件

> 注意：当前模型用于观测窗口筛选，不等同于严格光学射线追踪结果。
