const CITIES = [
  { id: 'qingdao', name: '青岛', lat: 36.0671, lon: 120.3826 },
  { id: 'dalian', name: '大连', lat: 38.914, lon: 121.6147 },
  { id: 'yantai', name: '烟台', lat: 37.4638, lon: 121.4479 },
  { id: 'shanghai', name: '上海', lat: 31.2304, lon: 121.4737 },
  { id: 'xiamen', name: '厦门', lat: 24.4798, lon: 118.0894 },
  { id: 'haikou', name: '海口', lat: 20.044, lon: 110.1999 },
  { id: 'guangzhou', name: '广州', lat: 23.1291, lon: 113.2644 },
  { id: 'tianjin', name: '天津', lat: 39.0842, lon: 117.201 },
  { id: 'wuhan', name: '武汉', lat: 30.5928, lon: 114.3055 }
];

const LEVELS = [1000, 925, 850, 700, 600, 500];
const PRESSURE_TO_ALT_M = (p) => 44330 * (1 - Math.pow(p / 1013.25, 0.1903));

const citySelect = document.getElementById('citySelect');
const eventTypeSelect = document.getElementById('eventType');
const refreshBtn = document.getElementById('refreshBtn');
const statusEl = document.getElementById('status');
const summaryEl = document.getElementById('summary');
const cityTitleEl = document.getElementById('cityTitle');
const cityMetaEl = document.getElementById('cityMeta');
const dailyCardsEl = document.getElementById('dailyCards');
const rankingEl = document.getElementById('ranking');

let allCityData = [];

function levelLabel(score) {
  if (score >= 70) return { text: '高', cls: 'lv-high' };
  if (score >= 40) return { text: '中', cls: 'lv-mid' };
  return { text: '低', cls: 'lv-low' };
}

function fmt(n, d = 1) {
  if (n == null || Number.isNaN(n)) return '-';
  return Number(n).toFixed(d);
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

function detectStrongestInversion(tempByLevel) {
  let best = null;
  for (let i = 0; i < LEVELS.length - 1; i += 1) {
    const p1 = LEVELS[i];
    const p2 = LEVELS[i + 1];
    const t1 = tempByLevel[p1];
    const t2 = tempByLevel[p2];
    if (t1 == null || t2 == null) continue;

    const z1 = PRESSURE_TO_ALT_M(p1);
    const z2 = PRESSURE_TO_ALT_M(p2);
    const dz = z2 - z1;
    if (dz <= 1) continue;
    const grad = ((t2 - t1) / dz) * 1000; // °C/km

    if (grad > 0) {
      const segment = {
        baseM: z1,
        topM: z2,
        thicknessM: dz,
        strengthCPerKm: grad
      };
      if (!best || segment.strengthCPerKm > best.strengthCPerKm) best = segment;
    }
  }
  return best;
}

function scoreMirage(inv, persistence) {
  if (!inv) return 5;
  const strength = Math.min(1, inv.strengthCPerKm / 12);
  const lowBase = Math.max(0, 1 - inv.baseM / 1500);
  const persist = Math.min(1, persistence);
  return Math.round(60 * strength + 25 * lowBase + 15 * persist);
}

function scoreGreenFlash(inv, cloudCover) {
  const invPart = inv ? Math.min(1, inv.strengthCPerKm / 10) : 0;
  const clearPart = Math.max(0, 1 - (cloudCover ?? 50) / 100);
  const lowBasePart = inv ? Math.max(0, 1 - inv.baseM / 1200) : 0;
  return Math.round(50 * invPart + 35 * clearPart + 15 * lowBasePart);
}

function profileAtIndex(hourly, idx) {
  const tempByLevel = {};
  for (const lv of LEVELS) {
    tempByLevel[lv] = hourly[`temperature_${lv}hPa`]?.[idx] ?? null;
  }
  return {
    tempByLevel,
    cloudCover: hourly.cloud_cover?.[idx] ?? null,
    time: hourly.time?.[idx]
  };
}

function buildDaily(city, raw) {
  const { hourly, daily } = raw;
  const rows = [];

  for (let d = 0; d < daily.time.length; d += 1) {
    const day = daily.time[d];
    const sunrise = daily.sunrise[d];
    const sunset = daily.sunset[d];

    const sunriseIdx = nearestIndex(hourly.time, sunrise);
    const sunsetIdx = nearestIndex(hourly.time, sunset);

    const around = (targetIdx) => {
      const idxs = [targetIdx - 2, targetIdx - 1, targetIdx, targetIdx + 1, targetIdx + 2]
        .filter((i) => i >= 0 && i < hourly.time.length);
      const invHits = idxs.map((i) => detectStrongestInversion(profileAtIndex(hourly, i).tempByLevel)).filter(Boolean);
      const persistence = invHits.length / idxs.length;
      return { persistence };
    };

    const sunriseProfile = profileAtIndex(hourly, sunriseIdx);
    const sunsetProfile = profileAtIndex(hourly, sunsetIdx);

    const sunriseInv = detectStrongestInversion(sunriseProfile.tempByLevel);
    const sunsetInv = detectStrongestInversion(sunsetProfile.tempByLevel);

    const sunrisePersistence = around(sunriseIdx).persistence;
    const sunsetPersistence = around(sunsetIdx).persistence;

    const sunriseMirage = scoreMirage(sunriseInv, sunrisePersistence);
    const sunsetMirage = scoreMirage(sunsetInv, sunsetPersistence);
    const sunriseGreen = scoreGreenFlash(sunriseInv, sunriseProfile.cloudCover);
    const sunsetGreen = scoreGreenFlash(sunsetInv, sunsetProfile.cloudCover);

    rows.push({
      day,
      sunrise: {
        time: sunrise,
        inversion: sunriseInv,
        cloudCover: sunriseProfile.cloudCover,
        mirageScore: sunriseMirage,
        greenFlashScore: sunriseGreen,
        persistence: sunrisePersistence
      },
      sunset: {
        time: sunset,
        inversion: sunsetInv,
        cloudCover: sunsetProfile.cloudCover,
        mirageScore: sunsetMirage,
        greenFlashScore: sunsetGreen,
        persistence: sunsetPersistence
      }
    });
  }

  return {
    city,
    generatedAt: raw.generationtime_ms,
    daily: rows
  };
}

async function fetchCity(city) {
  const hourlyVars = LEVELS.map((lv) => `temperature_${lv}hPa`).join(',') + ',cloud_cover';
  const url = new URL('https://api.open-meteo.com/v1/gfs');
  url.searchParams.set('latitude', city.lat);
  url.searchParams.set('longitude', city.lon);
  url.searchParams.set('hourly', hourlyVars);
  url.searchParams.set('daily', 'sunrise,sunset');
  url.searchParams.set('forecast_days', '7');
  url.searchParams.set('timezone', 'Asia/Shanghai');

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`${city.name} 拉取失败: ${res.status}`);
  const raw = await res.json();
  return buildDaily(city, raw);
}

function renderSummary(data) {
  const todayRows = data.map((x) => {
    const t = x.daily[0];
    const ev = eventTypeSelect.value === 'sunrise' ? t.sunrise : t.sunset;
    return { city: x.city.name, mirage: ev.mirageScore, green: ev.greenFlashScore, inv: ev.inversion };
  });

  const topMirage = [...todayRows].sort((a, b) => b.mirage - a.mirage)[0];
  const topGreen = [...todayRows].sort((a, b) => b.green - a.green)[0];
  const withInv = todayRows.filter((x) => !!x.inv).length;

  summaryEl.innerHTML = `
    <div class="kpi">
      <div class="kpi-title">今日最强海市蜃楼倾向</div>
      <div class="kpi-value">${topMirage ? topMirage.city : '-'}</div>
      <div class="kpi-sub">评分 ${topMirage ? topMirage.mirage : '-'}</div>
    </div>
    <div class="kpi">
      <div class="kpi-title">今日最强绿闪倾向</div>
      <div class="kpi-value">${topGreen ? topGreen.city : '-'}</div>
      <div class="kpi-sub">评分 ${topGreen ? topGreen.green : '-'}</div>
    </div>
    <div class="kpi">
      <div class="kpi-title">今日检测到逆温的城市数</div>
      <div class="kpi-value">${withInv}/${data.length}</div>
      <div class="kpi-sub">按当前时间窗（${eventTypeSelect.value === 'sunrise' ? '日出' : '日落'}）统计</div>
    </div>
  `;
}

function renderRanking(data) {
  const rows = data.map((x) => {
    const t = x.daily[0];
    const ev = eventTypeSelect.value === 'sunrise' ? t.sunrise : t.sunset;
    return { city: x.city.name, mirage: ev.mirageScore, green: ev.greenFlashScore, inv: ev.inversion };
  }).sort((a, b) => (b.mirage + b.green) - (a.mirage + a.green));

  rankingEl.innerHTML = rows.map((r, i) => {
    const lv = levelLabel((r.mirage + r.green) / 2);
    return `
      <div class="rank-row">
        <div class="rank-num">#${i + 1}</div>
        <div>${r.city}</div>
        <div>海市 ${r.mirage} / 绿闪 ${r.green}</div>
        <span class="badge ${lv.cls}">${lv.text}</span>
      </div>
    `;
  }).join('');
}

function renderCity(cityData) {
  const city = cityData.city;
  cityTitleEl.textContent = `${city.name} · 未来 7 天逆温与现象倾向`;
  cityMetaEl.textContent = `坐标 ${city.lat.toFixed(2)}, ${city.lon.toFixed(2)} · 时区 Asia/Shanghai`;

  dailyCardsEl.innerHTML = cityData.daily.map((d) => {
    const ev = eventTypeSelect.value === 'sunrise' ? d.sunrise : d.sunset;
    const lvMir = levelLabel(ev.mirageScore);
    const lvGreen = levelLabel(ev.greenFlashScore);
    const inv = ev.inversion;

    return `
      <article class="card">
        <h3>${d.day}</h3>
        <div>目标时段：${new Date(ev.time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</div>
        <div>逆温：${inv ? '是' : '否'}</div>
        <div>底高：${inv ? fmt(inv.baseM, 0) + ' m' : '-'}</div>
        <div>顶高：${inv ? fmt(inv.topM, 0) + ' m' : '-'}</div>
        <div>厚度：${inv ? fmt(inv.thicknessM, 0) + ' m' : '-'}</div>
        <div>强度：${inv ? fmt(inv.strengthCPerKm, 2) + ' °C/km' : '-'}</div>
        <div>云量：${fmt(ev.cloudCover, 0)}%</div>
        <div>持续性：${fmt(ev.persistence * 100, 0)}%</div>
        <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;">
          <span class="badge ${lvMir.cls}">海市蜃楼 ${ev.mirageScore}（${lvMir.text}）</span>
          <span class="badge ${lvGreen.cls}">绿闪 ${ev.greenFlashScore}（${lvGreen.text}）</span>
        </div>
      </article>
    `;
  }).join('');
}

function updateAllViews() {
  const cityId = citySelect.value;
  const cityData = allCityData.find((x) => x.city.id === cityId) || allCityData[0];
  if (cityData) {
    renderSummary(allCityData);
    renderRanking(allCityData);
    renderCity(cityData);
  }
}

async function load() {
  statusEl.textContent = '正在拉取 GFS 分层温度数据…';
  refreshBtn.disabled = true;
  try {
    allCityData = await Promise.all(CITIES.map(fetchCity));
    if (!citySelect.options.length) {
      citySelect.innerHTML = CITIES.map((c) => `<option value="${c.id}">${c.name}</option>`).join('');
      citySelect.value = CITIES[0].id;
    }
    updateAllViews();
    statusEl.textContent = `更新成功：${new Date().toLocaleString('zh-CN', { hour12: false })}`;
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
