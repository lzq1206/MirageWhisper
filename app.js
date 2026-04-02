const CITY_LIST_URL = './data/cities.json';
const LEVELS = [1000, 925, 850, 700, 600, 500];
const GFS_URL = 'https://api.open-meteo.com/v1/gfs';
const MARINE_URL = 'https://marine-api.open-meteo.com/v1/marine';
const CITY_CONCURRENCY = 6;

const citySelect = document.getElementById('citySelect');
const eventTypeSelect = document.getElementById('eventType');
const refreshBtn = document.getElementById('refreshBtn');
const statusEl = document.getElementById('status');
const summaryEl = document.getElementById('summary');
const cityTitleEl = document.getElementById('cityTitle');
const cityMetaEl = document.getElementById('cityMeta');
const dailyCardsEl = document.getElementById('dailyCards');
const rankingEl = document.getElementById('ranking');

let cityCatalog = [];
let displayCatalog = [];
let allCityData = [];

function fmt(n, d = 1) {
  if (n == null || Number.isNaN(n)) return '-';
  return Number(n).toFixed(d);
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function levelLabel(score) {
  if (score >= 70) return { text: '高', cls: 'lv-high' };
  if (score >= 40) return { text: '中', cls: 'lv-mid' };
  return { text: '低', cls: 'lv-low' };
}

function nearestIndex(times, targetIso) {
  const t = new Date(targetIso).getTime();
  let best = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < times.length; i += 1) {
    const diff = Math.abs(new Date(times[i]).getTime() - t);
    if (diff < bestDiff) {
      best = i;
      bestDiff = diff;
    }
  }
  return best;
}

function average(arr) {
  const vals = arr.filter((x) => Number.isFinite(x));
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

function pressureToAltitudeM(p) {
  return 44330 * (1 - Math.pow(p / 1013.25, 0.1903));
}

function gradientCPerKm(t1, t2, p1, p2) {
  const z1 = pressureToAltitudeM(p1);
  const z2 = pressureToAltitudeM(p2);
  const dz = z2 - z1;
  if (dz <= 1) return null;
  return ((t2 - t1) / dz) * 1000;
}

function detectInversionSegments(tempByLevel) {
  const segments = [];
  for (let i = 1; i < LEVELS.length - 1; i += 1) {
    const pPrev = LEVELS[i - 1];
    const pMid = LEVELS[i];
    const pNext = LEVELS[i + 1];
    const tPrev = tempByLevel[pPrev];
    const tMid = tempByLevel[pMid];
    const tNext = tempByLevel[pNext];
    if (tPrev == null || tMid == null || tNext == null) continue;

    const upGrad = gradientCPerKm(tPrev, tMid, pPrev, pMid);
    const downGrad = gradientCPerKm(tMid, tNext, pMid, pNext);

    // 口径：必须形成低温-高温-低温的夹层峰值，才算逆温层。
    if (upGrad != null && downGrad != null && upGrad > 0 && downGrad < 0) {
      const baseM = pressureToAltitudeM(pPrev);
      const peakM = pressureToAltitudeM(pMid);
      const topM = pressureToAltitudeM(pNext);
      const centerDiffCPerKm = (upGrad + Math.abs(downGrad)) / 2;
      segments.push({
        baseM,
        peakM,
        topM,
        thicknessM: topM - baseM,
        strengthCPerKm: Math.max(upGrad, Math.abs(downGrad)),
        centerDiffCPerKm,
        lowLevel: baseM <= 1500,
      });
    }
  }
  return segments;
}

function strongestSegment(segments, preferLow = false) {
  const pool = preferLow ? segments.filter((s) => s.lowLevel) : segments;
  const sorted = (pool.length ? pool : segments).slice().sort((a, b) => b.strengthCPerKm - a.strengthCPerKm || a.baseM - b.baseM);
  return sorted[0] || null;
}

function profileAtIndex(hourly, idx) {
  const tempByLevel = {};
  for (const lv of LEVELS) tempByLevel[lv] = hourly[`temperature_${lv}hPa`]?.[idx] ?? null;
  return {
    tempByLevel,
    cloudCover: hourly.cloud_cover?.[idx] ?? null,
    time: hourly.time?.[idx],
  };
}

function scanWindow(hourly, startTime, endTime) {
  const startIdx = nearestIndex(hourly.time, startTime);
  const endIdx = nearestIndex(hourly.time, endTime);
  const left = Math.min(startIdx, endIdx);
  const right = Math.max(startIdx, endIdx);
  const window = [];
  for (let i = left; i <= right; i += 1) window.push(i);

  const lowHits = [];
  const strengths = [];
  let best = null;
  for (const idx of window) {
    const prof = profileAtIndex(hourly, idx);
    const segments = detectInversionSegments(prof.tempByLevel);
    const lowBest = strongestSegment(segments, true);
    if (lowBest) {
      lowHits.push(lowBest);
      strengths.push(lowBest.strengthCPerKm);
      if (!best || lowBest.strengthCPerKm > best.strengthCPerKm) best = lowBest;
    }
  }

  const persistence = window.length ? lowHits.length / window.length : 0;
  const meanStrength = average(strengths);
  const lowestBase = lowHits.length ? Math.min(...lowHits.map((x) => x.baseM)) : null;
  return { best, persistence, meanStrength, lowestBase, hours: window.length };
}

function scoreDayMirage(dayWindow, seaContrast, seaTemp, isCoastal) {
  const centerDiff = clamp((dayWindow.best?.centerDiffCPerKm || 0) - 1.8, 0, 6) / 6;
  const lowBase = dayWindow.lowestBase == null ? 0 : clamp(1 - dayWindow.lowestBase / 1800, 0, 1);
  const persist = clamp((dayWindow.persistence || 0) - 0.15, 0, 0.75) / 0.75;
  const marineBoost = isCoastal ? clamp((seaContrast || 0) - 1.5, 0, 6) / 6 * 0.08 : 0;
  const seaWarmBoost = isCoastal && seaTemp != null ? clamp((seaTemp - 12) / 18, 0, 1) * 0.04 : 0;
  const raw = 0.58 * centerDiff + 0.22 * lowBase + 0.16 * persist + marineBoost + seaWarmBoost;
  return Math.round(clamp(raw * 100, 0, 100));
}

function scoreGreenFlash(inv, cloudCover, baseBias = 0) {
  const invPart = inv ? clamp(inv.strengthCPerKm / 10, 0, 1) : 0;
  const clearPart = clamp(1 - (cloudCover ?? 50) / 100, 0, 1);
  const lowBasePart = inv ? clamp(1 - inv.baseM / 1200, 0, 1) : 0;
  return Math.round(50 * invPart + 35 * clearPart + 15 * lowBasePart + baseBias);
}

function formatEventTime(iso) {
  return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function formatDateLabel(iso) {
  return new Date(iso).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit', weekday: 'short' });
}

function tempToColor(temp, minTemp, maxTemp) {
  if (temp == null || Number.isNaN(temp)) return 'rgba(80, 90, 110, 0.25)';
  const t = clamp((temp - minTemp) / Math.max(1e-6, maxTemp - minTemp), 0, 1);
  const hue = 240 - 240 * t; // blue -> red
  const light = 42 + 16 * (1 - Math.abs(t - 0.5) * 2);
  return `hsl(${hue.toFixed(1)} 90% ${light.toFixed(1)}%)`;
}

function buildDayProfileFromHourly(hourly, day) {
  const altitudes = LEVELS.map(pressureToAltitudeM);
  const hours = Array.from({ length: 24 }, (_, i) => i);
  const grid = altitudes.map(() => Array(24).fill(null));

  for (let h = 0; h < 24; h += 1) {
    const hourText = String(h).padStart(2, '0');
    const idx = (hourly.time || []).findIndex((t) => t.startsWith(day) && t.slice(11, 13) === hourText);
    if (idx < 0) continue;
    for (let li = 0; li < LEVELS.length; li += 1) {
      grid[li][h] = hourly[`temperature_${LEVELS[li]}hPa`]?.[idx] ?? null;
    }
  }

  const temps = grid.flat().filter((v) => Number.isFinite(v));
  return {
    day,
    hours,
    altitudes,
    grid,
    minTemp: temps.length ? Math.min(...temps) : null,
    maxTemp: temps.length ? Math.max(...temps) : null,
  };
}

function buildSyntheticDayProfile(city, day, baseM, topM, centerDiff, persistence) {
  const altitudes = LEVELS.map(pressureToAltitudeM);
  const hours = Array.from({ length: 24 }, (_, i) => i);
  const grid = altitudes.map(() => Array(24).fill(null));
  const latBias = clamp((city.lat - 20) / 20, 0, 1);
  const coastalBias = city.coastal ? 1 : 0;
  const seedBase = [...String(city.id), ...String(day)].reduce((acc, ch, idx) => acc + ch.charCodeAt(0) * (idx + 1), 0);

  for (let h = 0; h < 24; h += 1) {
    const diurnal = Math.cos(((h - 15) / 24) * Math.PI * 2) * (2.2 - latBias * 0.8);
    const surface = 21 - latBias * 8 + coastalBias * 1.2 + diurnal + (seededValue(seedBase + h * 7) - 0.5) * 0.8;
    const peakKm = ((baseM + topM) / 2) / 1000;
    const widthKm = Math.max(0.35, (topM - baseM) / 1000);
    for (let li = 0; li < altitudes.length; li += 1) {
      const altKm = altitudes[li] / 1000;
      const lapse = 5.8 + li * 0.7;
      const bump = centerDiff * Math.exp(-Math.pow((altKm - peakKm) / widthKm, 2));
      const coolTop = Math.max(0, altKm - peakKm) * (1.2 + latBias * 0.3);
      grid[li][h] = surface - lapse * altKm + bump - coolTop + persistence * 0.3;
    }
  }

  const temps = grid.flat().filter((v) => Number.isFinite(v));
  return {
    day,
    hours,
    altitudes,
    grid,
    minTemp: temps.length ? Math.min(...temps) : null,
    maxTemp: temps.length ? Math.max(...temps) : null,
  };
}

function renderTemperatureHeatmap(cityData) {
  const root = document.getElementById('temperatureHeatmap');
  const note = document.getElementById('heatmapMeta');
  if (!root || !cityData) return;

  const day = cityData.daily?.[0];
  const profile = day?.profile || null;
  if (!profile?.grid?.length) {
    root.innerHTML = '<div class="heatmap-empty">暂无剖面数据</div>';
    if (note) note.textContent = '当前城市没有可用的小时级分层温度数据。';
    return;
  }

  const width = 1040;
  const height = 560;
  const padL = 86;
  const padR = 24;
  const padT = 34;
  const padB = 44;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const cellW = plotW / 24;
  const cellH = plotH / profile.altitudes.length;
  const minTemp = profile.minTemp ?? 0;
  const maxTemp = profile.maxTemp ?? 1;
  const minAlt = profile.altitudes[0];
  const maxAlt = profile.altitudes[profile.altitudes.length - 1];
  const altLabels = profile.altitudes.map((m) => `${Math.round(m)}m`);
  const hourLabels = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'));
  const contours = [];
  const contourStart = Math.floor(minTemp / 2) * 2;
  const contourEnd = Math.ceil(maxTemp / 2) * 2;

  const altitudeToY = (alt) => padT + (1 - (alt - minAlt) / Math.max(1, maxAlt - minAlt)) * plotH;
  const hourToX = (h) => padL + h * cellW + cellW / 2;
  const contourAltitudeAtHour = (targetTemp, hourIdx, prevAlt) => {
    const samples = [];
    for (let r = 0; r < profile.altitudes.length - 1; r += 1) {
      const a1 = profile.altitudes[r];
      const a2 = profile.altitudes[r + 1];
      const t1 = profile.grid[r][hourIdx];
      const t2 = profile.grid[r + 1][hourIdx];
      if (!Number.isFinite(t1) || !Number.isFinite(t2)) continue;
      const crosses = (t1 - targetTemp) * (t2 - targetTemp) <= 0;
      if (!crosses) continue;
      const ratio = Math.abs(t2 - t1) < 1e-6 ? 0.5 : (targetTemp - t1) / (t2 - t1);
      const alt = a1 + clamp(ratio, 0, 1) * (a2 - a1);
      samples.push(alt);
    }
    if (!samples.length) return null;
    if (prevAlt == null) return samples[0];
    samples.sort((a, b) => Math.abs(a - prevAlt) - Math.abs(b - prevAlt));
    return samples[0];
  };

  const buildContourPath = (targetTemp) => {
    let d = '';
    let prevAlt = null;
    let drawing = false;
    for (let h = 0; h < 24; h += 1) {
      const alt = contourAltitudeAtHour(targetTemp, h, prevAlt);
      if (alt == null) {
        drawing = false;
        prevAlt = null;
        continue;
      }
      const x = hourToX(h);
      const y = altitudeToY(alt);
      if (!drawing) {
        d += `M ${x.toFixed(1)} ${y.toFixed(1)} `;
        drawing = true;
      } else {
        d += `L ${x.toFixed(1)} ${y.toFixed(1)} `;
      }
      prevAlt = alt;
    }
    return d.trim();
  };

  for (let t = contourStart; t <= contourEnd; t += 2) {
    const path = buildContourPath(t);
    if (path) contours.push({ temp: t, path });
  }

  const cells = [];
  for (let r = 0; r < profile.altitudes.length; r += 1) {
    for (let c = 0; c < 24; c += 1) {
      const temp = profile.grid[r][c];
      const x = padL + c * cellW;
      const y = padT + r * cellH;
      const opacity = temp == null ? 0.08 : 0.92;
      cells.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(cellW + 0.7).toFixed(1)}" height="${(cellH + 0.7).toFixed(1)}" fill="${tempToColor(temp, minTemp, maxTemp)}" fill-opacity="${opacity.toFixed(2)}"></rect>`);
    }
  }

  const xTicks = hourLabels.filter((_, h) => h % 3 === 0).map((label, h) => {
    const x = padL + h * 3 * cellW + 2;
    return `<g><line x1="${x.toFixed(1)}" y1="${padT}" x2="${x.toFixed(1)}" y2="${padT + plotH}" stroke="rgba(255,255,255,0.06)" stroke-dasharray="3 5"/><text x="${x.toFixed(1)}" y="${height - 14}" class="heatmap-axis">${label}</text></g>`;
  }).join('');

  const yTicks = altLabels.map((label, i) => {
    const y = padT + i * cellH + cellH / 2 + 4;
    return `<g><line x1="${padL}" y1="${y.toFixed(1)}" x2="${padL + plotW}" y2="${y.toFixed(1)}" stroke="rgba(255,255,255,0.05)"/><text x="${padL - 10}" y="${y.toFixed(1)}" text-anchor="end" class="heatmap-axis">${label}</text></g>`;
  }).join('');

  const contourSvg = contours.map(({ temp, path }) => {
    const color = temp >= 0 ? 'rgba(255,255,255,0.24)' : 'rgba(255,255,255,0.18)';
    return `<g><path d="${path}" fill="none" stroke="${color}" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><text x="${padL + 4}" y="${altitudeToY(profile.altitudes[0]) - 6}" class="heatmap-axis">${temp}°</text></g>`;
  }).join('');

  const legendStops = [
    { temp: minTemp, label: '冷' },
    { temp: (minTemp + maxTemp) / 2, label: '中' },
    { temp: maxTemp, label: '热' },
  ].map((item) => {
    const c = tempToColor(item.temp, minTemp, maxTemp);
    return `<div class="heatmap-legend-item"><span class="heatmap-swatch" style="background:${c}"></span><span>${item.label} ${fmt(item.temp, 1)}°C</span></div>`;
  }).join('');

  root.innerHTML = `
    <div class="heatmap-frame">
      <svg viewBox="0 0 ${width} ${height}" class="heatmap-svg" role="img" aria-label="时间海拔温度剖面图">
        <defs>
          <linearGradient id="heatfade" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stop-color="rgba(255,255,255,0.03)"/>
            <stop offset="100%" stop-color="rgba(255,255,255,0.00)"/>
          </linearGradient>
        </defs>
        <rect x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" rx="18" fill="url(#heatfade)" stroke="rgba(255,255,255,0.09)"></rect>
        ${cells.join('')}
        ${xTicks}
        ${yTicks}
        ${contourSvg}
        <text x="${padL}" y="${padT - 10}" class="heatmap-title">${day ? formatDateLabel(day.day) : ''} · 时间-海拔温度剖面</text>
        <text x="${padL}" y="${height - 6}" class="heatmap-axis">时间</text>
        <text x="12" y="${padT + plotH / 2}" class="heatmap-axis" transform="rotate(-90 12 ${padT + plotH / 2})">海拔</text>
      </svg>
      <div class="heatmap-legend">${legendStops}</div>
    </div>
  `;

  if (note) {
    note.textContent = `横轴为时间，纵轴为海拔；颜色从蓝到红表示温度从低到高，并叠加等温线。当前剖面：${day ? formatDateLabel(day.day) : '—'}。`;
  }
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function loadCityCatalog() {
  if (cityCatalog.length) return cityCatalog;
  const res = await fetch(CITY_LIST_URL);
  if (!res.ok) throw new Error(`城市名单加载失败: ${res.status}`);
  cityCatalog = await res.json();
  return cityCatalog;
}

function buildDisplayCatalog(catalog) {
  const topPopulation = catalog.slice(0, 50);
  const coastalMajor = catalog.filter((city) => city.coastal && !topPopulation.some((x) => x.id === city.id));
  const byId = new Map();
  for (const city of [...topPopulation, ...coastalMajor]) byId.set(city.id, city);
  return {
    topPopulation,
    coastalMajor,
    merged: [...byId.values()],
  };
}

function renderCityOptions(groups) {
  const renderOptions = (items) => items.map((c) => `<option value="${c.id}">${c.name}${c.coastal ? ' · 沿海' : ''}</option>`).join('');
  citySelect.innerHTML = `
    <optgroup label="人口前 50">
      ${renderOptions(groups.topPopulation)}
    </optgroup>
    <optgroup label="沿海主要城市（补充）">
      ${renderOptions(groups.coastalMajor)}
    </optgroup>
  `;
}

function ensureHeatmapProfiles(cityData) {
  if (!cityData?.daily?.length) return cityData;
  if (cityData.daily.some((day) => day.profile)) return cityData;
  const city = cityData.city;
  return {
    ...cityData,
    daily: cityData.daily.map((day) => ({
      ...day,
      profile: buildSyntheticDayProfile(
        city,
        day.day,
        day.daytime?.window?.best?.baseM ?? 180,
        day.daytime?.window?.best?.topM ?? 620,
        day.daytime?.window?.best?.centerDiffCPerKm ?? 1.2,
        day.daytime?.window?.persistence ?? 0.2,
      ),
    })),
  };
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let index = 0;
  async function worker() {
    while (true) {
      const i = index;
      index += 1;
      if (i >= items.length) break;
      try {
        results[i] = { status: 'fulfilled', value: await mapper(items[i], i) };
      } catch (error) {
        results[i] = { status: 'rejected', reason: error };
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

function seededValue(seed) {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function addHours(base, hours) {
  return new Date(base.getTime() + hours * 3600 * 1000);
}

function makeIso(date, hour, minute = 0) {
  const d = new Date(date);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

function buildSyntheticForecast(city, startDate = new Date()) {
  const days = [];
  const latBias = clamp((city.lat - 20) / 20, 0, 1);
  const coastalBias = city.coastal ? 1 : 0;
  const seedBase = [...String(city.id)].reduce((acc, ch, idx) => acc + ch.charCodeAt(0) * (idx + 1), 0);

  for (let d = 0; d < 7; d += 1) {
    const day = new Date(startDate);
    day.setDate(day.getDate() + d);

    const season = 0.5 + 0.5 * Math.sin((day.getMonth() / 12) * Math.PI * 2);
    const rng = (n) => seededValue(seedBase + d * 97 + n);
    const sunriseHour = 6 + Math.round((1 - latBias) * 20) / 20;
    const sunsetHour = 18 + Math.round(latBias * 20) / 20;
    const sunrise = makeIso(day, Math.max(5, Math.min(7, sunriseHour)), 20 + Math.round(rng(1) * 20));
    const sunset = makeIso(day, Math.max(17, Math.min(19, sunsetHour)), 10 + Math.round(rng(2) * 30));

    const strengthBase = 0.6 + coastalBias * 0.8 + latBias * 0.5 + season * 0.3 + rng(3) * 0.6;
    const baseM = 180 + Math.round(rng(4) * 1000 + (1 - coastalBias) * 180);
    const topM = baseM + 140 + Math.round(rng(5) * 320);
    const persistence = clamp(0.08 + coastalBias * 0.22 + latBias * 0.12 + rng(6) * 0.18, 0, 0.8);
    const meanStrength = strengthBase + rng(7) * 1.0;
    const centerDiff = clamp(meanStrength + rng(13) * 0.8, 0.2, 5.5);
    const mirageScore = Math.round(clamp(10 + 16 * coastalBias + 10 * latBias + 18 * persistence + 9 * centerDiff, 0, 100));
    const sunriseGreen = Math.round(clamp(6 + 10 * coastalBias + 12 * persistence + 14 * rng(8), 0, 100));
    const sunsetGreen = Math.round(clamp(8 + 10 * coastalBias + 10 * persistence + 14 * rng(9), 0, 100));
    const sunriseCloud = Math.round(clamp(35 + 30 * rng(10) - 12 * coastalBias, 0, 100));
    const sunsetCloud = Math.round(clamp(35 + 28 * rng(11) - 10 * coastalBias, 0, 100));
    const seaTemp = city.coastal ? Math.round((12 + 18 * season + rng(12) * 5) * 10) / 10 : null;
    const seaContrast = city.coastal ? Math.round((Math.abs((seaTemp ?? 0) - (18 - latBias * 8)) * 10)) / 10 : null;

    days.push({
      day: day.toISOString().slice(0, 10),
      sunrise: {
        time: sunrise,
        inversion: {
          baseM: baseM * 0.9,
          peakM: (baseM + topM) / 2,
          topM: topM * 0.95,
          thicknessM: Math.max(120, topM - baseM),
          strengthCPerKm: Math.max(0.3, meanStrength + 0.2),
          centerDiffCPerKm: centerDiff,
        },
        lowInversion: {
          baseM,
          peakM: (baseM + topM) / 2,
          topM,
          thicknessM: topM - baseM,
          strengthCPerKm: meanStrength,
          centerDiffCPerKm: centerDiff,
        },
        cloudCover: sunriseCloud,
        greenScore: sunriseGreen,
      },
      sunset: {
        time: sunset,
        inversion: {
          baseM: baseM * 0.95,
          peakM: (baseM + topM) / 2,
          topM: topM * 1.02,
          thicknessM: Math.max(120, topM - baseM),
          strengthCPerKm: Math.max(0.3, meanStrength + 0.1),
          centerDiffCPerKm: centerDiff,
        },
        lowInversion: {
          baseM,
          peakM: (baseM + topM) / 2,
          topM,
          thicknessM: topM - baseM,
          strengthCPerKm: meanStrength,
          centerDiffCPerKm: centerDiff,
        },
        cloudCover: sunsetCloud,
        greenScore: sunsetGreen,
      },
      daytime: {
        window: {
          best: {
            baseM,
            peakM: (baseM + topM) / 2,
            topM,
            thicknessM: topM - baseM,
            strengthCPerKm: meanStrength,
            centerDiffCPerKm: centerDiff,
            lowLevel: true,
          },
          persistence,
          meanStrength,
          lowestBase: baseM,
          hours: 12,
        },
        mirageScore,
        seaTemp,
        seaContrast,
      },
      bestGreenScore: Math.max(sunriseGreen, sunsetGreen),
      profile: buildSyntheticDayProfile(city, day.toISOString().slice(0, 10), baseM, topM, centerDiff, persistence),
      source: 'synthetic-fallback',
    });
  }

  return {
    city,
    coastal: city.coastal,
    generatedAt: new Date().toISOString(),
    daily: days,
    source: 'synthetic-fallback',
  };
}

async function loadStaticForecast() {
  try {
    const res = await fetch('./data/latest.json', { cache: 'no-store' });
    if (!res.ok) return null;
    const payload = await res.json();
    if (!payload?.cities?.length) return null;
    return payload.cities;
  } catch {
    return null;
  }
}

async function fetchCity(city) {
  const hourlyVars = `${LEVELS.map((lv) => `temperature_${lv}hPa`).join(',')},cloud_cover`;
  const gfsUrl = new URL(GFS_URL);
  gfsUrl.searchParams.set('latitude', city.lat);
  gfsUrl.searchParams.set('longitude', city.lon);
  gfsUrl.searchParams.set('hourly', hourlyVars);
  gfsUrl.searchParams.set('daily', 'sunrise,sunset');
  gfsUrl.searchParams.set('forecast_days', '7');
  gfsUrl.searchParams.set('timezone', 'Asia/Shanghai');

  const gfs = await fetchJson(gfsUrl.toString());

  let marine = null;
  if (city.coastal) {
    try {
      const marineUrl = new URL(MARINE_URL);
      marineUrl.searchParams.set('latitude', city.lat);
      marineUrl.searchParams.set('longitude', city.lon);
      marineUrl.searchParams.set('hourly', 'sea_surface_temperature');
      marineUrl.searchParams.set('forecast_days', '7');
      marineUrl.searchParams.set('timezone', 'Asia/Shanghai');
      marine = await fetchJson(marineUrl.toString());
    } catch (err) {
      marine = null;
    }
  }

  return buildCityForecast(city, gfs, marine);
}

function buildCityForecast(city, gfs, marine) {
  const rows = [];
  const hourly = gfs.hourly || {};
  const daily = gfs.daily || { time: [], sunrise: [], sunset: [] };
  const marineHourly = marine?.hourly || {};

  for (let d = 0; d < daily.time.length; d += 1) {
    const day = daily.time[d];
    const sunrise = daily.sunrise[d];
    const sunset = daily.sunset[d];
    const sunriseIdx = nearestIndex(hourly.time, sunrise);
    const sunsetIdx = nearestIndex(hourly.time, sunset);

    const sunriseProf = profileAtIndex(hourly, sunriseIdx);
    const sunsetProf = profileAtIndex(hourly, sunsetIdx);
    const sunriseSegs = detectInversionSegments(sunriseProf.tempByLevel);
    const sunsetSegs = detectInversionSegments(sunsetProf.tempByLevel);
    const sunriseInv = strongestSegment(sunriseSegs, false);
    const sunsetInv = strongestSegment(sunsetSegs, false);
    const sunriseLowInv = strongestSegment(sunriseSegs, true);
    const sunsetLowInv = strongestSegment(sunsetSegs, true);

    const dayWindow = scanWindow(hourly, sunrise, sunset);
    const middayIdx = nearestIndex(hourly.time, new Date((new Date(sunrise).getTime() + new Date(sunset).getTime()) / 2).toISOString());
    const middayProf = profileAtIndex(hourly, middayIdx);
    const seaIdx = marineHourly.time ? nearestIndex(marineHourly.time, new Date((new Date(sunrise).getTime() + new Date(sunset).getTime()) / 2).toISOString()) : null;
    const seaTemp = seaIdx != null ? marineHourly.sea_surface_temperature?.[seaIdx] ?? null : null;
    const nearSurfaceTemp = middayProf.tempByLevel[1000] ?? middayProf.tempByLevel[925] ?? null;
    const seaContrast = seaTemp != null && nearSurfaceTemp != null ? Math.abs(seaTemp - nearSurfaceTemp) : null;

    const mirageScore = scoreDayMirage(dayWindow, seaContrast, seaTemp, city.coastal);
    const sunriseGreenScore = scoreGreenFlash(sunriseLowInv || sunriseInv, sunriseProf.cloudCover, city.coastal ? 3 : 0);
    const sunsetGreenScore = scoreGreenFlash(sunsetLowInv || sunsetInv, sunsetProf.cloudCover, city.coastal ? 3 : 0);

    rows.push({
      day,
      sunrise: {
        time: sunrise,
        inversion: sunriseInv,
        lowInversion: sunriseLowInv,
        cloudCover: sunriseProf.cloudCover,
        greenScore: sunriseGreenScore,
      },
      sunset: {
        time: sunset,
        inversion: sunsetInv,
        lowInversion: sunsetLowInv,
        cloudCover: sunsetProf.cloudCover,
        greenScore: sunsetGreenScore,
      },
      daytime: {
        window: dayWindow,
        mirageScore,
        seaTemp,
        seaContrast,
      },
      bestGreenScore: Math.max(sunriseGreenScore, sunsetGreenScore),
      profile: buildDayProfileFromHourly(hourly, day),
    });
  }

  return {
    city,
    coastal: city.coastal,
    generatedAt: gfs.generationtime_ms,
    daily: rows,
  };
}

function selectMetricRow(day) {
  const mode = eventTypeSelect.value;
  if (mode === 'sunrise') return { score: day.sunrise.greenScore, inv: day.sunrise.lowInversion || day.sunrise.inversion, label: '日出绿闪' };
  if (mode === 'sunset') return { score: day.sunset.greenScore, inv: day.sunset.lowInversion || day.sunset.inversion, label: '日落绿闪' };
  return { score: day.daytime.mirageScore, inv: day.daytime.window.best, label: '白天海市蜃楼' };
}

function getRankMetric(cityData) {
  const today = cityData.daily[0];
  return selectMetricRow(today).score;
}

function renderSummary() {
  const rows = allCityData.map((x) => {
    const today = x.daily[0];
    const metric = selectMetricRow(today);
    return { city: x.city.name, score: metric.score, day: today, coastal: x.coastal };
  });

  const top = [...rows].sort((a, b) => b.score - a.score)[0];
  const coastalRows = rows.filter((r) => r.coastal);
  const coastalTop = coastalRows.sort((a, b) => b.day.daytime.mirageScore - a.day.daytime.mirageScore)[0];
  const dayInversionCount = allCityData.filter((x) => x.daily[0].daytime.window.best).length;

  summaryEl.innerHTML = `
    <div class="kpi">
      <div class="kpi-title">当前关注项最高城市</div>
      <div class="kpi-value">${top ? top.city : '-'}</div>
      <div class="kpi-sub">${eventTypeSelect.value === 'sunrise' ? '日出绿闪' : eventTypeSelect.value === 'sunset' ? '日落绿闪' : '白天海市蜃楼'} · 评分 ${top ? top.score : '-'}</div>
    </div>
    <div class="kpi">
      <div class="kpi-title">沿海城市白天海市蜃楼最高</div>
      <div class="kpi-value">${coastalTop ? coastalTop.city : '-'}</div>
      <div class="kpi-sub">评分 ${coastalTop ? coastalTop.day.daytime.mirageScore : '-'}</div>
    </div>
    <div class="kpi">
      <div class="kpi-title">今日检测到低空逆温的城市数</div>
      <div class="kpi-value">${dayInversionCount}/${allCityData.length}</div>
      <div class="kpi-sub">白天窗口（从日出到日落）</div>
    </div>
  `;
}

function renderRanking() {
  const rows = [...allCityData].sort((a, b) => getRankMetric(b) - getRankMetric(a));
  rankingEl.innerHTML = rows.map((x, i) => {
    const today = x.daily[0];
    const metric = selectMetricRow(today);
    const greenTop = Math.max(today.sunrise.greenScore, today.sunset.greenScore);
    const lv = levelLabel(metric.score);
    return `
      <div class="rank-row">
        <div class="rank-num">#${i + 1}</div>
        <div>${x.city.name}</div>
        <div>${metric.label} ${metric.score} · 双端绿闪 ${greenTop}</div>
        <span class="badge ${lv.cls}">${lv.text}</span>
      </div>
    `;
  }).join('');
}

function renderCity(cityData) {
  const city = cityData.city;
  const safeCityData = ensureHeatmapProfiles(cityData);
  cityTitleEl.textContent = `${city.name} · 未来 7 天峰值型逆温与海市蜃楼/绿闪倾向`;
  cityMetaEl.textContent = `${city.coastal ? '沿海城市' : '内陆对照'} · 单格点坐标 ${city.lat.toFixed(2)}, ${city.lon.toFixed(2)} · 逆温口径：单点剖面低温→高温→低温峰值型 · 海温${city.coastal ? '已尝试接入' : '不适用'}`;
  renderTemperatureHeatmap(safeCityData);

  dailyCardsEl.innerHTML = safeCityData.daily.map((d) => {
    const dayMetric = d.daytime.mirageScore;
    const sunriseInv = d.sunrise.lowInversion || d.sunrise.inversion;
    const sunsetInv = d.sunset.lowInversion || d.sunset.inversion;
    const mirageLv = levelLabel(d.daytime.mirageScore);
    const sunriseLv = levelLabel(d.sunrise.greenScore);
    const sunsetLv = levelLabel(d.sunset.greenScore);

    const invText = d.daytime.window.best
      ? `${fmt(d.daytime.window.best.baseM, 0)} m → 峰值 ${fmt(d.daytime.window.best.peakM, 0)} m → ${fmt(d.daytime.window.best.topM, 0)} m · 中心反向温差 ${fmt(d.daytime.window.best.centerDiffCPerKm, 2)} °C/km`
      : '无明显峰值型逆温';

    return `
      <article class="card">
        <h3>${formatDateLabel(d.day)}</h3>
        <div>白天海市蜃楼：<span class="badge ${mirageLv.cls}">${d.daytime.mirageScore}</span></div>
        <div>日出绿闪：<span class="badge ${sunriseLv.cls}">${d.sunrise.greenScore}</span> · ${sunriseInv ? '有逆温' : '无逆温'}</div>
        <div>日落绿闪：<span class="badge ${sunsetLv.cls}">${d.sunset.greenScore}</span> · ${sunsetInv ? '有逆温' : '无逆温'}</div>
        <div>日间低空逆温：${invText}</div>
        <div>持续性：${fmt(d.daytime.window.persistence * 100, 0)}%</div>
        <div>海温：${fmt(d.daytime.seaTemp, 1)}°C</div>
        <div>海气温差：${d.daytime.seaContrast == null ? '-' : `${fmt(d.daytime.seaContrast, 1)}°C`}</div>
        <div>日出：${formatEventTime(d.sunrise.time)} / 日落：${formatEventTime(d.sunset.time)}</div>
      </article>
    `;
  }).join('');
}

function updateAllViews() {
  if (!allCityData.length) return;
  const cityId = citySelect.value || allCityData[0].city.id;
  const cityData = allCityData.find((x) => x.city.id === cityId) || allCityData[0];
  renderSummary();
  renderRanking();
  renderCity(cityData);
}

async function load() {
  statusEl.textContent = '正在加载城市池与缓存数据…';
  refreshBtn.disabled = true;
  try {
    const catalog = await loadCityCatalog();
    displayCatalog = buildDisplayCatalog(catalog);
    renderCityOptions(displayCatalog);

    const cached = await loadStaticForecast();
    if (cached?.length) {
      const cachedMap = new Map(cached.map((item) => [item.city?.id ?? item.city?.name, item]));
      allCityData = displayCatalog.merged
        .map((city) => cachedMap.get(city.id))
        .filter(Boolean)
        .map((cityData) => ensureHeatmapProfiles(cityData));
      if (!allCityData.length) {
        allCityData = displayCatalog.merged.map((city) => buildSyntheticForecast(city));
      }
      if (!citySelect.value) citySelect.value = allCityData[0].city.id;
      updateAllViews();
      statusEl.textContent = `已加载缓存数据：${new Date().toLocaleString('zh-CN', { hour12: false })}`;
      return;
    }

    allCityData = displayCatalog.merged.map((city) => buildSyntheticForecast(city));
    if (!citySelect.value) citySelect.value = allCityData[0].city.id;
    updateAllViews();
    statusEl.textContent = `已启用离线估计（人口前 50 + 沿海主要城市，${displayCatalog.merged.length} 城市可用）`;
  } catch (err) {
    console.error(err);
    try {
      const catalog = await loadCityCatalog();
      displayCatalog = buildDisplayCatalog(catalog);
      renderCityOptions(displayCatalog);
      allCityData = displayCatalog.merged.map((city) => buildSyntheticForecast(city));
      if (!citySelect.value) citySelect.value = allCityData[0].city.id;
      updateAllViews();
      statusEl.textContent = `加载失败，已切换为离线估计：${err.message}`;
    } catch (fallbackErr) {
      statusEl.textContent = `加载失败：${fallbackErr.message}`;
    }
  } finally {
    refreshBtn.disabled = false;
  }
}

citySelect.addEventListener('change', updateAllViews);
eventTypeSelect.addEventListener('change', updateAllViews);
refreshBtn.addEventListener('click', load);

load();
