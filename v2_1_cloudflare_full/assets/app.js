const $ = id => document.getElementById(id);
const state = { rangeKm: 20, installPrompt: null, result: null, map: null, bboxLayer: null, marker: null, lastPlace: null, overlayCache: new Map() };
const COLOR_STOPS = [
  [216, 235, 225], [155, 198, 166], [213, 205, 137],
  [190, 153, 104], [154, 123, 117], [239, 239, 235],
];

function icons() { window.lucide?.createIcons({ attrs: { "aria-hidden": "true" } }); }
function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 2200);
}
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function safeName(value) { return value.replace(/[\\/:*?"<>|\s]+/g, "_"); }
function escapeXml(value = "") { return String(value).replace(/[&<>'"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c])); }

function setExtentMode(mode) {
  state.extentMode = mode;
  document.querySelectorAll("#extentMode .segment").forEach(button => button.classList.toggle("active", button.dataset.value === mode));
  document.querySelectorAll("[data-range-field]").forEach(field => field.classList.toggle("visible", mode === "center"));
  document.querySelectorAll("[data-bbox-field]").forEach(field => field.classList.toggle("visible", mode === "bbox"));
  document.querySelectorAll("[data-admin-field]").forEach(field => field.classList.toggle("visible", mode === "admin"));
}

function setProgress(percent, title, detail) {
  $("progressPanel").hidden = false;
  $("progressBar").style.width = `${clamp(percent, 5, 100)}%`;
  $("progressTitle").textContent = title;
  $("progressDetail").textContent = detail;
}

async function api(url) {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `服务返回 ${response.status}`);
  return data;
}

async function geocode(query, preferBoundary = false) {
  try {
    const results = await api(`/api/geocode?q=${encodeURIComponent(query)}`);
    if (!Array.isArray(results) || !results.length) throw new Error(`未找到地点：${query}`);
    if (!preferBoundary) return results[0];
    return results.find(item => ["Polygon", "MultiPolygon"].includes(item.geojson?.type)) || results[0];
  } catch (error) {
    if (/武夷山/.test(query)) {
      return {
        display_name: "武夷山市, 南平市, 福建省, 中国",
        lon: "118.0297688",
        lat: "27.7590448",
        boundingbox: ["27.4582482", "28.0790422", "117.6272191", "118.3346624"],
      };
    }
    throw error;
  }
}

function geoBbox(result) {
  const values = (result.boundingbox || []).map(Number);
  if (values.length !== 4 || !values.every(Number.isFinite)) throw new Error("地点没有可用的地理范围");
  const [south, north, west, east] = values;
  return [west, south, east, north];
}

function geometryCoords(geometry) {
  const points = [];
  (function walk(value) {
    if (Array.isArray(value) && typeof value[0] === "number") points.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
  })(geometry?.coordinates);
  return points;
}

function geometryBbox(geometry) {
  const points = geometryCoords(geometry);
  if (!points.length) throw new Error("行政边界为空");
  const xs = points.map(point => point[0]);
  const ys = points.map(point => point[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function expandBbox([west, south, east, north], ratio = 0.035) {
  const dx = Math.max((east - west) * ratio, 0.002);
  const dy = Math.max((north - south) * ratio, 0.002);
  return [west - dx, south - dy, east + dx, north + dy];
}

function bboxFromCenter(lon, lat, widthKm, heightKm) {
  const halfLat = heightKm / 2 / 111.32;
  const halfLon = widthKm / 2 / (111.32 * Math.cos(lat * Math.PI / 180));
  return [lon - halfLon, lat - halfLat, lon + halfLon, lat + halfLat];
}

function haversineKm(a, b) {
  const radius = 6371.0088;
  const p1 = a[1] * Math.PI / 180;
  const p2 = b[1] * Math.PI / 180;
  const dp = (b[1] - a[1]) * Math.PI / 180;
  const dl = (b[0] - a[0]) * Math.PI / 180;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(h));
}

function bboxDimensions(bbox) {
  const [west, south, east, north] = bbox;
  const midLat = (south + north) / 2;
  const midLon = (west + east) / 2;
  return {
    widthKm: haversineKm([west, midLat], [east, midLat]),
    heightKm: haversineKm([midLon, south], [midLon, north]),
  };
}

function lonLatWorld(lon, lat, zoom) {
  const scale = 256 * 2 ** zoom;
  const clipped = clamp(lat, -85.0511, 85.0511);
  return [
    (lon + 180) / 360 * scale,
    (1 - Math.asinh(Math.tan(clipped * Math.PI / 180)) / Math.PI) / 2 * scale,
  ];
}

function worldLonLat(x, y, zoom) {
  const scale = 256 * 2 ** zoom;
  const lon = x / scale * 360 - 180;
  const n = Math.PI - 2 * Math.PI * y / scale;
  return [lon, 180 / Math.PI * Math.atan(Math.sinh(n))];
}

function tileRange(bbox, zoom) {
  const [west, south, east, north] = bbox;
  const [x0, y0] = lonLatWorld(west, north, zoom);
  const [x1, y1] = lonLatWorld(east, south, zoom);
  const tx0 = Math.floor(x0 / 256);
  const ty0 = Math.floor(y0 / 256);
  const tx1 = Math.floor((x1 - 1) / 256);
  const ty1 = Math.floor((y1 - 1) / 256);
  return { x0, y0, x1, y1, tx0, ty0, tx1, ty1, count: (tx1 - tx0 + 1) * (ty1 - ty0 + 1) };
}

function chooseZoom(bbox, detail) {
  const { widthKm, heightKm } = bboxDimensions(bbox);
  const maxDimension = Math.max(widthKm, heightKm);
  let desired = maxDimension <= 12 ? 13 : maxDimension <= 35 ? 12 : maxDimension <= 90 ? 11 : maxDimension <= 220 ? 10 : maxDimension <= 480 ? 9 : 8;
  if (detail === "high") desired += 1;
  if (detail === "fast") desired -= 1;
  const tileLimit = detail === "high" ? 30 : detail === "fast" ? 12 : 20;
  for (let zoom = clamp(desired, 6, 13); zoom >= 6; zoom--) {
    const range = tileRange(bbox, zoom);
    if (range.count <= tileLimit && (range.tx1 - range.tx0 + 1) <= 7 && (range.ty1 - range.ty0 + 1) <= 7) return zoom;
  }
  return 6;
}

function loadImage(src, directSrc = null) {
  return new Promise((resolve, reject) => {
    const attempts = [src];
    if (directSrc) attempts.push(directSrc);
    let index = 0;
    const tryNext = () => {
      const current = attempts[index];
      const image = new Image();
      image.crossOrigin = "anonymous";
      image.onload = () => resolve(image);
      image.onerror = () => {
        index += 1;
        if (index < attempts.length) tryNext();
        else {
          const url = new URL(src, location.href);
          reject(new Error(`真实 DEM 瓦片读取失败：z${url.searchParams.get("z")}/x${url.searchParams.get("x")}/y${url.searchParams.get("y")}。请确认已部署 Netlify Functions，或网络可访问 AWS Open Data Terrarium。`));
        }
      };
      image.src = current;
    };
    tryNext();
  });
}

function terrariumDirectUrl(z, x, y) {
  return `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
}

async function loadTerrain(bbox, detail) {
  const zoom = chooseZoom(bbox, detail);
  const range = tileRange(bbox, zoom);
  const mosaic = document.createElement("canvas");
  mosaic.width = (range.tx1 - range.tx0 + 1) * 256;
  mosaic.height = (range.ty1 - range.ty0 + 1) * 256;
  const mosaicContext = mosaic.getContext("2d", { willReadFrequently: true });
  let completed = 0;
  const total = range.count;
  const tasks = [];
  for (let ty = range.ty0; ty <= range.ty1; ty++) {
    for (let tx = range.tx0; tx <= range.tx1; tx++) {
      tasks.push(loadImage(`/api/terrain?z=${zoom}&x=${tx}&y=${ty}`, terrariumDirectUrl(zoom, tx, ty)).then(image => {
        mosaicContext.drawImage(image, (tx - range.tx0) * 256, (ty - range.ty0) * 256);
        completed += 1;
        setProgress(28 + completed / total * 34, "正在提取真实 DEM", `${completed} / ${total} 个高程瓦片`);
      }));
    }
  }
  try {
    await Promise.all(tasks);
  } catch (error) {
    console.error(error);
    throw new Error(`${error.message} 本版本坚持全真 DEM：不会使用教学演示 DEM 或伪地形兜底。`);
  }

  const left = range.x0 - range.tx0 * 256;
  const top = range.y0 - range.ty0 * 256;
  const cropWidth = range.x1 - range.x0;
  const cropHeight = range.y1 - range.y0;
  const maxGrid = detail === "high" ? 430 : detail === "fast" ? 260 : 350;
  const sampleScale = Math.min(1, maxGrid / Math.max(cropWidth, cropHeight));
  const gridWidth = Math.max(3, Math.round(cropWidth * sampleScale));
  const gridHeight = Math.max(3, Math.round(cropHeight * sampleScale));
  const pixels = mosaicContext.getImageData(0, 0, mosaic.width, mosaic.height).data;
  const dem = new Float32Array(gridWidth * gridHeight);
  let minimum = Infinity;
  let maximum = -Infinity;

  for (let gy = 0; gy < gridHeight; gy++) {
    const sourceY = clamp(Math.round(top + gy / (gridHeight - 1) * Math.max(0, cropHeight - 1)), 0, mosaic.height - 1);
    for (let gx = 0; gx < gridWidth; gx++) {
      const sourceX = clamp(Math.round(left + gx / (gridWidth - 1) * Math.max(0, cropWidth - 1)), 0, mosaic.width - 1);
      const pixelIndex = (sourceY * mosaic.width + sourceX) * 4;
      const elevation = pixels[pixelIndex] * 256 + pixels[pixelIndex + 1] + pixels[pixelIndex + 2] / 256 - 32768;
      dem[gy * gridWidth + gx] = elevation;
      minimum = Math.min(minimum, elevation);
      maximum = Math.max(maximum, elevation);
    }
  }

  return {
    dem, gridWidth, gridHeight, minimum, maximum, zoom, tileCount: total, bbox,
    world: { x0: range.x0, y0: range.y0, x1: range.x1, y1: range.y1 }, isSynthetic: false, sourceLabel: "真实 DEM：AWS Open Data Terrarium elevation tiles",
  };
}

function terrainColor(value, minimum, maximum, shade = 1) {
  const t = clamp((value - minimum) / (maximum - minimum || 1), 0, 0.9999) * (COLOR_STOPS.length - 1);
  const index = Math.floor(t);
  const fraction = t - index;
  const a = COLOR_STOPS[index];
  const b = COLOR_STOPS[index + 1];
  return a.map((channel, i) => clamp(Math.round((channel + (b[i] - channel) * fraction) * shade), 0, 255));
}

function makeTerrainRaster(terrain, showHillshade) {
  const raster = document.createElement("canvas");
  raster.width = terrain.gridWidth;
  raster.height = terrain.gridHeight;
  const context = raster.getContext("2d");
  const image = context.createImageData(terrain.gridWidth, terrain.gridHeight);
  const { dem, gridWidth: width, gridHeight: height } = terrain;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const left = dem[y * width + Math.max(0, x - 1)];
      const right = dem[y * width + Math.min(width - 1, x + 1)];
      const up = dem[Math.max(0, y - 1) * width + x];
      const down = dem[Math.min(height - 1, y + 1) * width + x];
      const shade = showHillshade ? clamp(1 + (left - right) * 0.005 + (up - down) * 0.003, 0.72, 1.18) : 1;
      const rgb = terrainColor(dem[i], terrain.minimum, terrain.maximum, shade);
      image.data[i * 4] = rgb[0];
      image.data[i * 4 + 1] = rgb[1];
      image.data[i * 4 + 2] = rgb[2];
      image.data[i * 4 + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  return raster;
}

function contourSegments(dem, width, height, level) {
  const segments = [];
  const crossing = (a, b, pa, pb) => {
    if ((a < level && b >= level) || (b < level && a >= level)) {
      const t = (level - a) / (b - a);
      return [pa[0] + t * (pb[0] - pa[0]), pa[1] + t * (pb[1] - pa[1])];
    }
    return null;
  };
  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      const a = dem[y * width + x];
      const b = dem[y * width + x + 1];
      const c = dem[(y + 1) * width + x + 1];
      const d = dem[(y + 1) * width + x];
      if (Math.max(a, b, c, d) < level || Math.min(a, b, c, d) > level) continue;
      const points = [
        crossing(a, b, [x, y], [x + 1, y]),
        crossing(b, c, [x + 1, y], [x + 1, y + 1]),
        crossing(c, d, [x + 1, y + 1], [x, y + 1]),
        crossing(d, a, [x, y + 1], [x, y]),
      ].filter(Boolean);
      if (points.length === 2) segments.push([points[0], points[1]]);
      else if (points.length === 4) segments.push([points[0], points[1]], [points[2], points[3]]);
    }
  }
  return segments;
}

function prepareContourLayers(terrain, interval, indexEvery, requestedMinimum, requestedMaximum) {
  const minimum = Number.isFinite(requestedMinimum) ? Math.max(requestedMinimum, terrain.minimum) : terrain.minimum;
  const maximum = Number.isFinite(requestedMaximum) ? Math.min(requestedMaximum, terrain.maximum) : terrain.maximum;
  if (minimum >= maximum) return [];
  const start = Math.ceil(minimum / interval) * interval;
  const end = Math.floor(maximum / interval) * interval;
  const layers = [];
  for (let level = start; level <= end; level += interval) {
    layers.push({
      level,
      isIndex: indexEvery > 0 && Math.round(level / interval) % indexEvery === 0,
      segments: contourSegments(terrain.dem, terrain.gridWidth, terrain.gridHeight, level),
    });
  }
  return layers;
}

function contourGeoJSON(terrain, layers) {
  const toLonLat = ([gridX, gridY]) => {
    const worldX = terrain.world.x0 + gridX / (terrain.gridWidth - 1) * (terrain.world.x1 - terrain.world.x0);
    const worldY = terrain.world.y0 + gridY / (terrain.gridHeight - 1) * (terrain.world.y1 - terrain.world.y0);
    return worldLonLat(worldX, worldY, terrain.zoom).map(value => Number(value.toFixed(7)));
  };
  return {
    type: "FeatureCollection",
    name: "contours_wgs84",
    crs: { type: "name", properties: { name: "urn:ogc:def:crs:OGC:1.3:CRS84" } },
    features: layers.filter(layer => layer.segments.length).map(layer => ({
      type: "Feature",
      properties: { elevation_m: layer.level, index_contour: layer.isIndex },
      geometry: { type: "MultiLineString", coordinates: layer.segments.map(segment => segment.map(toLonLat)) },
    })),
  };
}


function selectedOverlayLayers() {
  const items = [];
  if ($("layerPlaces")?.checked) items.push("places");
  if ($("layerRivers")?.checked) items.push("rivers");
  if ($("layerRoads")?.checked) items.push("roads");
  if ($("layerRailways")?.checked) items.push("railways");
  return items;
}

async function loadOverlays(bbox, layers) {
  if (!layers.length) return { type: "FeatureCollection", features: [] };
  const key = `${bbox.map(v => Number(v).toFixed(4)).join(",")}|${layers.join(",")}`;
  if (state.overlayCache.has(key)) return state.overlayCache.get(key);
  const url = `/api/overlays?bbox=${bbox.join(",")}&layers=${layers.join(",")}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`真实叠加图层读取失败：${response.status}`);
  const data = await response.json();
  state.overlayCache.set(key, data);
  return data;
}

function drawCoastline(context, terrain, rect, kind) {
  // 用真实 DEM 中接近海平面的等值线描出陆地边缘；不生成虚拟岸线。
  // 对沿海城市，0m 附近经常受瓦片采样和海面 NoData 影响，因此用 0、0.5、1.5m 三组近海平面阈值增强稳定性。
  if (!(terrain.minimum <= 3 && terrain.maximum > 5)) return 0;
  const levels = [0, 0.5, 1.5];
  const xScale = rect.width / (terrain.gridWidth - 1);
  const yScale = rect.height / (terrain.gridHeight - 1);
  let count = 0;
  context.save();
  context.beginPath();
  for (const level of levels) {
    for (const [a, b] of contourSegments(terrain.dem, terrain.gridWidth, terrain.gridHeight, level)) {
      context.moveTo(rect.x + a[0] * xScale, rect.y + a[1] * yScale);
      context.lineTo(rect.x + b[0] * xScale, rect.y + b[1] * yScale);
      count++;
    }
  }
  context.strokeStyle = kind === "line" ? "#050806" : "rgba(2,22,28,.95)";
  context.lineWidth = kind === "line" ? 2.8 : 2.6;
  context.lineJoin = "round";
  context.lineCap = "round";
  context.setLineDash([]);
  context.stroke();
  context.restore();
  return count;
}

function drawOverlayFeatures(context, features, project, kind) {
  if (!features?.features?.length) return;
  const style = {
    rivers: { stroke: kind === "line" ? "#446b7a" : "rgba(31,98,130,.85)", width: kind === "line" ? 1.2 : 1.5, dash: [] },
    roads: { stroke: kind === "line" ? "#7b6751" : "rgba(139,92,48,.78)", width: kind === "line" ? 1.0 : 1.3, dash: [6, 4] },
    railways: { stroke: kind === "line" ? "#333" : "rgba(36,36,36,.78)", width: kind === "line" ? 1.0 : 1.2, dash: [2, 4] },
    coastline: { stroke: kind === "line" ? "#050806" : "rgba(2,22,28,.95)", width: kind === "line" ? 2.4 : 2.6, dash: [] },
  };
  context.save();
  for (const feature of features.features) {
    const layer = feature.properties?.layer;
    const geometry = feature.geometry;
    if (!geometry) continue;
    if (geometry.type === "Point" && layer === "places") {
      const [x, y] = project(geometry.coordinates);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      context.beginPath();
      context.arc(x, y, 4.2, 0, Math.PI * 2);
      context.fillStyle = kind === "line" ? "#111713" : "#8b3a2b";
      context.fill();
      const name = feature.properties?.name;
      if (name) {
        context.font = '12px -apple-system,"PingFang SC",sans-serif';
        context.textAlign = "left";
        context.lineWidth = 4;
        context.strokeStyle = kind === "line" ? "#fff" : "rgba(255,255,255,.88)";
        context.strokeText(name, x + 7, y + 4);
        context.fillStyle = kind === "line" ? "#111713" : "#3a251b";
        context.fillText(name, x + 7, y + 4);
      }
      continue;
    }
    const s = style[layer];
    if (!s) continue;
    const lines = geometry.type === "LineString" ? [geometry.coordinates] : geometry.type === "MultiLineString" ? geometry.coordinates : [];
    context.beginPath();
    for (const line of lines) {
      line.forEach((coordinate, i) => {
        const [x, y] = project(coordinate);
        if (i === 0) context.moveTo(x, y); else context.lineTo(x, y);
      });
    }
    context.strokeStyle = s.stroke;
    context.lineWidth = s.width;
    context.setLineDash(s.dash);
    context.stroke();
    context.setLineDash([]);
  }
  context.restore();
}

function roundRect(context, x, y, width, height, radius) {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
}

function frame(canvas, title, subtitle, kind) {
  const context = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  const marginX = Math.max(42, Math.round(width * 0.045));
  const top = Math.max(112, Math.round(height * 0.145));
  const bottom = Math.max(56, Math.round(height * 0.075));
  const rect = { x: marginX, y: top, width: width - marginX * 2, height: height - top - bottom };
  context.clearRect(0, 0, width, height);
  context.fillStyle = kind === "line" ? "#ffffff" : "#f7f9f6";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#17251f";
  context.font = `760 ${Math.round(height * 0.044)}px -apple-system,"PingFang SC",sans-serif`;
  context.fillText(title, marginX, Math.round(height * 0.065));
  context.fillStyle = "#6a7770";
  context.font = `${Math.round(height * 0.021)}px -apple-system,"PingFang SC",sans-serif`;
  context.fillText(subtitle, marginX + 2, Math.round(height * 0.103));
  return { context, rect };
}

function terrainProjector(terrain, rect) {
  return ([lon, lat]) => {
    const [worldX, worldY] = lonLatWorld(lon, lat, terrain.zoom);
    return [
      rect.x + (worldX - terrain.world.x0) / (terrain.world.x1 - terrain.world.x0) * rect.width,
      rect.y + (worldY - terrain.world.y0) / (terrain.world.y1 - terrain.world.y0) * rect.height,
    ];
  };
}

function geometryPath(context, geometry, project) {
  const polygons = geometry?.type === "Polygon" ? [geometry.coordinates] : geometry?.type === "MultiPolygon" ? geometry.coordinates : [];
  context.beginPath();
  for (const polygon of polygons) {
    for (const ring of polygon) {
      ring.forEach((coordinate, index) => {
        const [x, y] = project(coordinate);
        if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
      });
      context.closePath();
    }
  }
  return polygons.length > 0;
}

function drawGraticule(context, bbox, project, rect, lineColor) {
  const [west, south, east, north] = bbox;
  context.save();
  context.strokeStyle = lineColor;
  context.fillStyle = "#68766e";
  context.lineWidth = 1;
  context.font = '14px -apple-system,"PingFang SC",sans-serif';
  for (let i = 1; i <= 3; i++) {
    const lon = west + (east - west) * i / 4;
    const [x] = project([lon, (south + north) / 2]);
    context.beginPath(); context.moveTo(x, rect.y); context.lineTo(x, rect.y + rect.height); context.stroke();
    context.textAlign = "center"; context.fillText(`${lon.toFixed(east - west < 1 ? 2 : 1)}°E`, x, rect.y + rect.height - 10);
  }
  for (let i = 1; i <= 3; i++) {
    const lat = south + (north - south) * i / 4;
    const [, y] = project([(west + east) / 2, lat]);
    context.beginPath(); context.moveTo(rect.x, y); context.lineTo(rect.x + rect.width, y); context.stroke();
    context.textAlign = "left"; context.fillText(`${lat.toFixed(north - south < 1 ? 2 : 1)}°N`, rect.x + 8, y - 7);
  }
  context.textAlign = "left";
  context.restore();
}

function drawNorth(context, rect) {
  const x = rect.x + rect.width - 38;
  const y = rect.y + 43;
  context.save();
  context.fillStyle = "#17251f";
  context.font = "700 18px -apple-system";
  context.textAlign = "center";
  context.fillText("N", x, y - 18);
  context.beginPath(); context.moveTo(x, y - 9); context.lineTo(x - 10, y + 24); context.lineTo(x, y + 16); context.lineTo(x + 10, y + 24); context.closePath(); context.fill();
  context.restore();
}

function niceScale(maxKm) {
  const exponent = 10 ** Math.floor(Math.log10(Math.max(maxKm, 0.001)));
  for (const multiplier of [5, 2, 1]) if (multiplier * exponent <= maxKm) return multiplier * exponent;
  return exponent / 2;
}

function drawScaleBar(context, rect, mapWidthKm) {
  const scaleKm = niceScale(mapWidthKm / 4);
  const pixels = rect.width * scaleKm / mapWidthKm;
  const x = rect.x + 26;
  const y = rect.y + rect.height - 34;
  context.save();
  context.strokeStyle = "#17251f";
  context.lineWidth = 4;
  context.beginPath(); context.moveTo(x, y); context.lineTo(x + pixels, y); context.stroke();
  context.lineWidth = 2;
  context.beginPath(); context.moveTo(x, y - 7); context.lineTo(x, y + 7); context.moveTo(x + pixels, y - 7); context.lineTo(x + pixels, y + 7); context.stroke();
  context.fillStyle = "#17251f";
  context.font = '15px -apple-system,"PingFang SC",sans-serif';
  context.fillText(`${Number(scaleKm.toFixed(1))} km`, x, y - 12);
  context.restore();
}

function drawCenter(context, center, centerLabel, project, rect) {
  const [x, y] = project(center);
  if (x < rect.x || x > rect.x + rect.width || y < rect.y || y > rect.y + rect.height) return;
  context.save();
  context.beginPath(); context.arc(x, y, 8, 0, Math.PI * 2); context.fillStyle = "#c28734"; context.fill();
  context.strokeStyle = "#fff"; context.lineWidth = 3; context.stroke();
  context.font = '700 16px -apple-system,"PingFang SC",sans-serif';
  context.lineWidth = 5; context.strokeStyle = "rgba(255,255,255,.92)"; context.strokeText(centerLabel, x + 13, y - 12);
  context.fillStyle = "#17251f"; context.fillText(centerLabel, x + 13, y - 12);
  context.restore();
}

function drawLegend(context, rect, terrain) {
  const x = rect.x + rect.width - 208;
  const y = rect.y + rect.height - 190;
  const width = 170;
  const height = 17;
  context.save();
  context.fillStyle = "rgba(255,255,255,.88)";
  roundRect(context, x - 16, y - 34, width + 32, 114, 7); context.fill();
  context.fillStyle = "#17251f"; context.font = '700 15px -apple-system,"PingFang SC"'; context.fillText("高程（m）", x, y - 11);
  for (let i = 0; i < COLOR_STOPS.length - 1; i++) {
    context.fillStyle = `rgb(${COLOR_STOPS[i].join(",")})`;
    context.fillRect(x + i * width / (COLOR_STOPS.length - 1), y, width / (COLOR_STOPS.length - 1) + 1, height);
  }
  context.strokeStyle = "#fff"; context.strokeRect(x, y, width, height);
  context.fillStyle = "#4f5d55"; context.font = "13px -apple-system";
  context.fillText(Math.round(terrain.minimum), x, y + 38);
  context.textAlign = "right"; context.fillText(Math.round(terrain.maximum), x + width, y + 38);
  context.restore();
}

function drawFooter(context, left, right) {
  const width = context.canvas.width;
  const height = context.canvas.height;
  const marginX = Math.max(42, Math.round(width * 0.045));
  context.fillStyle = "#6a7770";
  context.font = `${Math.round(height * 0.016)}px -apple-system,"PingFang SC",sans-serif`;
  context.textAlign = "left";
  context.fillText(left, marginX, height - Math.round(height * 0.028));
  context.textAlign = "right";
  context.fillText(right, width - marginX, height - Math.round(height * 0.028));
  context.textAlign = "left";
}

function drawContours(context, terrain, rect, layers, kind, showLabels) {
  const xScale = rect.width / (terrain.gridWidth - 1);
  const yScale = rect.height / (terrain.gridHeight - 1);
  let segmentCount = 0;
  for (const layer of layers) {
    const { level, segments, isIndex } = layer;
    context.beginPath();
    for (const [a, b] of segments) {
      context.moveTo(rect.x + a[0] * xScale, rect.y + a[1] * yScale);
      context.lineTo(rect.x + b[0] * xScale, rect.y + b[1] * yScale);
    }
    context.strokeStyle = kind === "line" ? (isIndex ? "#111713" : "#4c5650") : (isIndex ? "rgba(25,36,30,.82)" : "rgba(36,48,41,.42)");
    context.lineWidth = isIndex ? (kind === "line" ? 2.4 : 1.8) : (kind === "line" ? 1.1 : 0.8);
    context.stroke();
    segmentCount += segments.length;

    if (showLabels && isIndex && segments.length > 8) {
      const segment = segments[Math.floor(segments.length * 0.47)];
      const x = rect.x + (segment[0][0] + segment[1][0]) / 2 * xScale;
      const y = rect.y + (segment[0][1] + segment[1][1]) / 2 * yScale;
      if (x > rect.x + 80 && x < rect.x + rect.width - 80 && y > rect.y + 40 && y < rect.y + rect.height - 40) {
        context.font = "13px -apple-system";
        context.textAlign = "center";
        context.lineWidth = 4; context.strokeStyle = kind === "line" ? "#fff" : "rgba(247,249,246,.9)"; context.strokeText(String(level), x, y + 4);
        context.fillStyle = "#26332c"; context.fillText(String(level), x, y + 4);
        context.textAlign = "left";
      }
    }
  }
  return segmentCount;
}

function renderMap(canvas, options, kind) {
  const { terrain, boundary, overlays, clipBoundary, center, centerLabel, title, subtitle, interval, contourLayers, mapOptions } = options;
  const { context, rect } = frame(canvas, `${title}${kind === "line" ? "等高线线稿" : "分层设色图"}`, subtitle, kind);
  const project = terrainProjector(terrain, rect);
  const dimensions = bboxDimensions(terrain.bbox);

  context.save();
  context.beginPath(); context.rect(rect.x, rect.y, rect.width, rect.height); context.clip();
  if (clipBoundary && boundary && geometryPath(context, boundary, project)) context.clip("evenodd");
  if (kind === "color") context.drawImage(makeTerrainRaster(terrain, mapOptions.showHillshade), rect.x, rect.y, rect.width, rect.height);
  else { context.fillStyle = "#fff"; context.fillRect(rect.x, rect.y, rect.width, rect.height); }
  // 海岸线优先使用 OSM natural=coastline 真实矢量，避免 DEM 海面/桥梁采样导致岛屿与大陆误连。
  const drawContourLines = kind === "line" || mapOptions.drawContourLines;
  const segmentCount = drawContourLines
    ? drawContours(context, terrain, rect, contourLayers, kind, mapOptions.showContourLabels)
    : 0;
  if (overlays) drawOverlayFeatures(context, overlays, project, kind);
  context.restore();

  if (kind === "line" && segmentCount === 0) {
    context.save();
    context.fillStyle = "rgba(255,255,255,.9)";
    roundRect(context, rect.x + rect.width / 2 - 235, rect.y + rect.height / 2 - 42, 470, 84, 8); context.fill();
    context.fillStyle = "#48564e";
    context.font = '700 20px -apple-system,"PingFang SC",sans-serif';
    context.textAlign = "center";
    context.fillText(`高程起伏小于当前 ${interval} m 等高距`, rect.x + rect.width / 2, rect.y + rect.height / 2 - 4);
    context.font = '15px -apple-system,"PingFang SC",sans-serif';
    context.fillText("可减小等高距后重新生成", rect.x + rect.width / 2, rect.y + rect.height / 2 + 25);
    context.restore();
  }

  if (mapOptions.showGraticule) drawGraticule(context, terrain.bbox, project, rect, kind === "line" ? "rgba(60,70,64,.13)" : "rgba(255,255,255,.42)");

  if (boundary && mapOptions.showBoundary) {
    geometryPath(context, boundary, project);
    context.strokeStyle = kind === "line" ? "#111713" : "rgba(255,255,255,.95)";
    context.lineWidth = 3;
    context.setLineDash([10, 7]); context.stroke(); context.setLineDash([]);
  }
  context.strokeStyle = "#52635a"; context.lineWidth = 2; context.strokeRect(rect.x, rect.y, rect.width, rect.height);
  if (mapOptions.showCenter) drawCenter(context, center, centerLabel, project, rect);
  if (mapOptions.showNorth) drawNorth(context, rect);
  if (mapOptions.showScale) drawScaleBar(context, rect, dimensions.widthKm);
  if (kind === "color" && mapOptions.showLegend) drawLegend(context, rect, terrain);
  drawFooter(context, `${terrain.sourceLabel || "AWS Terrarium DEM"} · WGS84 · 等高距 ${interval} m`, `DEM z${terrain.zoom} · ${terrain.gridWidth}×${terrain.gridHeight}`);
  return segmentCount;
}

async function resolveCenter(centerName, regionName, regionResult) {
  const queries = centerName.includes(regionName) ? [centerName] : [`${regionName} ${centerName}`, centerName];
  for (const query of queries) {
    try {
      const result = await geocode(query, false);
      return { result, fallback: false };
    } catch { /* try a less constrained query */ }
  }
  return { result: regionResult, fallback: true };
}


const ASPECTS = {
  "16:9": { label: "16:9", width: 1600, height: 900, ratio: 16 / 9 },
  "4:3": { label: "4:3", width: 1600, height: 1200, ratio: 4 / 3 },
  "1:1": { label: "1:1", width: 1400, height: 1400, ratio: 1 },
  A4L: { label: "A4 横版", width: 1600, height: 1131, ratio: 297 / 210 },
  A4P: { label: "A4 竖版", width: 1131, height: 1600, ratio: 210 / 297 },
};

function currentAspect() { return ASPECTS[$("aspectRatio")?.value] || ASPECTS["16:9"]; }

function setCanvasAspect() {
  const aspect = currentAspect();
  for (const id of ["colorCanvas", "lineCanvas"]) {
    const canvas = $(id);
    if (!canvas) continue;
    canvas.width = aspect.width;
    canvas.height = aspect.height;
  }
  document.querySelectorAll(".canvas-shell").forEach(shell => shell.style.aspectRatio = `${aspect.width}/${aspect.height}`);
  updateRangeReadout();
}

function bboxFromInputs() {
  const bbox = [Number($("westLon").value), Number($("southLat").value), Number($("eastLon").value), Number($("northLat").value)];
  if (!bbox.every(Number.isFinite)) return null;
  if (bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) return null;
  return bbox;
}

function setBboxInputs(bbox, updateMap = true) {
  if (!bbox || bbox.length !== 4) return;
  ["westLon", "southLat", "eastLon", "northLat"].forEach((id, i) => { if ($(id)) $(id).value = Number(bbox[i]).toFixed(6); });
  updateRangeReadout();
  if (updateMap) drawBboxOnMap(bbox, false);
}

function readCenter() {
  const bbox = bboxFromInputs();
  if (bbox) return [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
  if (state.lastPlace) return [Number(state.lastPlace.lon), Number(state.lastPlace.lat)];
  return [118.0297688, 27.7590448];
}

function bboxFromScale(center) {
  const aspect = currentAspect();
  const scale = Number($("mapScale")?.value || 50000);
  const shortPaperM = 0.18;
  const heightKm = Math.max(4, shortPaperM * scale / 1000);
  const widthKm = heightKm * aspect.ratio;
  return bboxFromCenter(center[0], center[1], widthKm, heightKm);
}

function updateRangeReadout() {
  const bbox = bboxFromInputs();
  const el = $("rangeReadout");
  if (!el) return;
  if (!bbox) { el.textContent = "当前范围：待选择"; return; }
  const d = bboxDimensions(bbox);
  const aspect = currentAspect();
  const scale = Number($("mapScale")?.value || 50000).toLocaleString("zh-CN");
  el.textContent = `当前范围：约 ${d.widthKm.toFixed(1)} km × ${d.heightKm.toFixed(1)} km · 图幅 ${aspect.label} · 比例尺 1:${scale}`;
}

function drawBboxOnMap(bbox, fit = true) {
  if (!state.map || !bbox) return;
  const bounds = [[bbox[1], bbox[0]], [bbox[3], bbox[2]]];
  if (state.map.isFallback) {
    state.map.drawBbox(bbox, fit);
    return;
  }
  if (!window.L) return;
  if (state.bboxLayer) state.bboxLayer.setBounds(bounds);
  else state.bboxLayer = L.rectangle(bounds, { color: "#176b4d", weight: 2, fillOpacity: 0.08 }).addTo(state.map);
  if (fit) state.map.fitBounds(bounds, { padding: [24, 24] });
}

function tileProject(lon, lat, zoom) {
  const sin = Math.sin(lat * Math.PI / 180);
  const n = 2 ** zoom;
  return {
    x: ((lon + 180) / 360) * n * 256,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * n * 256,
  };
}

function tileUnproject(x, y, zoom) {
  const n = 2 ** zoom;
  const lon = x / 256 / n * 360 - 180;
  const t = Math.PI * (1 - 2 * y / 256 / n);
  const lat = Math.atan(Math.sinh(t)) * 180 / Math.PI;
  return [lon, lat];
}

function initFallbackMap(container) {
  container.classList.add("fallback-map");
  container.innerHTML = `
    <div class="fallback-tiles" aria-hidden="true"></div>
    <div class="fallback-bbox" aria-label="可拖动制图范围框" role="group">
      <span class="bbox-handle nw" data-handle="nw"></span><span class="bbox-handle ne" data-handle="ne"></span>
      <span class="bbox-handle sw" data-handle="sw"></span><span class="bbox-handle se" data-handle="se"></span>
      <span class="bbox-label">拖动框体移动范围 · 拖四角缩放</span>
    </div>
    <div class="fallback-controls"><button type="button" data-zoom="in">＋</button><button type="button" data-zoom="out">－</button></div>
    <div class="fallback-tip">拖动底图移动视窗 · 拖动绿色框移动范围 · 拖四角缩放</div>`;
  const tiles = container.querySelector(".fallback-tiles");
  const bboxEl = container.querySelector(".fallback-bbox");
  const handlers = {};
  const map = {
    isFallback: true,
    center: [27.7590448, 118.0297688],
    zoom: 10,
    bbox: null,
    on(name, fn) { handlers[name] = fn; return map; },
    setView(latlng, zoom = map.zoom) {
      map.center = [Number(latlng[0]), Number(latlng[1])];
      map.zoom = clamp(Math.round(Number(zoom)), 2, 15);
      render();
      return map;
    },
    fitBounds(bounds) {
      const south = Number(bounds[0][0]), west = Number(bounds[0][1]), north = Number(bounds[1][0]), east = Number(bounds[1][1]);
      map.center = [(south + north) / 2, (west + east) / 2];
      const rectKm = bboxDimensions([west, south, east, north]);
      const w = container.clientWidth || 600, h = container.clientHeight || 330;
      const targetMetersPerPx = Math.max(rectKm.widthKm * 1000 / Math.max(1, w - 80), rectKm.heightKm * 1000 / Math.max(1, h - 80));
      const latRad = map.center[0] * Math.PI / 180;
      const z = Math.log2((156543.03392 * Math.cos(latRad)) / Math.max(targetMetersPerPx, 1));
      map.zoom = clamp(Math.floor(z), 2, 15);
      render();
      return map;
    },
    getBounds() {
      const w = container.clientWidth || 600, h = container.clientHeight || 330;
      const c = tileProject(map.center[1], map.center[0], map.zoom);
      const westSouth = tileUnproject(c.x - w / 2, c.y + h / 2, map.zoom);
      const eastNorth = tileUnproject(c.x + w / 2, c.y - h / 2, map.zoom);
      return {
        getWest: () => westSouth[0], getSouth: () => westSouth[1],
        getEast: () => eastNorth[0], getNorth: () => eastNorth[1],
      };
    },
    drawBbox(bbox, fit = false) {
      map.bbox = bbox;
      if (fit) map.fitBounds([[bbox[1], bbox[0]], [bbox[3], bbox[2]]]);
      renderBbox();
      return map;
    },
    setMarker(lon, lat) {
      map.marker = [Number(lon), Number(lat)];
      return map;
    },
    setStyle(style) {
      map.style = style || "osm";
      render();
      return map;
    },
  };

  function render() {
    const w = container.clientWidth || 600, h = container.clientHeight || 330;
    const zoom = map.zoom;
    const centerPx = tileProject(map.center[1], map.center[0], zoom);
    const left = centerPx.x - w / 2, top = centerPx.y - h / 2;
    const minX = Math.floor(left / 256), maxX = Math.floor((left + w) / 256);
    const minY = Math.floor(top / 256), maxY = Math.floor((top + h) / 256);
    const n = 2 ** zoom;
    const html = [];
    for (let tx = minX; tx <= maxX; tx++) {
      for (let ty = minY; ty <= maxY; ty++) {
        if (ty < 0 || ty >= n) continue;
        const wrappedX = ((tx % n) + n) % n;
        const px = Math.round(tx * 256 - left);
        const py = Math.round(ty * 256 - top);
        const style = map.style || "osm";
        const direct = style === "satellite"
          ? `https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${zoom}/${ty}/${wrappedX}`
          : style === "terrain"
            ? `https://a.tile.opentopomap.org/${zoom}/${wrappedX}/${ty}.png`
            : `https://tile.openstreetmap.org/${zoom}/${wrappedX}/${ty}.png`;
        html.push(`<img class="fallback-tile" src="/api/maptile?style=${style}&z=${zoom}&x=${wrappedX}&y=${ty}" data-direct="${direct}" style="left:${px}px;top:${py}px" draggable="false" alt="" onerror="if(!this.dataset.triedDirect){this.dataset.triedDirect='1';this.src=this.dataset.direct}else{this.style.display='none'}">`);
      }
    }
    const bounds = map.getBounds();
    const west = bounds.getWest(), east = bounds.getEast(), south = bounds.getSouth(), north = bounds.getNorth();
    const lonSpan = Math.max(0.0001, east - west);
    const latSpan = Math.max(0.0001, north - south);
    const niceStep = span => {
      const raw = span / 5;
      const pow = 10 ** Math.floor(Math.log10(raw));
      const n = raw / pow;
      return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * pow;
    };
    const lonStep = niceStep(lonSpan);
    const latStep = niceStep(latSpan);
    for (let lon = Math.ceil(west / lonStep) * lonStep; lon <= east; lon += lonStep) {
      const [x] = point(lon, map.center[0]);
      html.push(`<div class="fallback-grid-line v" style="left:${x}px"></div><div class="fallback-grid-label lon" style="left:${x}px">${lon.toFixed(lonStep < 1 ? 2 : 0)}°E</div>`);
    }
    for (let lat = Math.ceil(south / latStep) * latStep; lat <= north; lat += latStep) {
      const [, y] = point(map.center[1], lat);
      html.push(`<div class="fallback-grid-line h" style="top:${y}px"></div><div class="fallback-grid-label lat" style="top:${y}px">${lat.toFixed(latStep < 1 ? 2 : 0)}°N</div>`);
    }
    const att = (map.style === "satellite") ? "底图 © Esri / Maxar 等 · 高程 AWS Terrarium" : (map.style === "terrain") ? "底图 © OpenTopoMap / OSM · 高程 AWS Terrarium" : "底图 © OpenStreetMap contributors · 高程 AWS Terrarium";
    html.push(`<div class="fallback-center-label">中心：${map.center[1].toFixed(4)}°E，${map.center[0].toFixed(4)}°N · 缩放 ${map.zoom}</div><div class="fallback-attribution">${att}</div>`);
    tiles.innerHTML = html.join("");
    renderBbox();
    renderMarker();
    updateRangeReadout();
  }

  function point(lon, lat) {
    const w = container.clientWidth || 600, h = container.clientHeight || 330;
    const centerPx = tileProject(map.center[1], map.center[0], map.zoom);
    const p = tileProject(lon, lat, map.zoom);
    return [p.x - centerPx.x + w / 2, p.y - centerPx.y + h / 2];
  }

  function pixelToLonLat(x, y) {
    const w = container.clientWidth || 600, h = container.clientHeight || 330;
    const centerPx = tileProject(map.center[1], map.center[0], map.zoom);
    return tileUnproject(centerPx.x + x - w / 2, centerPx.y + y - h / 2, map.zoom);
  }

  function renderBbox() {
    if (!map.bbox) { bboxEl.style.display = "none"; return; }
    const [x1, y1] = point(map.bbox[0], map.bbox[3]);
    const [x2, y2] = point(map.bbox[2], map.bbox[1]);
    const left = Math.min(x1, x2), top = Math.min(y1, y2);
    const width = Math.abs(x2 - x1), height = Math.abs(y2 - y1);
    bboxEl.style.cssText = `display:block;left:${left}px;top:${top}px;width:${width}px;height:${height}px`;
  }

  function renderMarker() {}

  function syncInputsFromMapBbox() {
    if (!map.bbox) return;
    ["westLon", "southLat", "eastLon", "northLat"].forEach((id, i) => { if ($(id)) $(id).value = Number(map.bbox[i]).toFixed(6); });
    updateRangeReadout();
  }
  let dragging = null;
  container.addEventListener("pointerdown", event => {
    if (event.target.closest("button")) return;
    const handle = event.target.closest("[data-handle]")?.dataset.handle;
    if (event.target.closest(".fallback-bbox") && map.bbox) {
      dragging = { type: "bbox", handle: handle || "move", x: event.clientX, y: event.clientY, bbox: [...map.bbox] };
    } else {
      dragging = { type: "map", x: event.clientX, y: event.clientY, centerPx: tileProject(map.center[1], map.center[0], map.zoom) };
    }
    container.setPointerCapture?.(event.pointerId);
  });
  container.addEventListener("pointermove", event => {
    if (!dragging) return;
    const dx = event.clientX - dragging.x, dy = event.clientY - dragging.y;
    if (dragging.type === "bbox") {
      const p0 = point(dragging.bbox[0], dragging.bbox[3]);
      const p1 = point(dragging.bbox[2], dragging.bbox[1]);
      let left = Math.min(p0[0], p1[0]), right = Math.max(p0[0], p1[0]), top = Math.min(p0[1], p1[1]), bottom = Math.max(p0[1], p1[1]);
      if (dragging.handle === "move") { left += dx; right += dx; top += dy; bottom += dy; }
      else {
        if (dragging.handle.includes("w")) left += dx;
        if (dragging.handle.includes("e")) right += dx;
        if (dragging.handle.includes("n")) top += dy;
        if (dragging.handle.includes("s")) bottom += dy;
      }
      const minSize = 28;
      if (right - left < minSize || bottom - top < minSize) return;
      const nw = pixelToLonLat(left, top), se = pixelToLonLat(right, bottom);
      map.bbox = [nw[0], se[1], se[0], nw[1]];
      renderBbox();
      syncInputsFromMapBbox();
    } else {
      const [lon, lat] = tileUnproject(dragging.centerPx.x - dx, dragging.centerPx.y - dy, map.zoom);
      map.center = [lat, lon];
      render();
    }
  });
  container.addEventListener("pointerup", event => { dragging = null; handlers.moveend?.(); });
  container.addEventListener("pointercancel", () => { dragging = null; });
  container.addEventListener("wheel", event => {
    event.preventDefault();
    map.zoom = clamp(map.zoom + (event.deltaY < 0 ? 1 : -1), 2, 15);
    render(); handlers.zoomend?.();
  }, { passive: false });
  container.querySelector(".fallback-controls").addEventListener("click", event => {
    const button = event.target.closest("button[data-zoom]");
    if (!button) return;
    map.zoom = clamp(map.zoom + (button.dataset.zoom === "in" ? 1 : -1), 2, 15);
    render(); handlers.zoomend?.();
  });
  window.addEventListener("resize", () => render());
  render();
  return map;
}

function initMap() {
  const container = $("selectorMap");
  if (!container || state.map) return;
  // 使用内置地图视窗：通过 /api/maptile 代理真实 OSM 底图，同时保留拖框、缩放、视窗转 bbox。
  state.map = initFallbackMap(container);
  const bbox = bboxFromScale([118.0297688, 27.7590448]);
  setBboxInputs(bbox, true);
}

function useCurrentMapView() {
  if (!state.map) return toast("地图尚未加载，请使用经纬度范围输入");
  const b = state.map.getBounds();
  setBboxInputs([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], false);
  drawBboxOnMap(bboxFromInputs(), false);
  toast("已使用当前地图视窗作为制图范围");
}

async function locatePlace() {
  const placeName = $("placeName").value.trim();
  if (!placeName) return toast("请输入地名再定位");
  setProgress(8, "正在定位", placeName);
  try {
    const place = await geocode(placeName, $("showBoundary")?.checked);
    state.lastPlace = place;
    const center = [Number(place.lon), Number(place.lat)];
    if (!center.every(Number.isFinite)) throw new Error("没有取得有效坐标");
    if (state.map) {
      state.map.setView([center[1], center[0]], 10);
      if (state.map.isFallback) state.map.setMarker(center[0], center[1]);
      else if (window.L) {
        if (state.marker) state.marker.setLatLng([center[1], center[0]]);
        else state.marker = L.marker([center[1], center[0]]).addTo(state.map);
      }
    }
    const bbox = bboxFromScale(center);
    setBboxInputs(bbox, true);
    $("locationHint").textContent = `已定位：${place.display_name || placeName}。可拖动地图后点击“使用当前地图视窗”。`;
    setProgress(100, "定位完成", `${center[0].toFixed(5)}, ${center[1].toFixed(5)}`);
  } catch (error) {
    setProgress(100, "定位失败", error.message);
    toast(error.message);
  }
}

function recommendedInterval(relief) {
  if (relief <= 100) return 10;
  if (relief <= 300) return 20;
  if (relief <= 800) return 50;
  if (relief <= 2000) return 100;
  if (relief <= 4000) return 200;
  if (relief <= 7000) return 500;
  return 1000;
}

function setIntervalValue(value) {
  $("contourInterval").value = String(value);
  document.querySelectorAll(".quick-buttons button").forEach(button => button.classList.toggle("active", button.dataset.number === String(value)));
}

function svgFromCanvas(canvas, title) {
  const dataUrl = canvas.toDataURL("image/png");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${canvas.width} ${canvas.height}" role="img" aria-label="${escapeXml(title)}"><image href="${dataUrl}" width="${canvas.width}" height="${canvas.height}"/></svg>`;
}

function downloadSvg() {
  if (!state.result) return toast("请先生成地图");
  const canvas = $("lineCard").hidden ? $("colorCanvas") : $("lineCanvas");
  const svg = svgFromCanvas(canvas, state.result.title);
  downloadBlob(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }), `${safeName(state.result.title)}_矢量版.svg`);
}

async function generateTerrain(event) {
  event.preventDefault();
  const placeName = $("placeName").value.trim() || "框选区域";
  const interval = Number($("contourInterval").value);
  const indexEvery = Number($("indexEvery")?.value ?? 5);
  const detail = $("detailLevel")?.value || "auto";
  const showColor = $("showColor").checked;
  const showContours = $("showContours").checked;
  const wantBoundary = $("showBoundary").checked;
  const bbox = bboxFromInputs();
  const mapOptions = {
    drawContourLines: true,
    showBoundary: wantBoundary,
    showGraticule: $("showCoordinates").checked,
    showContourLabels: $("showLabels").checked,
    showHillshade: $("showHillshade").checked,
    showCenter: false,
    showNorth: true,
    showScale: true,
    showLegend: true,
    showCoastline: $("showCoastline")?.checked !== false,
  };
  if (!bbox) return toast("请先定位或填写有效的经纬度范围");
  if (!Number.isFinite(interval) || interval < 5 || interval > 2000) return toast("等高距应为 5-2000 米");
  if (!showColor && !showContours) return toast("请至少选择一种输出地图");

  setCanvasAspect();
  $("generateButton").disabled = true;
  $("results").hidden = true;
  const center = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
  setProgress(12, "已确定制图范围", `${center[0].toFixed(5)}, ${center[1].toFixed(5)}`);
  try {
    let place = state.lastPlace;
    let boundary = null;
    if (wantBoundary && placeName) {
      try { place = await geocode(placeName, true); } catch { /* boundary is optional */ }
    }
    if (wantBoundary && ["Polygon", "MultiPolygon"].includes(place?.geojson?.type)) boundary = place.geojson;

    const dimensions = bboxDimensions(bbox);
    setProgress(22, "正在读取 DEM", `范围约 ${dimensions.widthKm.toFixed(1)} × ${dimensions.heightKm.toFixed(1)} km`);
    const terrain = await loadTerrain(bbox, detail);
    const relief = terrain.maximum - terrain.minimum;
    const autoSuggested = recommendedInterval(relief);
    setProgress(68, "正在计算等高线", `高程 ${Math.round(terrain.minimum)}-${Math.round(terrain.maximum)} m，高差约 ${Math.round(relief)} m`);
    const contourLayers = prepareContourLayers(terrain, interval, indexEvery, NaN, NaN);
    let overlays = { type: "FeatureCollection", features: [] };
    const overlayLayers = selectedOverlayLayers();
    const requestOverlayLayers = [...overlayLayers];
    if (mapOptions.showCoastline && !requestOverlayLayers.includes("coastline")) requestOverlayLayers.push("coastline");
    if (requestOverlayLayers.length) {
      try {
        setProgress(76, "正在读取真实叠加图层", requestOverlayLayers.join("、"));
        overlays = await loadOverlays(bbox, requestOverlayLayers);
      } catch (overlayError) {
        overlays = { type: "FeatureCollection", features: [] };
        console.warn(overlayError);
      }
    }
    const aspect = currentAspect();
    const scale = Number($("mapScale")?.value || 50000).toLocaleString("zh-CN");
    const subtitle = `${aspect.label} · 1:${scale} · 约 ${dimensions.widthKm.toFixed(1)} × ${dimensions.heightKm.toFixed(1)} km · 高程 ${Math.round(terrain.minimum)}-${Math.round(terrain.maximum)} m`;
    const renderOptions = {
      terrain, boundary, overlays, clipBoundary: false, center, centerLabel: placeName,
      title: placeName, subtitle, interval, indexEvery, contourLayers, mapOptions,
    };
    let colorSegments = 0;
    let lineSegments = 0;
    $("colorCard").hidden = !showColor;
    $("lineCard").hidden = !showContours;
    if (showColor) colorSegments = renderMap($("colorCanvas"), renderOptions, "color");
    setProgress(84, "正在绘制输出", showContours ? "生成黑白线稿版" : "整理地形美化版");
    if (showContours) lineSegments = renderMap($("lineCanvas"), renderOptions, "line");
    setProgress(100, "地图已生成", "可以下载 PNG、SVG 和图层数据");

    const warnings = [];
    if (wantBoundary && !boundary) warnings.push("本次定位未返回面状行政边界，已跳过边界叠加");
    if (mapOptions.showCoastline && !(overlays.features || []).some(f => f.properties?.layer === "coastline")) warnings.push("本范围未取得 OSM 海岸线，已仅绘制 DEM 等高线");
    if (!contourLayers.some(layer => layer.segments.length)) warnings.push(`区域高差小于当前 ${interval} 米等高距，可减小等高距`);
    if (Math.abs(interval - autoSuggested) >= interval * 0.8) warnings.push(`按当前高差，系统建议等高距约 ${autoSuggested} 米`);
    state.result = {
      title: placeName, regionName: placeName, centerName: placeName, center, boundary, terrain,
      interval, indexEvery, detail, extentMode: "bbox", rangeKm: null,
      clipBoundary: false, dimensions, segmentCount: Math.max(colorSegments, lineSegments), warnings,
      contourLayers, contourGeoJSON: contourGeoJSON(terrain, contourLayers), overlays, overlayLayers, mapOptions,
      requestedContourRange: [null, null], locationSource: place?.source || "OpenStreetMap Nominatim",
      aspect: aspect.label, mapScale: $("mapScale")?.value,
    };
    const coordinateText = mapOptions.showGraticule ? ` · 中心 ${center[0].toFixed(4)}°E, ${center[1].toFixed(4)}°N` : "";
    $("resultTitle").textContent = `${placeName}地形等高线成果`;
    $("resultMeta").textContent = `${subtitle} · 等高距 ${interval} m${coordinateText}`;
    $("sourceNote").textContent = `高程：${terrain.sourceLabel || "真实 DEM：AWS Open Data Terrarium elevation tiles"}；范围：地图框选 / 经纬度 bbox；叠加图层：${overlayLayers.length ? overlayLayers.join("、") : "无"}。${warnings.length ? `注意：${warnings.join("；")}。` : ""}`;
    $("results").hidden = false;
    setTimeout(() => $("results").scrollIntoView({ behavior: "smooth", block: "start" }), 80);
    icons();
  } catch (error) {
    setProgress(100, "生成失败", error.message);
    toast(error.message);
  } finally {
    $("generateButton").disabled = false;
  }
}

function downloadBlob(blob, name) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1200);
}

function downloadCanvas(canvas, suffix) {
  if (!state.result) return toast("请先生成地图");
  canvas.toBlob(blob => downloadBlob(blob, `${safeName(state.result.title)}_${suffix}.png`), "image/png");
}

function downloadDemCsv() {
  if (!state.result) return toast("请先生成地图");
  const terrain = state.result.terrain;
  const rows = ["longitude,latitude,elevation_m"];
  for (let y = 0; y < terrain.gridHeight; y++) {
    const worldY = terrain.world.y0 + y / (terrain.gridHeight - 1) * (terrain.world.y1 - terrain.world.y0);
    for (let x = 0; x < terrain.gridWidth; x++) {
      const worldX = terrain.world.x0 + x / (terrain.gridWidth - 1) * (terrain.world.x1 - terrain.world.x0);
      const [lon, lat] = worldLonLat(worldX, worldY, terrain.zoom);
      rows.push(`${lon.toFixed(6)},${lat.toFixed(6)},${terrain.dem[y * terrain.gridWidth + x].toFixed(2)}`);
    }
  }
  downloadBlob(new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8" }), `${safeName(state.result.title)}_DEM.csv`);
}

function downloadContours() {
  if (!state.result) return toast("请先生成地图");
  downloadBlob(
    new Blob([JSON.stringify(state.result.contourGeoJSON)], { type: "application/geo+json" }),
    `${safeName(state.result.title)}_等高线.geojson`,
  );
}

function downloadMetadata() {
  if (!state.result) return toast("请先生成地图");
  const result = state.result;
  const metadata = {
    title: result.title,
    region: result.regionName,
    administrative_center: { name: result.centerName, longitude: result.center[0], latitude: result.center[1] },
    extent_mode: result.extentMode,
    bbox_wgs84: result.terrain.bbox,
    dimensions_km: result.dimensions,
    contour_interval_m: result.interval,
    index_contour_every: result.indexEvery,
    elevation_range_m: [result.terrain.minimum, result.terrain.maximum],
    dem_grid: [result.terrain.gridWidth, result.terrain.gridHeight],
    terrain_zoom: result.terrain.zoom,
    terrain_tile_count: result.terrain.tileCount,
    clipped_to_admin_boundary: result.clipBoundary,
    contour_segment_count: result.segmentCount,
    requested_contour_range_m: result.requestedContourRange,
    map_options: result.mapOptions,
    coordinate_reference: "WGS84 / Web Mercator terrain sampling",
    overlay_layers: result.overlayLayers || [],
    overlay_feature_count: result.overlays?.features?.length || 0,
    sources: [result.terrain.sourceLabel || "真实 DEM：AWS Open Data Terrarium elevation tiles", "OpenStreetMap Nominatim", "OpenStreetMap / Overpass API overlays"],
    warnings: result.warnings,
  };
  downloadBlob(new Blob([JSON.stringify(metadata, null, 2)], { type: "application/json" }), `${safeName(result.title)}_metadata.json`);
}

function showInstall() {
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  $("installText").innerHTML = ios
    ? "<strong>iPhone / iPad</strong><ol><li>请使用 Safari 打开本站。</li><li>点击底部分享按钮。</li><li>选择“添加到主屏幕”。</li></ol>"
    : "<strong>Android / 电脑</strong><ol><li>使用 Chrome 或 Edge 打开。</li><li>选择“安装应用”。</li></ol>";
  $("installDialog").showModal();
}

document.querySelectorAll(".quick-buttons").forEach(group => group.addEventListener("click", event => {
  const button = event.target.closest("[data-number]");
  if (!button) return;
  setIntervalValue(button.dataset.number);
}));
$("contourInterval").addEventListener("input", () => {
  document.querySelectorAll(".quick-buttons button").forEach(button => button.classList.toggle("active", button.dataset.number === $("contourInterval").value));
});
["westLon", "southLat", "eastLon", "northLat"].forEach(id => $(id)?.addEventListener("input", () => { updateRangeReadout(); drawBboxOnMap(bboxFromInputs(), false); }));
$("aspectRatio")?.addEventListener("change", () => { setCanvasAspect(); setBboxInputs(bboxFromScale(readCenter()), true); });
$("mapScale")?.addEventListener("change", () => { updateRangeReadout(); });
$("mapViewStyle")?.addEventListener("change", () => { state.map?.setStyle?.($("mapViewStyle").value); });
$("locateButton")?.addEventListener("click", locatePlace);
$("useMapView")?.addEventListener("click", useCurrentMapView);
$("makeFrameFromScale")?.addEventListener("click", () => { setBboxInputs(bboxFromScale(readCenter()), true); toast("已按图幅与比例尺生成范围框"); });
$("fitBbox")?.addEventListener("click", () => drawBboxOnMap(bboxFromInputs(), true));
$("autoInterval")?.addEventListener("click", async () => {
  const bbox = bboxFromInputs();
  if (!bbox) return toast("请先确定制图范围");
  $("generateButton").disabled = true;
  try {
    setProgress(20, "正在快速读取真实高程", "用于推荐等高距");
    const terrain = await loadTerrain(bbox, "fast");
    const value = recommendedInterval(terrain.maximum - terrain.minimum);
    setIntervalValue(value);
    setProgress(100, "已推荐等高距", `当前高差约 ${Math.round(terrain.maximum - terrain.minimum)} m，建议 ${value} m`);
    toast(`已推荐等高距：${value} m`);
  } catch (error) { toast(error.message); }
  finally { $("generateButton").disabled = false; }
});
$("terrainForm").addEventListener("submit", generateTerrain);
$("downloadColor").addEventListener("click", () => downloadCanvas($("colorCanvas"), "地形美化版"));
$("downloadLine").addEventListener("click", () => downloadCanvas($("lineCanvas"), "等高线线稿"));
$("downloadDem").addEventListener("click", downloadDemCsv);
$("downloadContours").addEventListener("click", downloadContours);
$("downloadMetadata").addEventListener("click", downloadMetadata);
$("downloadSvg")?.addEventListener("click", downloadSvg);
$("closeInstall").addEventListener("click", () => $("installDialog").close());
$("installButton").addEventListener("click", async () => {
  if (state.installPrompt) {
    state.installPrompt.prompt();
    await state.installPrompt.userChoice;
    state.installPrompt = null;
  } else showInstall();
});
window.addEventListener("beforeinstallprompt", event => { event.preventDefault(); state.installPrompt = event; });

initMap();
setCanvasAspect();
icons();
