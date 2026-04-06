/* ========================================
   MapToPoster 3D — script.js
   ======================================== */

// ---- Global State ----
let previewMap = null;
let captureMap = null;
let selectedThemes = [];
let lightPreset = 'dusk';
let overlaySize = 'medium';

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
  initSliders();
  initLightingButtons();
  initSizeButtons();
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
  setFieldValue('lat', s.lat);
  setFieldValue('lon', s.lon);
  setSliderValue('zoomSlider', dv.zoom !== undefined ? dv.zoom : 16.5);
  setSliderValue('pitchSlider', dv.pitch !== undefined ? dv.pitch : 55);
  setSliderValue('bearingSlider', dv.bearing !== undefined ? dv.bearing : 0);

  // Sync preview map if active
  if (previewMap) {
    previewMap.flyTo({
      center: [s.lon, s.lat],
      zoom: dv.zoom !== undefined ? dv.zoom : 16.5,
      pitch: dv.pitch !== undefined ? dv.pitch : 55,
      bearing: dv.bearing !== undefined ? dv.bearing : 0,
      duration: 1800
    });
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

// ---- Sliders ----
function initSliders() {
  const sliders = ['zoomSlider', 'pitchSlider', 'bearingSlider'];
  sliders.forEach(id => {
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

// ---- Size Buttons ----
function initSizeButtons() {
  document.querySelectorAll('.size-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.size-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      overlaySize = btn.dataset.size;
    });
  });
}

// ---- 3D Config ----
function get3DConfig() {
  return {
    lat: parseFloat(document.getElementById('lat')?.value || 0),
    lon: parseFloat(document.getElementById('lon')?.value || 0),
    zoom: parseFloat(document.getElementById('zoomSlider')?.value || 16.5),
    pitch: parseFloat(document.getElementById('pitchSlider')?.value || 55),
    bearing: parseFloat(document.getElementById('bearingSlider')?.value || 0),
    lightPreset,
    overlaySize
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

// ---- Apply Theme Paint ----
function applyThemePaint(map, themeName) {
  if (!themeName || !window.THEMES) return;
  const theme = window.THEMES[themeName];
  if (!theme || !theme.mapbox_paint) return;
  const paint = theme.mapbox_paint;

  const safeSet = (layerId, prop, value) => {
    try {
      if (map.getLayer(layerId)) {
        map.setPaintProperty(layerId, prop, value);
      }
    } catch (e) {}
  };

  // Background
  if (paint.background) {
    safeSet('land', 'background-color', paint.background);
    try {
      map.setConfigProperty('basemap', 'colorBackground', paint.background);
    } catch (e) {}
  }
  if (paint.water) {
    try { map.setConfigProperty('basemap', 'colorWater', paint.water); } catch (e) {}
  }
  if (paint.park) {
    try { map.setConfigProperty('basemap', 'colorGreen', paint.park); } catch (e) {}
  }
  if (paint.road_major) {
    try { map.setConfigProperty('basemap', 'colorRoads', paint.road_major); } catch (e) {}
  }
  if (paint.building) {
    try { map.setConfigProperty('basemap', 'colorBuildings', paint.building); } catch (e) {}
  }
}

// ---- Preview Map ----
function syncPreviewMap() {
  if (!previewMap) return;
  const cfg = get3DConfig();
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
    const c = previewMap.getCenter();
    setFieldValue('lat', c.lat.toFixed(5));
    setFieldValue('lon', c.lng.toFixed(5));
    const zv = document.getElementById('zoomSlider');
    const zvd = document.getElementById('zoomSliderVal');
    if (zv) { zv.value = previewMap.getZoom().toFixed(1); if (zvd) zvd.textContent = previewMap.getZoom().toFixed(1); }
    const pv = document.getElementById('pitchSlider');
    const pvd = document.getElementById('pitchSliderVal');
    if (pv) { pv.value = previewMap.getPitch().toFixed(0); if (pvd) pvd.textContent = previewMap.getPitch().toFixed(0); }
    const bv = document.getElementById('bearingSlider');
    const bvd = document.getElementById('bearingSliderVal');
    if (bv) { bv.value = previewMap.getBearing().toFixed(0); if (bvd) bvd.textContent = previewMap.getBearing().toFixed(0); }
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
