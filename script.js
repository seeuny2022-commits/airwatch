"use strict";

// =====================================================
//  AirWatch - Air Quality Dashboard
//  APIs (all free, no key): Open-Meteo Geocoding,
//  Open-Meteo Air Quality, Open-Meteo Weather
// =====================================================

// ---------- Config ----------
const GEO_URL = "https://geocoding-api.open-meteo.com/v1/search";
const AQ_URL = "https://air-quality-api.open-meteo.com/v1/air-quality";
const WX_URL = "https://api.open-meteo.com/v1/forecast";

const DEFAULT_CITY = { name: "Hanoi", country: "Vietnam", lat: 21.0245, lon: 105.8412 };
const MAX_FAVOURITES = 12;

// Upper limit of each of the 6 levels, for each standard
const THRESH = {
  us: [50, 100, 150, 200, 300, Infinity],
  eu: [20, 40, 60, 80, 100, Infinity]
};

// Same 6 colour levels for both standards
const LEVELS = [
  { color: "#5bc16a", text: "#10281a", us: "Good", eu: "Good",
    advice: "Air quality is great. Enjoy the outdoors!",
    acts: ["Fine for everyone", "Open freely", "Not needed"] },
  { color: "#f4d03f", text: "#2d2600", us: "Moderate", eu: "Fair",
    advice: "Acceptable. Very sensitive people may notice mild effects.",
    acts: ["Fine; very sensitive people take it easier", "Fine to open", "Not needed"] },
  { color: "#f39c3d", text: "#2d1600", us: "Unhealthy for Sensitive Groups", eu: "Moderate",
    advice: "Children, older adults and people with asthma should limit long outdoor effort.",
    acts: ["Sensitive groups: limit long or hard exercise", "Open only for short periods", "Sensitive groups should consider one"] },
  { color: "#e0524a", text: "#ffffff", us: "Unhealthy", eu: "Poor",
    advice: "Everyone may feel effects. Reduce heavy outdoor activity.",
    acts: ["Move hard exercise indoors", "Keep closed; use a purifier if you have one", "Recommended outdoors (N95/KF94)"] },
  { color: "#8e5bb5", text: "#ffffff", us: "Very Unhealthy", eu: "Very Poor",
    advice: "Health alert. Avoid outdoor activity and stay indoors if you can.",
    acts: ["Avoid outdoor exercise", "Closed, with a purifier", "Wear N95/KF94 outdoors"] },
  { color: "#7a1f33", text: "#ffffff", us: "Hazardous", eu: "Extremely Poor",
    advice: "Emergency conditions. Stay indoors and keep air clean inside.",
    acts: ["Stay indoors", "Sealed, with a purifier", "N95/KF94 essential if you must go out"] }
];

const ACTIVITY_HEADINGS = [
  { icon: "🏃", title: "Outdoor exercise" },
  { icon: "🪟", title: "Windows" },
  { icon: "😷", title: "Face mask" }
];

// WHO 2021 24-hour guidelines in µg/m³ (ozone: 8-hour peak value, used as an approximation)
const POLLUTANTS = [
  { key: "pm2_5", name: "PM2.5", full: "Fine particles", who: 15 },
  { key: "pm10", name: "PM10", full: "Coarse particles", who: 45 },
  { key: "ozone", name: "O₃", full: "Ozone", who: 100 },
  { key: "nitrogen_dioxide", name: "NO₂", full: "Nitrogen dioxide", who: 25 },
  { key: "sulphur_dioxide", name: "SO₂", full: "Sulphur dioxide", who: 40 },
  { key: "carbon_monoxide", name: "CO", full: "Carbon monoxide", who: 4000 }
];

const WEATHER_CODES = {
  0: ["☀️", "Clear sky"], 1: ["🌤️", "Mostly clear"], 2: ["⛅", "Partly cloudy"], 3: ["☁️", "Overcast"],
  45: ["🌫️", "Fog"], 48: ["🌫️", "Rime fog"],
  51: ["🌦️", "Light drizzle"], 53: ["🌦️", "Drizzle"], 55: ["🌦️", "Heavy drizzle"],
  61: ["🌧️", "Light rain"], 63: ["🌧️", "Rain"], 65: ["🌧️", "Heavy rain"],
  71: ["🌨️", "Light snow"], 73: ["🌨️", "Snow"], 75: ["❄️", "Heavy snow"],
  80: ["🌦️", "Rain showers"], 81: ["🌧️", "Heavy showers"], 82: ["⛈️", "Violent showers"],
  95: ["⛈️", "Thunderstorm"], 96: ["⛈️", "Thunderstorm with hail"], 99: ["⛈️", "Severe thunderstorm"]
};

// ---------- DOM ----------
const $ = id => document.getElementById(id);
const form = $("search-form");
const searchInput = $("search-input");
const suggestionsEl = $("suggestions");
const locateBtn = $("locate-btn");
const errorEl = $("error");
const loadingEl = $("loading");
const dashboard = $("dashboard");
const heroEl = $("hero");
const chartSvg = $("chart");
const chartTip = $("chart-tip");

// ---------- State ----------
const state = {
  city: null,           // {name, region, country, lat, lon}
  aq: null,             // air quality API response
  wx: null,             // weather API response (may be null)
  standard: store("aw_standard") === "eu" ? "eu" : "us",
  favourites: loadFavourites(),
  favData: {},          // key -> current air quality for saved cities
  requestId: 0
};

// ---------- Helpers ----------
function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch { /* storage may be blocked; the app still works */ }
  return null;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svgEl(tag, attrs) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const k in attrs) node.setAttribute(k, attrs[k]);
  return node;
}

function cityKey(lat, lon) {
  return Number(lat).toFixed(2) + "," + Number(lon).toFixed(2);
}

function cityLabel(c) {
  return [c.name, c.region && c.region !== c.name ? c.region : "", c.country].filter(Boolean).join(", ");
}

function levelIndex(value, standard) {
  return THRESH[standard].findIndex(limit => value <= limit);
}

function aqiKey() {
  return state.standard === "us" ? "us_aqi" : "european_aqi";
}

function fmtTime(isoLocal) {
  // isoLocal looks like "2026-11-05T14:00" (already in the city's local time)
  const d = new Date(isoLocal);
  const day = d.toLocaleDateString("en", { weekday: "short" });
  return day + " " + isoLocal.slice(11, 16);
}

async function fetchJSON(url, params) {
  const response = await fetch(url + "?" + new URLSearchParams(params));
  if (!response.ok) throw new Error("Server error (" + response.status + ")");
  return response.json();
}

function showError(message) {
  errorEl.textContent = message;
  errorEl.classList.remove("hidden");
}
function clearError() { errorEl.classList.add("hidden"); }
function setLoading(on) { loadingEl.classList.toggle("hidden", !on); }

// ---------- API calls ----------
async function searchCities(query, count) {
  const data = await fetchJSON(GEO_URL, { name: query, count: count, language: "en", format: "json" });
  return (data.results || []).map(r => ({
    name: r.name, region: r.admin1 || "", country: r.country || "",
    lat: r.latitude, lon: r.longitude
  }));
}

async function getAirQuality(city) {
  const data = await fetchJSON(AQ_URL, {
    latitude: city.lat,
    longitude: city.lon,
    current: "us_aqi,european_aqi,pm2_5,pm10,ozone,nitrogen_dioxide,sulphur_dioxide,carbon_monoxide",
    hourly: "us_aqi,european_aqi",
    past_days: 1,
    forecast_days: 3,
    timezone: "auto"
  });
  if (!data.current || !data.hourly) throw new Error("No air quality data for this location.");
  return data;
}

async function getWeather(city) {
  return fetchJSON(WX_URL, {
    latitude: city.lat,
    longitude: city.lon,
    current: "temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code",
    timezone: "auto"
  });
}

// ---------- Loading a city ----------
async function loadCity(city) {
  const id = ++state.requestId;       // lets us ignore out-of-date responses
  clearError();
  setLoading(true);
  try {
    const [aqResult, wxResult] = await Promise.allSettled([getAirQuality(city), getWeather(city)]);
    if (id !== state.requestId) return;
    if (aqResult.status === "rejected") throw aqResult.reason;

    state.city = city;
    state.aq = aqResult.value;
    state.wx = wxResult.status === "fulfilled" ? wxResult.value : null;
    store("aw_city", JSON.stringify(city));
    renderAll();
  } catch (error) {
    if (id !== state.requestId) return;
    showError("Could not load air quality: " + error.message.replace(/\.?$/, ".") + " Check your connection or try another city.");
  } finally {
    if (id === state.requestId) setLoading(false);
  }
}

// ---------- Rendering ----------
function renderAll() {
  dashboard.classList.remove("hidden");
  renderHero();
  renderWeather();
  renderPlan();
  renderPollutants();
  renderChart();
  renderActivities();
  renderLegend();
  renderFavourites();
}

function currentAqi() {
  const v = state.aq.current[aqiKey()];
  return v === null || v === undefined ? null : Math.round(v);
}

function renderHero() {
  const c = state.city;
  $("city-name").textContent = c.name;
  $("city-sub").textContent =
    [c.region && c.region !== c.name ? c.region : "", c.country].filter(Boolean).join(", ") +
    "  ·  local time " + state.aq.current.time.slice(11, 16);

  const aqi = currentAqi();
  const numberEl = $("aqi-number");
  if (aqi === null) {
    numberEl.textContent = "–";
    $("aqi-label").textContent = "No data right now";
    $("aqi-advice").textContent = "The model has no AQI value for this moment.";
    $("aqi-dominant").textContent = "";
    return;
  }
  const lvl = LEVELS[levelIndex(aqi, state.standard)];
  heroEl.style.setProperty("--accent", lvl.color);
  heroEl.style.setProperty("--accent-text", lvl.text);
  numberEl.textContent = aqi;
  $("aqi-label").textContent = lvl[state.standard];
  $("aqi-advice").textContent = lvl.advice;

  const main = dominantPollutant();
  $("aqi-dominant").textContent = main
    ? "Main pollutant: " + main.p.name + " (" + main.ratio.toFixed(1) + "× WHO guideline)"
    : "";

  $("std-us").classList.toggle("active", state.standard === "us");
  $("std-eu").classList.toggle("active", state.standard === "eu");

  const saved = isFavourite(c);
  $("fav-btn").textContent = saved ? "★ Saved" : "☆ Save city";
}

function dominantPollutant() {
  let best = null;
  POLLUTANTS.forEach(p => {
    const v = state.aq.current[p.key];
    if (v === null || v === undefined) return;
    const ratio = v / p.who;
    if (!best || ratio > best.ratio) best = { p, ratio };
  });
  return best;
}

function renderWeather() {
  const wx = state.wx && state.wx.current;
  if (!wx) {
    $("wx-icon").textContent = "—";
    $("wx-temp").textContent = "--";
    $("wx-desc").textContent = "Weather unavailable";
    $("wx-hum").textContent = "--";
    $("wx-wind").textContent = "--";
    return;
  }
  const info = WEATHER_CODES[wx.weather_code] || ["🌡️", "Weather"];
  $("wx-icon").textContent = info[0];
  $("wx-desc").textContent = info[1];
  $("wx-temp").textContent = Math.round(wx.temperature_2m) + " °C";
  $("wx-hum").textContent = Math.round(wx.relative_humidity_2m) + " %";
  $("wx-wind").textContent = Math.round(wx.wind_speed_10m) + " km/h";
}

function nowIndex() {
  const now = state.aq.current.time;
  let idx = 0;
  state.aq.hourly.time.forEach((t, i) => { if (t <= now) idx = i; });
  return idx;
}

function renderPlan() {
  const h = state.aq.hourly;
  const key = aqiKey();
  const from = nowIndex();
  let best = null, worst = null;
  for (let i = from; i < Math.min(from + 24, h.time.length); i++) {
    const v = h[key][i];
    if (v === null || v === undefined) continue;
    if (!best || v < best.v) best = { v, t: h.time[i] };
    if (!worst || v > worst.v) worst = { v, t: h.time[i] };
  }
  $("best-time").textContent = best ? fmtTime(best.t) + " · " + Math.round(best.v) : "--";
  $("worst-time").textContent = worst ? fmtTime(worst.t) + " · " + Math.round(worst.v) : "--";
}

function renderPollutants() {
  const box = $("pollutants");
  box.replaceChildren();
  const main = dominantPollutant();

  POLLUTANTS.forEach(p => {
    const raw = state.aq.current[p.key];
    const has = raw !== null && raw !== undefined;
    const tile = el("div", "pol" + (main && main.p === p ? " main" : ""));

    if (main && main.p === p) tile.appendChild(el("span", "pol-badge", "MAIN"));
    tile.appendChild(el("div", "pol-name", p.name));
    tile.appendChild(el("div", "pol-full", p.full));

    const value = el("div", "pol-value");
    if (!has) {
      value.textContent = "–";
    } else if (p.key === "carbon_monoxide") {
      value.textContent = (raw / 1000).toFixed(2) + " ";
      value.appendChild(el("small", "", "mg/m³"));
    } else {
      value.textContent = raw.toFixed(1) + " ";
      value.appendChild(el("small", "", "µg/m³"));
    }
    tile.appendChild(value);

    const bar = el("div", "bar");
    const fill = el("div", "bar-fill");
    const ratio = has ? raw / p.who : 0;
    fill.style.width = Math.min(ratio, 3) / 3 * 100 + "%";
    fill.style.background = ratio <= 1 ? "#5bc16a" : ratio <= 2 ? "#f39c3d" : "#e0524a";
    bar.append(fill, el("span", "bar-mark"));
    tile.appendChild(bar);
    tile.appendChild(el("p", "pol-ratio", has ? ratio.toFixed(1) + "× WHO guideline" : "No data"));

    box.appendChild(tile);
  });
}

function renderActivities() {
  const list = $("activities");
  list.replaceChildren();
  const aqi = currentAqi();
  if (aqi === null) {
    list.appendChild(el("li", "", "No advice available without current data."));
    return;
  }
  const lvl = LEVELS[levelIndex(aqi, state.standard)];
  ACTIVITY_HEADINGS.forEach((h, i) => {
    const li = el("li");
    li.appendChild(el("span", "a-icon", h.icon));
    const text = el("div");
    text.appendChild(el("strong", "", h.title));
    text.appendChild(el("span", "", lvl.acts[i]));
    li.appendChild(text);
    list.appendChild(li);
  });
}

function renderLegend() {
  const list = $("legend");
  list.replaceChildren();
  const aqi = currentAqi();
  const active = aqi === null ? -1 : levelIndex(aqi, state.standard);
  const limits = THRESH[state.standard];

  LEVELS.forEach((lvl, i) => {
    const li = el("li", i === active ? "current" : "");
    const sw = el("span", "swatch");
    sw.style.background = lvl.color;
    li.append(sw, el("span", "", lvl[state.standard]));
    const low = i === 0 ? 0 : limits[i - 1] + 1;
    const range = i === limits.length - 1 ? low + "+" : low + "–" + limits[i];
    li.appendChild(el("span", "range", range));
    list.appendChild(li);
  });
}

// ---------- Chart (hand-drawn SVG) ----------
function renderChart() {
  // Size the drawing to the container so text stays readable on phones
  const W = Math.max(300, Math.round(chartSvg.parentElement.clientWidth || 800));
  const H = W < 500 ? 240 : 280;
  chartSvg.setAttribute("viewBox", "0 0 " + W + " " + H);
  const pad = { l: 38, r: 12, t: 14, b: 30 };
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;

  chartSvg.replaceChildren();
  chartTip.classList.add("hidden");

  const h = state.aq.hourly;
  const key = aqiKey();
  const now = nowIndex();
  const start = Math.max(0, now - 24);
  const end = Math.min(h.time.length - 1, now + 48);

  const pts = [];
  for (let i = start; i <= end; i++) pts.push({ t: h.time[i], v: h[key][i] });
  const valid = pts.filter(p => p.v !== null && p.v !== undefined);
  if (valid.length < 2) {
    const msg = svgEl("text", { x: W / 2, y: H / 2, "text-anchor": "middle", class: "chart-empty" });
    msg.textContent = "Forecast data is not available for this location.";
    chartSvg.appendChild(msg);
    return;
  }

  const limits = THRESH[state.standard];
  const maxV = Math.max(...valid.map(p => p.v));
  const yMax = Math.ceil(Math.max(maxV * 1.15, limits[0] * 1.5) / 20) * 20;
  const xOf = j => pad.l + j / (pts.length - 1) * plotW;
  const yOf = v => pad.t + plotH - v / yMax * plotH;

  // Coloured level bands
  let lower = 0;
  for (let i = 0; i < LEVELS.length && lower < yMax; i++) {
    const upper = Math.min(limits[i], yMax);
    chartSvg.appendChild(svgEl("rect", {
      x: pad.l, width: plotW, y: yOf(upper), height: yOf(lower) - yOf(upper),
      fill: LEVELS[i].color, opacity: 0.2
    }));
    lower = limits[i];
  }

  // Y grid + labels
  for (let k = 0; k <= 4; k++) {
    const v = yMax / 4 * k;
    chartSvg.appendChild(svgEl("line", { x1: pad.l, x2: W - pad.r, y1: yOf(v), y2: yOf(v), class: "chart-grid" }));
    const label = svgEl("text", { x: pad.l - 6, y: yOf(v) + 4, "text-anchor": "end", class: "chart-axis" });
    label.textContent = Math.round(v);
    chartSvg.appendChild(label);
  }

  // X labels every 12 hours
  pts.forEach((p, j) => {
    const hour = p.t.slice(11, 13);
    if (hour === "00" || hour === "12") {
      const label = svgEl("text", { x: xOf(j), y: H - 10, "text-anchor": "middle", class: "chart-axis" });
      label.textContent = hour === "00" ? p.t.slice(8, 10) + "/" + p.t.slice(5, 7) : "12:00";
      chartSvg.appendChild(label);
    }
  });

  // "Now" marker
  const nowJ = now - start;
  chartSvg.appendChild(svgEl("line", { x1: xOf(nowJ), x2: xOf(nowJ), y1: pad.t, y2: pad.t + plotH, class: "chart-now" }));
  const nowLabel = svgEl("text", { x: xOf(nowJ) + 4, y: pad.t + 11, class: "chart-now-label" });
  nowLabel.textContent = "Now";
  chartSvg.appendChild(nowLabel);

  // Line (broken where data is missing)
  let d = "";
  let penDown = false;
  pts.forEach((p, j) => {
    if (p.v === null || p.v === undefined) { penDown = false; return; }
    d += (penDown ? "L" : "M") + xOf(j).toFixed(1) + " " + yOf(p.v).toFixed(1) + " ";
    penDown = true;
  });
  chartSvg.appendChild(svgEl("path", { d: d, class: "chart-line" }));

  // Coloured dots every 3 hours
  pts.forEach((p, j) => {
    if (p.v === null || p.v === undefined || j % 3 !== 0) return;
    chartSvg.appendChild(svgEl("circle", {
      cx: xOf(j), cy: yOf(p.v), r: 3.5,
      fill: LEVELS[levelIndex(p.v, state.standard)].color, stroke: "#1e293b", "stroke-width": 1
    }));
  });

  // Hover / touch interaction
  const cursorLine = svgEl("line", { y1: pad.t, y2: pad.t + plotH, class: "chart-now", opacity: 0 });
  const cursorDot = svgEl("circle", { r: 5, fill: "#fff", stroke: "#1e293b", "stroke-width": 2, opacity: 0 });
  const overlay = svgEl("rect", { x: pad.l, y: pad.t, width: plotW, height: plotH, fill: "transparent" });
  chartSvg.append(cursorLine, cursorDot, overlay);

  overlay.addEventListener("pointermove", event => {
    const box = chartSvg.getBoundingClientRect();
    const x = (event.clientX - box.left) / box.width * W;
    let j = Math.round((x - pad.l) / plotW * (pts.length - 1));
    j = Math.max(0, Math.min(pts.length - 1, j));
    // Find the nearest point that has data
    let p = pts[j];
    for (let off = 1; (p.v === null || p.v === undefined) && off < pts.length; off++) {
      const a = pts[j - off], b = pts[j + off];
      if (a && a.v !== null && a.v !== undefined) { p = a; j -= off; }
      else if (b && b.v !== null && b.v !== undefined) { p = b; j += off; }
    }
    if (p.v === null || p.v === undefined) return;

    cursorLine.setAttribute("x1", xOf(j));
    cursorLine.setAttribute("x2", xOf(j));
    cursorLine.setAttribute("opacity", 1);
    cursorDot.setAttribute("cx", xOf(j));
    cursorDot.setAttribute("cy", yOf(p.v));
    cursorDot.setAttribute("opacity", 1);

    const lvl = LEVELS[levelIndex(p.v, state.standard)];
    chartTip.textContent = fmtTime(p.t) + "  ·  AQI " + Math.round(p.v) + "  ·  " + lvl[state.standard];
    chartTip.style.left = Math.max(15, Math.min(85, xOf(j) / W * 100)) + "%";
    chartTip.classList.remove("hidden");
  });
  overlay.addEventListener("pointerleave", () => {
    cursorLine.setAttribute("opacity", 0);
    cursorDot.setAttribute("opacity", 0);
    chartTip.classList.add("hidden");
  });
}

// ---------- Favourites ("My cities") ----------
function loadFavourites() {
  try {
    const list = JSON.parse(store("aw_favs"));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function saveFavourites() {
  store("aw_favs", JSON.stringify(state.favourites));
}

function isFavourite(city) {
  const key = cityKey(city.lat, city.lon);
  return state.favourites.some(f => cityKey(f.lat, f.lon) === key);
}

function toggleFavourite() {
  const c = state.city;
  if (!c) return;
  if (isFavourite(c)) {
    removeFavourite(c);
    return;
  }
  if (state.favourites.length >= MAX_FAVOURITES) {
    showError("You can save up to " + MAX_FAVOURITES + " cities. Remove one first.");
    return;
  }
  state.favourites.push({ name: c.name, region: c.region, country: c.country, lat: c.lat, lon: c.lon });
  saveFavourites();
  $("fav-btn").textContent = "★ Saved";
  refreshFavouriteData();
}

function removeFavourite(city) {
  const key = cityKey(city.lat, city.lon);
  state.favourites = state.favourites.filter(f => cityKey(f.lat, f.lon) !== key);
  saveFavourites();
  if (state.city && cityKey(state.city.lat, state.city.lon) === key) $("fav-btn").textContent = "☆ Save city";
  renderFavourites();
}

// One request fetches the current AQI of every saved city
async function refreshFavouriteData() {
  const favs = state.favourites.slice();
  if (favs.length === 0) { renderFavourites(); return; }
  try {
    const data = await fetchJSON(AQ_URL, {
      latitude: favs.map(f => f.lat).join(","),
      longitude: favs.map(f => f.lon).join(","),
      current: "us_aqi,european_aqi",
      timezone: "auto"
    });
    const results = Array.isArray(data) ? data : [data];
    const map = {};
    favs.forEach((f, i) => { map[cityKey(f.lat, f.lon)] = results[i] && results[i].current ? results[i].current : null; });
    state.favData = map;
  } catch {
    state.favData = {};
  }
  renderFavourites();
}

function renderFavourites() {
  const box = $("fav-list");
  box.replaceChildren();
  if (state.favourites.length === 0) {
    box.appendChild(el("p", "fav-empty", "No saved cities yet. Search a city and press “Save city” to compare it here."));
    return;
  }

  const rows = state.favourites.map(f => {
    const cur = state.favData[cityKey(f.lat, f.lon)];
    const v = cur ? cur[aqiKey()] : null;
    return { city: f, aqi: v === null || v === undefined ? null : Math.round(v) };
  });
  rows.sort((a, b) => (b.aqi === null ? -1 : b.aqi) - (a.aqi === null ? -1 : a.aqi));

  rows.forEach((row, i) => {
    const card = el("div", "fav");
    card.title = "Show " + cityLabel(row.city);
    card.appendChild(el("span", "fav-rank", "#" + (i + 1)));

    const name = el("div", "fav-name", row.city.name);
    name.appendChild(el("small", "", row.city.country));
    card.appendChild(name);

    const chip = el("span", "fav-aqi", row.aqi === null ? "–" : String(row.aqi));
    if (row.aqi !== null) {
      const lvl = LEVELS[levelIndex(row.aqi, state.standard)];
      chip.style.background = lvl.color;
      chip.style.color = lvl.text;
    }
    card.appendChild(chip);

    const remove = el("button", "fav-remove", "×");
    remove.title = "Remove";
    remove.setAttribute("aria-label", "Remove " + row.city.name);
    remove.addEventListener("click", event => {
      event.stopPropagation();
      removeFavourite(row.city);
    });
    card.appendChild(remove);

    card.addEventListener("click", () => loadCity(row.city));
    box.appendChild(card);
  });
}

// ---------- Search with autocomplete ----------
let suggestTimer = null;
let suggestRequest = 0;
let suggestions = [];
let activeSuggestion = -1;

function hideSuggestions() {
  suggestionsEl.classList.add("hidden");
  suggestionsEl.replaceChildren();
  suggestions = [];
  activeSuggestion = -1;
}

function renderSuggestions() {
  suggestionsEl.replaceChildren();
  if (suggestions.length === 0) {
    suggestionsEl.appendChild(el("li", "empty", "No matching places"));
  }
  suggestions.forEach((city, i) => {
    const li = el("li", i === activeSuggestion ? "active" : "");
    li.setAttribute("role", "option");
    li.appendChild(document.createTextNode(city.name + " "));
    li.appendChild(el("small", "", [city.region, city.country].filter(Boolean).join(", ")));
    li.addEventListener("click", () => chooseCity(city));
    suggestionsEl.appendChild(li);
  });
  suggestionsEl.classList.remove("hidden");
}

function chooseCity(city) {
  hideSuggestions();
  searchInput.value = "";
  loadCity(city);
}

searchInput.addEventListener("input", () => {
  clearTimeout(suggestTimer);
  const query = searchInput.value.trim();
  if (query.length < 2) { hideSuggestions(); return; }
  suggestTimer = setTimeout(async () => {
    const id = ++suggestRequest;
    try {
      const results = await searchCities(query, 6);
      if (id !== suggestRequest) return;
      suggestions = results;
      activeSuggestion = -1;
      renderSuggestions();
    } catch {
      hideSuggestions();
    }
  }, 300);
});

searchInput.addEventListener("keydown", event => {
  if (event.key === "Escape") { hideSuggestions(); return; }
  if (suggestions.length === 0) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    activeSuggestion = (activeSuggestion + step + suggestions.length) % suggestions.length;
    renderSuggestions();
  } else if (event.key === "Enter" && activeSuggestion >= 0) {
    event.preventDefault();
    chooseCity(suggestions[activeSuggestion]);
  }
});

document.addEventListener("click", event => {
  if (!event.target.closest(".search-box")) hideSuggestions();
});

form.addEventListener("submit", async event => {
  event.preventDefault();
  clearTimeout(suggestTimer);
  suggestRequest++;                   // drop any pending autocomplete result
  const query = searchInput.value.trim();
  if (!query) return;
  clearError();
  setLoading(true);
  try {
    const results = await searchCities(query, 1);
    if (results.length === 0) {
      setLoading(false);
      showError("No city found for “" + query + "”. Check the spelling or try an English name.");
      return;
    }
    chooseCity(results[0]);
  } catch (error) {
    setLoading(false);
    showError("Search failed: " + error.message);
  }
});

// ---------- My location ----------
locateBtn.addEventListener("click", () => {
  if (!navigator.geolocation) { showError("Your browser does not support location."); return; }
  clearError();
  setLoading(true);
  navigator.geolocation.getCurrentPosition(
    pos => loadCity({ name: "My location", region: "", country: "", lat: pos.coords.latitude, lon: pos.coords.longitude }),
    () => { setLoading(false); showError("Could not get your location. Allow location access or search for a city."); },
    { timeout: 10000 }
  );
});

// ---------- Other controls ----------
function setStandard(std) {
  state.standard = std;
  store("aw_standard", std);
  if (state.aq) renderAll();
}
$("std-us").addEventListener("click", () => setStandard("us"));
$("std-eu").addEventListener("click", () => setStandard("eu"));
$("fav-btn").addEventListener("click", toggleFavourite);
$("refresh-btn").addEventListener("click", () => {
  if (state.city) { loadCity(state.city); refreshFavouriteData(); }
});

// Redraw the chart when the window width changes
let resizeTimer = null;
let lastChartWidth = 0;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const w = chartSvg.parentElement.clientWidth;
    if (state.aq && w !== lastChartWidth) { lastChartWidth = w; renderChart(); }
  }, 150);
});

// ---------- Init ----------
(function init() {
  let city = DEFAULT_CITY;
  try {
    const saved = JSON.parse(store("aw_city"));
    if (saved && typeof saved.lat === "number" && typeof saved.lon === "number") city = saved;
  } catch { /* use default */ }
  renderFavourites();
  loadCity(city);
  refreshFavouriteData();
})();
