
# v2.1 Cloudflare 部署说明

## 1. Pages 部署（前端）
1. 上传整个项目到 GitHub
2. Cloudflare Pages -> 连接 GitHub
3. Framework: None
4. Build: 空
5. Output: /

## 2. Worker 部署（后端API）
1. 进入 Cloudflare Workers
2. 创建 Worker
3. 粘贴 worker.js
4. 发布

## 3. API结构
- /api/geocode
- /api/overpass
- /api/tile/{z}/{x}/{y}
- /api/dem?bbox=

## 4. 注意
- OSM/Overpass可能慢
- DEM需后续替换真实源
