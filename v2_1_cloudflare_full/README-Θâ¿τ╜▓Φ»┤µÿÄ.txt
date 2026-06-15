教师用真实 DEM 等高线生成器 v6

本版坚持“全真 DEM”：
1. 高程数据来自 AWS Open Data Terrarium elevation tiles。
2. 不再使用教学演示 DEM 或伪地形兜底。
3. 若真实 DEM 瓦片读取失败，页面会明确报错，不会生成假等高线。

部署方式：
- 推荐直接把整个目录部署到 Netlify。
- 本包已包含 netlify.toml 和 netlify/functions：
  /api/terrain   -> 代理真实 DEM 瓦片
  /api/maptile   -> 代理 OpenStreetMap 底图瓦片
  /api/geocode   -> 代理 Nominatim 地名定位
- 不建议只双击本地 index.html 打开；本地 file:// 环境没有 Netlify Functions，DEM 代理接口不可用。

使用流程：
1. 输入地名并定位，或直接拖动地图。
2. 拖动绿色范围框，或拖四角缩放范围。
3. 选择图幅比例、比例尺、等高距。
4. 点击“生成地形与等高线”。
5. 导出 PNG / SVG / GeoJSON / CSV。

数据说明：
- DEM：AWS Open Data Terrarium elevation tiles，RGB 编码高程。
- 底图：OpenStreetMap。
- 地名定位：OpenStreetMap Nominatim。
