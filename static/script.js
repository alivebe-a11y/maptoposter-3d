/* ========================================
   MapToPoster 3D — script.js
   ======================================== */

// ---- Global State ----
let previewMap = null;
let captureMap = null;
let selectedThemes = [];
let lightPreset = 'dusk';
let syncingFromMap = false; // guard: prevents map→slider→syncPreviewMap loop

// ---- Distance ↔ Zoom Conversion ----
// Formula based on 4096px capture canvas, Mapbox 512px tile size:
//   visible_half_width = (captureSize/2) * (earthCirc * cos(lat)) / (tileSize * 2^zoom)
//   Setting that equal to distanceMeters and solving for zoom gives:
const _EARTH_CIRC = 40075016.686;
const _CAPTURE_HALF = 4096 / 2;
const _TILE = 512;

function distanceToZoom(distanceMeters, lat) {
  const latRad = (lat || 51.5) * Math.PI / 180;
  const zoom = Math.log2(_CAPTURE_HALF * _EARTH_CIRC * Math.cos(latRad) / (_TILE * distanceMeters));
  return Math.max(8, Math.min(22, parseFloat(zoom.toFixed(1))));
}

function zoomToDistance(zoom, lat) {
  const latRad = (lat || 51.5) * Math.PI / 180;
  const d = _CAPTURE_HALF * _EARTH_CIRC * Math.cos(latRad) / (_TILE * Math.pow(2, zoom));
  return Math.round(Math.max(1000, Math.min(30000, d)));
}

function formatDistance(meters) {
  return (meters / 1000).toFixed(1) + ' km';
}

// ---- Init ----
document.addEventListener('DOMContentLoaded', () => {
  if (typeof mapboxgl === 'undefined') {
    showStatus('Mapbox GL JS failed to load. Check your internet connection.', 'error');
    return;
  }
  if (!window.MAPBOX_TOKEN) {
    document.getElementById('tokenWarning').classList.add('show');
  }
  mapboxgl.accessToken = window.MAPBOX_TOKEN || '';

  initThemeList();
  initStadiumAutocomplete();
  initCitySearch();
  initSliders();
  initLightingButtons();
  initBadgeScaleSlider();
  initFormHandlers();
});

// ---- Theme List ----
function initThemeList() {
  const container = document.getElementById('themeList');
  if (!container) return;
  const themes = window.THEME_KEYS || [];
  const themesData = window.THEMES || {};

  themes.forEach(key => {
    const td = themesData[key] || {};
    const item = document.createElement('div');
    item.className = 'theme-item';
    item.dataset.theme = key;

    const bgColor = (td.mapbox_paint && td.mapbox_paint.background) || td.bg || '#111';
    const roadColor = (td.mapbox_paint && td.mapbox_paint.road_major) || '#fff';

    item.innerHTML = `
      <div class="theme-checkbox">
        <svg class="theme-checkbox-tick" viewBox="0 0 10 8" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M1 4L3.5 6.5L9 1" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
      <div class="theme-swatch" style="background:${bgColor}; border-color: ${roadColor}33;"></div>
      <span class="theme-label">${td.name || formatThemeName(key)}</span>
    `;

    item.addEventListener('click', () => toggleTheme(key, item));
    container.appendChild(item);
  });
}

function formatThemeName(key) {
  return key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function toggleTheme(key, el) {
  const idx = selectedThemes.indexOf(key);
  if (idx === -1) {
    selectedThemes.push(key);
    el.classList.add('selected');
  } else {
    selectedThemes.splice(idx, 1);
    el.classList.remove('selected');
  }
  updateThemeCount();
  // Live-update the preview map with the first selected theme
  if (previewMap && previewMap.isStyleLoaded()) {
    applyThemePaint(previewMap, selectedThemes[0] || null);
  }
}

function updateThemeCount() {
  const el = document.getElementById('themeCount');
  if (!el) return;
  if (selectedThemes.length === 0) {
    el.textContent = 'None selected';
  } else if (selectedThemes.length === 1) {
    const td = window.THEMES && window.THEMES[selectedThemes[0]];
    el.textContent = td ? (td.name || formatThemeName(selectedThemes[0])) : selectedThemes[0];
  } else {
    el.textContent = `${selectedThemes.length} themes`;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('selectAllBtn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const items = document.querySelectorAll('.theme-item');
    const allSelected = selectedThemes.length === items.length;
    items.forEach(item => {
      const key = item.dataset.theme;
      if (allSelected) {
        item.classList.remove('selected');
      } else {
        if (!selectedThemes.includes(key)) {
          selectedThemes.push(key);
        }
        item.classList.add('selected');
      }
    });
    if (allSelected) selectedThemes = [];
    btn.textContent = allSelected ? 'Select All' : 'Clear All';
    updateThemeCount();
    updateThemeOverlay(selectedThemes[0] || null);
  });
});

// ---- Stadium Autocomplete ----
function initStadiumAutocomplete() {
  const input = document.getElementById('stadiumInput');
  const clearBtn = document.getElementById('stadiumClear');
  if (!input) return;

  input.addEventListener('input', () => {
    clearBtn.style.display = input.value ? 'block' : 'none';
    tryAutoFillStadium(input.value);
  });

  input.addEventListener('change', () => {
    tryAutoFillStadium(input.value);
  });

  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      input.value = '';
      clearBtn.style.display = 'none';
      clearStadiumFields();
    });
  }
}

function tryAutoFillStadium(name) {
  const stadiums = window.STADIUMS || {};
  // Exact match
  if (stadiums[name]) {
    fillStadiumData(stadiums[name]);
    return;
  }
  // Case-insensitive match
  const lower = name.toLowerCase();
  for (const [k, s] of Object.entries(stadiums)) {
    if (k.toLowerCase() === lower || (s.key && s.key.toLowerCase() === lower)) {
      fillStadiumData(s);
      return;
    }
  }
}

function fillStadiumData(s) {
  const dv = s.default_view || {};
  const zoom = dv.zoom !== undefined ? dv.zoom : 16.5;
  const pitch = dv.pitch !== undefined ? dv.pitch : 55;
  const bearing = dv.bearing !== undefined ? dv.bearing : 0;

  setFieldValue('lat', s.lat);
  setFieldValue('lon', s.lon);

  // Convert default zoom to distance for the distance slider
  const dist = zoomToDistance(zoom, s.lat);
  const distEl = document.getElementById('distanceSlider');
  const distDisp = document.getElementById('distanceSliderVal');
  if (distEl) { distEl.value = dist; if (distDisp) distDisp.textContent = formatDistance(dist); }

  setSliderValue('pitchSlider', pitch);
  setSliderValue('bearingSlider', bearing);

  if (previewMap) {
    previewMap.flyTo({ center: [s.lon, s.lat], zoom, pitch, bearing, duration: 1800 });
  }
}

function clearStadiumFields() {
  // Don't clear lat/lon, just leave as-is
}

function setFieldValue(id, val) {
  const el = document.getElementById(id);
  if (el) el.value = val;
}

function setSliderValue(id, val) {
  const el = document.getElementById(id);
  if (!el) return;
  el.value = val;
  const display = document.getElementById(id + 'Val');
  if (display) display.textContent = val;
}

// ---- City / Town / Village Geocoder ----
function initCitySearch() {
  const input = document.getElementById('citySearch');
  const btn = document.getElementById('citySearchBtn');
  if (!input || !btn) return;

  btn.addEventListener('click', () => geocodeCity(input.value.trim()));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); geocodeCity(input.value.trim()); }
  });
}

async function geocodeCity(query) {
  if (!query) return;
  const token = window.MAPBOX_TOKEN;
  if (!token) { showStatus('Mapbox token required for geocoding.', 'error'); return; }

  const resultsEl = document.getElementById('cityResults');
  if (resultsEl) resultsEl.innerHTML = '<span class="city-searching">Searching…</span>';

  try {
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json` +
      `?access_token=${token}&limit=5&types=place,locality,neighborhood,region,country`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Geocoding failed: ${resp.status}`);
    const data = await resp.json();
    showGeocodeResults(data.features || []);
  } catch (e) {
    if (resultsEl) resultsEl.innerHTML = `<span class="city-error">${e.message}</span>`;
  }
}

function showGeocodeResults(features) {
  const el = document.getElementById('cityResults');
  if (!el) return;
  if (!features.length) {
    el.innerHTML = '<span class="city-error">No results found.</span>';
    return;
  }
  el.innerHTML = features.map((f, i) => `
    <div class="city-result-item" data-idx="${i}"
         data-lat="${f.center[1]}" data-lon="${f.center[0]}"
         data-name="${f.place_name.replace(/"/g, '&quot;')}">
      <span class="city-result-name">${f.place_name}</span>
    </div>
  `).join('');

  el.querySelectorAll('.city-result-item').forEach(item => {
    item.addEventListener('click', () => {
      const lat = parseFloat(item.dataset.lat);
      const lon = parseFloat(item.dataset.lon);
      setFieldValue('lat', lat.toFixed(5));
      setFieldValue('lon', lon.toFixed(5));
      if (previewMap) {
        previewMap.flyTo({ center: [lon, lat], duration: 1200 });
      }
      el.innerHTML = `<span class="city-selected">&#10003; ${item.dataset.name}</span>`;
      document.getElementById('citySearch').value = '';
    });
  });
}

// ---- Sliders ----
function initSliders() {
  // Distance slider: display as km
  const distEl = document.getElementById('distanceSlider');
  const distDisp = document.getElementById('distanceSliderVal');
  if (distEl) {
    distEl.addEventListener('input', () => {
      if (distDisp) distDisp.textContent = formatDistance(parseInt(distEl.value, 10));
      syncPreviewMap();
    });
  }

  // Pitch and bearing sliders
  ['pitchSlider', 'bearingSlider'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const display = document.getElementById(id + 'Val');
    el.addEventListener('input', () => {
      if (display) display.textContent = el.value;
      syncPreviewMap();
    });
  });
}

// ---- Lighting Buttons ----
function initLightingButtons() {
  document.querySelectorAll('.lighting-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.lighting-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      lightPreset = btn.dataset.preset;
      if (previewMap) {
        try { previewMap.setConfigProperty('basemap', 'lightPreset', lightPreset); } catch (e) {}
      }
    });
  });
}

// ---- Badge Scale Slider ----
function initBadgeScaleSlider() {
  const el = document.getElementById('badgeScale');
  const disp = document.getElementById('badgeScaleVal');
  if (!el) return;
  el.addEventListener('input', () => {
    if (disp) disp.textContent = el.value + '%';
  });
}

// ---- 3D Config ----
function get3DConfig() {
  const latVal = parseFloat(document.getElementById('lat')?.value);
  const lonVal = parseFloat(document.getElementById('lon')?.value);
  const lat = isNaN(latVal) ? 51.5 : latVal;
  const lon = isNaN(lonVal) ? 0 : lonVal;
  const distance = parseInt(document.getElementById('distanceSlider')?.value || 3000, 10);
  return {
    lat,
    lon,
    distance,
    zoom: distanceToZoom(distance, lat),
    pitch: parseFloat(document.getElementById('pitchSlider')?.value) || 55,
    bearing: parseFloat(document.getElementById('bearingSlider')?.value) || 0,
    lightPreset,
    badgeScale: parseInt(document.getElementById('badgeScale')?.value || 18, 10)
  };
}

// ---- Basemap Config ----
const STANDARD_STYLE = 'mapbox://styles/mapbox/standard';

function applyBasemapConfig(map, lp) {
  try { map.setConfigProperty('basemap', 'lightPreset', lp || 'dusk'); } catch (e) {}
  try { map.setConfigProperty('basemap', 'showPointOfInterestLabels', false); } catch (e) {}
  try { map.setConfigProperty('basemap', 'showPlaceLabels', false); } catch (e) {}
  try { map.setConfigProperty('basemap', 'showRoadLabels', false); } catch (e) {}
  try { map.setConfigProperty('basemap', 'showTransitLabels', false); } catch (e) {}
}

// ---- Theme Preview Overlay ----
// Applies a CSS colour tint matching the PIL compositor's 25%-opacity tint so
// the user sees instant theme feedback on the preview map without re-rendering.
function updateThemeOverlay(themeName) {
  const overlay = document.getElementById('mapThemeOverlay');
  const mapEl = document.getElementById('mapPreview');
  if (!overlay) return;

  if (!themeName || !window.THEMES || !window.THEMES[themeName]) {
    overlay.style.display = 'none';
    return;
  }

  const bg = window.THEMES[themeName].bg || '#000000';
  // Convert hex to rgba at 25% opacity (matching PIL tint alpha 64/255 ≈ 25%)
  const r = parseInt(bg.slice(1, 3), 16);
  const g = parseInt(bg.slice(3, 5), 16);
  const b = parseInt(bg.slice(5, 7), 16);
  overlay.style.background = `rgba(${r},${g},${b},0.25)`;

  // Only show overlay when map is visible
  if (mapEl && mapEl.style.display !== 'none') {
    overlay.style.display = 'block';
  }
}

// ---- Apply Theme Paint ----
// NOTE: Mapbox Standard style (v3) does NOT expose colour config properties
// (colorBackground, colorWater, colorRoads, etc.) — those calls silently fail.
// The only valid config properties are: lightPreset, showPointOfInterestLabels,
// showPlaceLabels, showRoadLabels, showTransitLabels.
// Theme colours are applied in the PIL compositor (create_poster.py) via a
// per-theme colour tint over the captured map image.
// This function is intentionally kept for custom-style compatibility if the
// Standard style ever exposes these, but currently only updates the overlay.
function applyThemePaint(map, themeName) {
  updateThemeOverlay(themeName);
}

// ---- Preview Map ----
function syncPreviewMap() {
  if (!previewMap || syncingFromMap) return;
  const cfg = get3DConfig();
  if (!cfg.lon) return;
  previewMap.setCenter([cfg.lon, cfg.lat]);
  previewMap.setZoom(cfg.zoom);
  previewMap.setPitch(cfg.pitch);
  previewMap.setBearing(cfg.bearing);
}

document.addEventListener('DOMContentLoaded', () => {
  const previewBtn = document.getElementById('previewBtn');
  if (!previewBtn) return;

  previewBtn.addEventListener('click', () => {
    if (!window.MAPBOX_TOKEN) {
      showStatus('No Mapbox token set. Add MAPBOX_TOKEN to your .env file.', 'error');
      return;
    }
    initPreviewMap();
  });
});

function initPreviewMap() {
  const cfg = get3DConfig();
  const container = document.getElementById('mapPreview');
  if (!container) return;

  // Show the map container
  document.getElementById('previewPlaceholder').style.display = 'none';
  container.style.display = 'block';
  updateThemeOverlay(selectedThemes[0] || null);

  if (previewMap) {
    previewMap.setCenter([cfg.lon, cfg.lat]);
    previewMap.setZoom(cfg.zoom);
    previewMap.setPitch(cfg.pitch);
    previewMap.setBearing(cfg.bearing);
    try { previewMap.setConfigProperty('basemap', 'lightPreset', cfg.lightPreset); } catch (e) {}

    const activeTheme = selectedThemes[0] || null;
    if (activeTheme && previewMap.isStyleLoaded()) {
      applyThemePaint(previewMap, activeTheme);
    }
    return;
  }

  previewMap = new mapboxgl.Map({
    container: 'mapPreview',
    style: STANDARD_STYLE,
    center: [cfg.lon, cfg.lat],
    zoom: cfg.zoom,
    pitch: cfg.pitch,
    bearing: cfg.bearing,
    interactive: true,
    preserveDrawingBuffer: true,
    antialias: true
  });

  previewMap.on('style.load', () => {
    applyBasemapConfig(previewMap, cfg.lightPreset);
    const activeTheme = selectedThemes[0] || null;
    if (activeTheme) applyThemePaint(previewMap, activeTheme);
  });

  previewMap.on('move', () => {
    syncingFromMap = true;
    try {
      const c = previewMap.getCenter();
      setFieldValue('lat', c.lat.toFixed(5));
      setFieldValue('lon', c.lng.toFixed(5));

      // Convert live zoom → distance and update slider
      const currentZoom = previewMap.getZoom();
      const dist = zoomToDistance(currentZoom, c.lat);
      const dv = document.getElementById('distanceSlider');
      const dvd = document.getElementById('distanceSliderVal');
      if (dv) { dv.value = dist; if (dvd) dvd.textContent = formatDistance(dist); }

      const pitch = previewMap.getPitch().toFixed(0);
      const bearing = previewMap.getBearing().toFixed(0);
      const pv = document.getElementById('pitchSlider');
      const pvd = document.getElementById('pitchSliderVal');
      if (pv) { pv.value = pitch; if (pvd) pvd.textContent = pitch; }
      const bv = document.getElementById('bearingSlider');
      const bvd = document.getElementById('bearingSliderVal');
      if (bv) { bv.value = bearing; if (bvd) bvd.textContent = bearing; }
    } finally {
      syncingFromMap = false;
    }
  });
}

// ---- Capture Map (offscreen 4096x4096) ----
function capture3DMap() {
  return new Promise((resolve, reject) => {
    if (!window.MAPBOX_TOKEN) return reject('No Mapbox token');
    const cfg = get3DConfig();
    const activeTheme = selectedThemes[0] || null;

    if (captureMap) {
      captureMap.remove();
      captureMap = null;
    }

    captureMap = new mapboxgl.Map({
      container: 'captureMap',
      style: STANDARD_STYLE,
      center: [cfg.lon, cfg.lat],
      zoom: cfg.zoom,
      pitch: cfg.pitch,
      bearing: cfg.bearing,
      interactive: false,
      preserveDrawingBuffer: true,
      antialias: true,
      fadeDuration: 0
    });

    let captured = false;

    captureMap.on('style.load', () => {
      applyBasemapConfig(captureMap, cfg.lightPreset);
      try { captureMap.setConfigProperty('basemap', 'colorBackground', '#050505'); } catch (e) {}
      if (activeTheme) applyThemePaint(captureMap, activeTheme);
    });

    captureMap.on('idle', () => {
      if (captured) return;
      // Extra delay for 3D buildings to render
      setTimeout(() => {
        if (captured) return;
        captured = true;
        try {
          const canvas = captureMap.getCanvas();
          const dataUrl = canvas.toDataURL('image/png');
          resolve(dataUrl);
        } catch (e) {
          reject(e);
        }
      }, 2000);
    });

    // Timeout fallback
    setTimeout(() => {
      if (!captured) {
        captured = true;
        try {
          const canvas = captureMap.getCanvas();
          const dataUrl = canvas.toDataURL('image/png');
          resolve(dataUrl);
        } catch (e) {
          reject('Capture timeout');
        }
      }
    }, 15000);
  });
}

// ---- Form Handlers ----
function initFormHandlers() {
  const form = document.getElementById('posterForm');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    await generatePosters();
  });
}

async function generatePosters() {
  if (selectedThemes.length === 0) {
    showStatus('Please select at least one theme.', 'error');
    return;
  }

  const cfg = get3DConfig();
  if (!cfg.lat || !cfg.lon) {
    showStatus('Please enter valid coordinates or select a stadium.', 'error');
    return;
  }

  const generateBtn = document.getElementById('generateBtn');
  setButtonLoading(generateBtn, true);
  showStatus('Capturing 3D map...', 'info');
  hideResult();

  let mapboxCapture = null;

  try {
    if (window.MAPBOX_TOKEN) {
      mapboxCapture = await capture3DMap();
    }
  } catch (e) {
    console.warn('Capture failed:', e);
    showStatus('Map capture failed, generating without map image...', 'info');
  }

  const stadiumName = document.getElementById('stadiumInput')?.value || '';
  const badge = document.getElementById('badgeSelect')?.value || '';

  showStatus('Generating poster(s)...', 'info');

  try {
    const payload = {
      themes: selectedThemes,
      stadium: stadiumName,
      badge: badge,
      overlay_config: cfg
    };

    if (mapboxCapture) {
      payload.mapbox_capture = mapboxCapture;
    }

    const resp = await fetch('/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await resp.json();

    if (!data.success) {
      showStatus('Error: ' + (data.error || 'Unknown error'), 'error');
      return;
    }

    hideStatus();

    if (data.batch) {
      showBatchResult(data.count, data.themes);
    } else {
      showSingleResult(data.filename);
    }
  } catch (e) {
    showStatus('Request failed: ' + e.message, 'error');
  } finally {
    setButtonLoading(generateBtn, false);
  }
}

// ---- Result Display ----
function showSingleResult(filename) {
  const container = document.getElementById('resultContainer');
  if (!container) return;

  container.innerHTML = `
    <div class="poster-result">
      <img class="poster-result-img" src="/posters/${encodeURIComponent(filename)}"
           alt="Generated Poster"
           onclick="window.open(this.src, '_blank')" />
      <a class="download-btn" href="/posters/${encodeURIComponent(filename)}" download="${filename}">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        Download Poster
      </a>
    </div>
  `;

  document.getElementById('previewPlaceholder').style.display = 'none';
}

function showBatchResult(count, themes) {
  const container = document.getElementById('resultContainer');
  if (!container) return;

  const tags = themes.map(t => {
    const td = window.THEMES && window.THEMES[t];
    return `<span class="batch-theme-tag">${td ? td.name : formatThemeName(t)}</span>`;
  }).join('');

  container.innerHTML = `
    <div class="batch-success">
      <div class="batch-success-icon">&#10003;</div>
      <h3>${count} Poster${count !== 1 ? 's' : ''} Generated</h3>
      <p>Your posters have been saved to the <strong>posters/</strong> folder.</p>
      <div class="batch-theme-list">${tags}</div>
    </div>
  `;

  document.getElementById('previewPlaceholder').style.display = 'none';
}

function hideResult() {
  const container = document.getElementById('resultContainer');
  if (container) container.innerHTML = '';
}

// ---- Status Messages ----
function showStatus(msg, type) {
  const el = document.getElementById('statusMsg');
  if (!el) return;
  el.textContent = msg;
  el.className = `status-msg show ${type}`;
}

function hideStatus() {
  const el = document.getElementById('statusMsg');
  if (el) el.className = 'status-msg';
}

// ---- Button Loading State ----
function setButtonLoading(btn, loading) {
  if (!btn) return;
  if (loading) {
    btn.classList.add('loading');
    btn.disabled = true;
  } else {
    btn.classList.remove('loading');
    btn.disabled = false;
  }
}
