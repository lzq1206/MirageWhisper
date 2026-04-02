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
  for (let i = 0; i < LEVELS.length - 1; i += 1) {
    const p1 = LEVELS[i];
    const p2 = LEVELS[i + 1];
    const t1 = tempByLevel[p1];
    const t2 = tempByLevel[p2];
    if (t1 == null || t2 == null) continue;
    const grad = gradientCPerKm(t1, t2, p1, p2);
    if (grad != null && grad > 0) {
      const baseM = pressureToAltitudeM(p1);
      const topM = pressureToAltitudeM(p2);
      segments.push({
        baseM,
        topM,
        thicknessM: topM - baseM,
        strengthCPerKm: grad,
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
  const strength = Math.min(1, (dayWindow.meanStrength || 0) / 10);
  const lowBase = dayWindow.lowestBase == null ? 0 : clamp(1 - dayWindow.lowestBase / 1500, 0, 1);
  const persist = clamp(dayWindow.persistence, 0, 1);
  const marineBoost = isCoastal ? clamp((seaContrast || 0) / 8, 0, 1) * 12 : 0;
  const seaWarmBoost = isCoastal && seaTemp != null ? clamp((seaTemp - 10) / 20, 0, 1) * 4 : 0;
  return Math.round(45 * strength + 30 * lowBase + 15 * persist + marineBoost + seaWarmBoost);
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
  cityTitleEl.textContent = `${city.name} · 未来 7 天逆温与海市蜃楼/绿闪倾向`;
  cityMetaEl.textContent = `${city.coastal ? '沿海城市' : '内陆对照'} · 坐标 ${city.lat.toFixed(2)}, ${city.lon.toFixed(2)} · 海温${city.coastal ? '已尝试接入' : '不适用'}`;

  dailyCardsEl.innerHTML = cityData.daily.map((d) => {
    const dayMetric = d.daytime.mirageScore;
    const sunriseInv = d.sunrise.lowInversion || d.sunrise.inversion;
    const sunsetInv = d.sunset.lowInversion || d.sunset.inversion;
    const mirageLv = levelLabel(d.daytime.mirageScore);
    const sunriseLv = levelLabel(d.sunrise.greenScore);
    const sunsetLv = levelLabel(d.sunset.greenScore);

    const invText = d.daytime.window.best
      ? `${fmt(d.daytime.window.best.baseM, 0)} m → ${fmt(d.daytime.window.best.topM, 0)} m · ${fmt(d.daytime.window.best.strengthCPerKm, 2)} °C/km`
      : '无明显低空逆温';

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
  statusEl.textContent = '正在加载城市池与 GFS 分层温度数据…';
  refreshBtn.disabled = true;
  try {
    const catalog = await loadCityCatalog();
    citySelect.innerHTML = catalog
      .map((c) => `<option value="${c.id}">${c.name}${c.coastal ? ' · 沿海' : ''}</option>`)
      .join('');

    const settled = await mapLimit(catalog, CITY_CONCURRENCY, fetchCity);
    allCityData = settled.filter((item) => item.status === 'fulfilled').map((item) => item.value);

    if (!allCityData.length) {
      throw new Error('所有城市都未能成功获取数据');
    }

    if (!citySelect.value) citySelect.value = allCityData[0].city.id;
    updateAllViews();
    const failed = settled.length - allCityData.length;
    statusEl.textContent = failed
      ? `更新成功（${allCityData.length} 城市，${failed} 个失败）：${new Date().toLocaleString('zh-CN', { hour12: false })}`
      : `更新成功：${new Date().toLocaleString('zh-CN', { hour12: false })}`;
  } catch (err) {
    console.error(err);
    statusEl.textContent = `加载失败：${err.message}`;
  } finally {
    refreshBtn.disabled = false;
  }
}

citySelect.addEventListener('change', updateAllViews);
eventTypeSelect.addEventListener('change', updateAllViews);
refreshBtn.addEventListener('click', load);

load();
