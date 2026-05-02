/* ========================================
   MapToPoster 3D — script.js
   ======================================== */

// ---- Global State ----
let previewMap = null;
let captureMap = null;
let selectedThemes = [];
let lightPreset = 'dusk';
let syncingFromMap = false; // guard: prevents map→slider→syncPreviewMap loop
let currentPreviewStyleUrl = null; // tracks active style to avoid redundant setStyle calls

// ---- Map Layers State ----
let show3dBuildings = true;
let show3dTerrain = false;
let terrainExaggeration = 1.5;
let showContours = false;
let contourUnit = 'meters';
let roadWidthMultiplier = 1.0;
let roadLayerOriginalWidths = {}; // { layerId: original line-width value }
let showLabels = false; // off by default for clean poster look
let badgePosition = 'center'; // 'center' (default) or 'bottom'

// ---- Distance ↔ Zoom Conversion ----
// Formula based on 4096px capture canvas, Mapbox 512px tile size:
//   visible_half_width = (captureSize/2) * (earthCirc * cos(lat)) / (tileSize * 2^zoom)
//   Setting that equal to distanceMeters and solving for zoom gives:
const _EARTH_CIRC = 40075016.686;
const _CAPTURE_HALF = 4096 / 2;
const _TILE = 512;

function distanceToZoom(distanceMeters, lat) {
  if (distanceMeters <= 0) return 22; // 0 m = maximum zoom
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
  initMapLayersControls();
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

  // Convert default zoom to distance for the distance slider + number input
  const dist = zoomToDistance(zoom, s.lat);
  const distEl = document.getElementById('distanceSlider');
  const distIn = document.getElementById('distanceInput');
  if (distEl) distEl.value = dist;
  if (distIn) distIn.value = dist;

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
  // Also update the paired number input
  const pair = SLIDER_INPUT_PAIRS.find(p => p.slider === id);
  if (pair) {
    const inEl = document.getElementById(pair.input);
    if (inEl) inEl.value = val;
  }
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
// Each slider is paired with a number input for precise manual entry.
// They are kept in sync bidirectionally.
const SLIDER_INPUT_PAIRS = [
  { slider: 'distanceSlider', input: 'distanceInput', min: 0,    max: 30000, step: 100 },
  { slider: 'pitchSlider',    input: 'pitchInput',    min: 0,    max: 85,    step: 1   },
  { slider: 'bearingSlider',  input: 'bearingInput',  min: -180, max: 180,   step: 1   },
];

function clamp(val, min, max) { return Math.min(max, Math.max(min, val)); }

function initSliders() {
  SLIDER_INPUT_PAIRS.forEach(({ slider, input, min, max }) => {
    const slEl = document.getElementById(slider);
    const inEl = document.getElementById(input);
    if (!slEl) return;

    // Slider → input
    slEl.addEventListener('input', () => {
      if (inEl) inEl.value = slEl.value;
      syncPreviewMap();
    });

    // Input → slider (on change/enter, clamped to valid range)
    if (inEl) {
      inEl.addEventListener('input', () => {
        const v = clamp(parseFloat(inEl.value) || 0, min, max);
        slEl.value = v;
        inEl.value = v;
        syncPreviewMap();
      });
      inEl.addEventListener('change', () => {
        const v = clamp(parseFloat(inEl.value) || 0, min, max);
        slEl.value = v;
        inEl.value = v;
        syncPreviewMap();
      });
    }
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
  const distance = parseInt(document.getElementById('distanceInput')?.value ?? document.getElementById('distanceSlider')?.value ?? 3000, 10);
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

function getThemeStyleUrl(themeName) {
  if (!themeName) return STANDARD_STYLE;
  const td = window.THEMES && window.THEMES[themeName];
  if (!td || !td.style_url) return STANDARD_STYLE;
  // Relative URLs (custom themes served from Flask) need to be made absolute
  // so Mapbox GL JS can fetch them correctly.
  const url = td.style_url;
  if (url.startsWith('/')) return window.location.origin + url;
  return url;
}

function applyBasemapConfig(map, lp) {
  try { map.setConfigProperty('basemap', 'lightPreset', lp || 'dusk'); } catch (e) {}
  // Labels handled by applyMapLabels (driven by the showLabels toggle)
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
// For themes with a style_url: switches the map to their Mapbox style so the
// map itself renders in that theme's colours (roads, water, buildings etc.).
// For themes without a style_url: stays on Standard + shows a 25%-opacity
// colour tint overlay (PIL compositor mirrors this for the printed poster).
function applyThemePaint(map, themeName) {
  const styleUrl = getThemeStyleUrl(themeName);
  const isPreview = (map === previewMap);

  if (isPreview && styleUrl !== currentPreviewStyleUrl) {
    currentPreviewStyleUrl = styleUrl;
    roadLayerOriginalWidths = {}; // invalidate cache for new style
    map.setStyle(styleUrl);
    map.once('style.load', () => {
      if (styleUrl === STANDARD_STYLE) {
        applyBasemapConfig(map, lightPreset);
        updateThemeOverlay(themeName);
      } else {
        // Custom style loaded — hide Standard overlay
        const overlay = document.getElementById('mapThemeOverlay');
        if (overlay) overlay.style.display = 'none';
      }
    });
    return;
  }

  if (styleUrl === STANDARD_STYLE) {
    updateThemeOverlay(themeName);
  } else {
    const overlay = document.getElementById('mapThemeOverlay');
    if (overlay) overlay.style.display = 'none';
  }
}

// ---- Map Layer Controls ----

function apply3dBuildings(map, enabled) {
  if (!map) return;
  // Mapbox Standard v3 config
  try { map.setConfigProperty('basemap', 'show3dObjects', enabled); } catch (e) {}
  // Custom styles: every fill-extrusion layer represents 3D geometry, so toggle them all
  try {
    const style = map.getStyle();
    if (style && style.layers) {
      style.layers.forEach(layer => {
        if (layer.type === 'fill-extrusion') {
          try {
            map.setLayoutProperty(layer.id, 'visibility', enabled ? 'visible' : 'none');
          } catch (e) {}
        }
      });
    }
  } catch (e) {}
}

function applyMapLabels(map, enabled) {
  if (!map) return;
  // Mapbox Standard v3 config
  try { map.setConfigProperty('basemap', 'showPointOfInterestLabels', enabled); } catch (e) {}
  try { map.setConfigProperty('basemap', 'showPlaceLabels', enabled); } catch (e) {}
  try { map.setConfigProperty('basemap', 'showRoadLabels', enabled); } catch (e) {}
  try { map.setConfigProperty('basemap', 'showTransitLabels', enabled); } catch (e) {}
  // Custom styles: hide every symbol layer that has a text-field (skip our own contour labels)
  try {
    const style = map.getStyle();
    if (!style || !style.layers) return;
    style.layers.forEach(layer => {
      if (layer.type !== 'symbol') return;
      if (CONTOUR_LAYERS.includes(layer.id)) return;
      if (!layer.layout || layer.layout['text-field'] === undefined) return;
      try {
        map.setLayoutProperty(layer.id, 'visibility', enabled ? 'visible' : 'none');
      } catch (e) {}
    });
  } catch (e) {}
}

function apply3dTerrain(map, enabled, exaggeration) {
  if (!map) return;
  if (enabled) {
    if (!map.getSource('mapbox-dem')) {
      try {
        map.addSource('mapbox-dem', {
          type: 'raster-dem',
          url: 'mapbox://mapbox.mapbox-terrain-dem-v1',
          tileSize: 512,
          maxzoom: 14
        });
      } catch (e) {}
    }
    try { map.setTerrain({ source: 'mapbox-dem', exaggeration }); } catch (e) {}
  } else {
    try { map.setTerrain(null); } catch (e) {}
    // Leave the source; it's harmless and avoids re-add cost on next enable
  }
}

const CONTOUR_SOURCE = 'mtp-terrain-contours';
const CONTOUR_LAYERS = ['mtp-contour-minor', 'mtp-contour-major', 'mtp-contour-label'];

function removeContourLayers(map) {
  CONTOUR_LAYERS.forEach(id => {
    try { if (map.getLayer(id)) map.removeLayer(id); } catch (e) {}
  });
  try { if (map.getSource(CONTOUR_SOURCE)) map.removeSource(CONTOUR_SOURCE); } catch (e) {}
}

function applyContours(map, enabled, unit) {
  if (!map) return;
  removeContourLayers(map);
  if (!enabled) return;

  try {
    map.addSource(CONTOUR_SOURCE, {
      type: 'vector',
      url: 'mapbox://mapbox.mapbox-terrain-v2'
    });

    // Minor contours (index = 0)
    map.addLayer({
      id: 'mtp-contour-minor',
      type: 'line',
      source: CONTOUR_SOURCE,
      'source-layer': 'contour',
      filter: ['==', ['get', 'index'], 0],
      paint: {
        'line-color': 'rgba(120, 80, 30, 0.3)',
        'line-width': 0.5
      }
    });

    // Major contours (index = 1)
    map.addLayer({
      id: 'mtp-contour-major',
      type: 'line',
      source: CONTOUR_SOURCE,
      'source-layer': 'contour',
      filter: ['==', ['get', 'index'], 1],
      paint: {
        'line-color': 'rgba(120, 80, 30, 0.65)',
        'line-width': 1.2
      }
    });

    // Labels on major contours
    const labelExpr = unit === 'feet'
      ? ['concat', ['to-string', ['round', ['*', ['get', 'ele'], 3.28084]]], ' ft']
      : ['concat', ['to-string', ['get', 'ele']], ' m'];

    map.addLayer({
      id: 'mtp-contour-label',
      type: 'symbol',
      source: CONTOUR_SOURCE,
      'source-layer': 'contour',
      filter: ['==', ['get', 'index'], 1],
      layout: {
        'text-field': labelExpr,
        'text-size': 10,
        'symbol-placement': 'line',
        'text-pitch-alignment': 'viewport',
        'text-max-angle': 25
      },
      paint: {
        'text-color': 'rgba(90, 50, 10, 0.85)',
        'text-halo-color': 'rgba(255,255,255,0.65)',
        'text-halo-width': 1
      }
    });
  } catch (e) {
    console.warn('Contour layer error:', e);
  }
}

const ROAD_PATTERNS = ['road', 'street', 'motorway', 'highway', 'trunk',
                       'bridge', 'tunnel', 'path', 'track', 'service', 'ferry'];

function cacheRoadWidths(map) {
  roadLayerOriginalWidths = {};
  try {
    const style = map.getStyle();
    if (!style || !style.layers) return;
    style.layers.forEach(layer => {
      if (layer.type !== 'line') return;
      const id = layer.id.toLowerCase();
      if (!ROAD_PATTERNS.some(p => id.includes(p))) return;
      const w = map.getPaintProperty(layer.id, 'line-width');
      if (w !== undefined && w !== null) roadLayerOriginalWidths[layer.id] = w;
    });
  } catch (e) {}
}

function applyRoadWidth(map, multiplier) {
  if (!map) return;
  if (Object.keys(roadLayerOriginalWidths).length === 0) cacheRoadWidths(map);
  Object.entries(roadLayerOriginalWidths).forEach(([layerId, orig]) => {
    try {
      let newWidth;
      if (typeof orig === 'number') {
        newWidth = orig * multiplier;
      } else if (Array.isArray(orig)) {
        newWidth = ['*', multiplier, orig];
      } else {
        return;
      }
      map.setPaintProperty(layerId, 'line-width', newWidth);
    } catch (e) {}
  });
}

// Apply all current layer settings to a map instance
function applyMapLayers(map) {
  apply3dBuildings(map, show3dBuildings);
  apply3dTerrain(map, show3dTerrain, terrainExaggeration);
  applyContours(map, showContours, contourUnit);
  applyRoadWidth(map, roadWidthMultiplier);
  applyMapLabels(map, showLabels);
}

// ---- Init Map Layer Controls ----
function initMapLayersControls() {
  // 3D Buildings
  const tog3dBuildings = document.getElementById('toggle3dBuildings');
  if (tog3dBuildings) {
    tog3dBuildings.addEventListener('change', () => {
      show3dBuildings = tog3dBuildings.checked;
      if (previewMap && previewMap.isStyleLoaded()) apply3dBuildings(previewMap, show3dBuildings);
    });
  }

  // 3D Terrain
  const tog3dTerrain = document.getElementById('toggle3dTerrain');
  const terrainRow = document.getElementById('terrainExaggerationRow');
  if (tog3dTerrain) {
    tog3dTerrain.addEventListener('change', () => {
      show3dTerrain = tog3dTerrain.checked;
      if (terrainRow) terrainRow.style.display = show3dTerrain ? 'block' : 'none';
      if (previewMap && previewMap.isStyleLoaded()) apply3dTerrain(previewMap, show3dTerrain, terrainExaggeration);
    });
  }

  const terrainSlider = document.getElementById('terrainExaggerationSlider');
  const terrainVal = document.getElementById('terrainExaggerationVal');
  if (terrainSlider) {
    terrainSlider.addEventListener('input', () => {
      terrainExaggeration = parseFloat(terrainSlider.value);
      if (terrainVal) terrainVal.textContent = terrainExaggeration.toFixed(1) + '×';
      if (show3dTerrain && previewMap && previewMap.isStyleLoaded()) {
        apply3dTerrain(previewMap, true, terrainExaggeration);
      }
    });
  }

  // Contours
  const togContours = document.getElementById('toggleContours');
  const contourOptions = document.getElementById('contourOptions');
  if (togContours) {
    togContours.addEventListener('change', () => {
      showContours = togContours.checked;
      if (contourOptions) contourOptions.style.display = showContours ? 'block' : 'none';
      if (previewMap && previewMap.isStyleLoaded()) applyContours(previewMap, showContours, contourUnit);
    });
  }

  document.querySelectorAll('#contourOptions .unit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#contourOptions .unit-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      contourUnit = btn.dataset.unit;
      if (showContours && previewMap && previewMap.isStyleLoaded()) {
        applyContours(previewMap, true, contourUnit);
      }
    });
  });

  // Road Width
  const roadWidthSlider = document.getElementById('roadWidthSlider');
  const roadWidthVal = document.getElementById('roadWidthVal');
  if (roadWidthSlider) {
    roadWidthSlider.addEventListener('input', () => {
      roadWidthMultiplier = parseFloat(roadWidthSlider.value);
      const display = roadWidthMultiplier % 1 === 0
        ? roadWidthMultiplier + '×'
        : roadWidthMultiplier.toFixed(2).replace(/0+$/, '') + '×';
      if (roadWidthVal) roadWidthVal.textContent = display;
      if (previewMap && previewMap.isStyleLoaded()) applyRoadWidth(previewMap, roadWidthMultiplier);
    });
  }

  // Labels (street names, places, POIs)
  const togLabels = document.getElementById('toggleLabels');
  if (togLabels) {
    togLabels.checked = showLabels;
    togLabels.addEventListener('change', () => {
      showLabels = togLabels.checked;
      if (previewMap && previewMap.isStyleLoaded()) applyMapLabels(previewMap, showLabels);
    });
  }

  // Badge position
  document.querySelectorAll('#badgePositionToggle .unit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#badgePositionToggle .unit-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      badgePosition = btn.dataset.pos;
    });
  });
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

  const activeTheme = selectedThemes[0] || null;
  const initialStyle = getThemeStyleUrl(activeTheme);

  if (previewMap) {
    previewMap.setCenter([cfg.lon, cfg.lat]);
    previewMap.setZoom(cfg.zoom);
    previewMap.setPitch(cfg.pitch);
    previewMap.setBearing(cfg.bearing);
    if (previewMap.isStyleLoaded()) {
      applyThemePaint(previewMap, activeTheme);
    } else {
      try { previewMap.setConfigProperty('basemap', 'lightPreset', cfg.lightPreset); } catch (e) {}
    }
    return;
  }

  currentPreviewStyleUrl = initialStyle;
  previewMap = new mapboxgl.Map({
    container: 'mapPreview',
    style: initialStyle,
    center: [cfg.lon, cfg.lat],
    zoom: cfg.zoom,
    pitch: cfg.pitch,
    bearing: cfg.bearing,
    interactive: true,
    preserveDrawingBuffer: true,
    antialias: true
  });

  previewMap.on('style.load', () => {
    if (currentPreviewStyleUrl === STANDARD_STYLE) {
      applyBasemapConfig(previewMap, cfg.lightPreset);
    }
    const theme = selectedThemes[0] || null;
    if (theme) applyThemePaint(previewMap, theme);
    roadLayerOriginalWidths = {}; // re-cache for freshly loaded style
    applyMapLayers(previewMap);
  });

  previewMap.on('move', () => {
    syncingFromMap = true;
    try {
      const c = previewMap.getCenter();
      setFieldValue('lat', c.lat.toFixed(5));
      setFieldValue('lon', c.lng.toFixed(5));

      // Convert live zoom → distance; update slider + paired number input
      const currentZoom = previewMap.getZoom();
      const dist = zoomToDistance(currentZoom, c.lat);
      const dv = document.getElementById('distanceSlider');
      const di = document.getElementById('distanceInput');
      if (dv) dv.value = dist;
      if (di) di.value = dist;

      const pitch = previewMap.getPitch().toFixed(0);
      const bearing = previewMap.getBearing().toFixed(0);
      const pv = document.getElementById('pitchSlider');
      const pi = document.getElementById('pitchInput');
      if (pv) pv.value = pitch;
      if (pi) pi.value = pitch;
      const bv = document.getElementById('bearingSlider');
      const bi = document.getElementById('bearingInput');
      if (bv) bv.value = bearing;
      if (bi) bi.value = bearing;
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

    const captureStyleUrl = getThemeStyleUrl(activeTheme);

    captureMap = new mapboxgl.Map({
      container: 'captureMap',
      style: captureStyleUrl,
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
      if (captureStyleUrl === STANDARD_STYLE) {
        applyBasemapConfig(captureMap, cfg.lightPreset);
        try { captureMap.setConfigProperty('basemap', 'colorBackground', '#050505'); } catch (e) {}
      }
      // Apply all layer settings to the offscreen capture map
      const captureRoadCache = roadLayerOriginalWidths; // borrow preview cache (same style)
      apply3dBuildings(captureMap, show3dBuildings);
      apply3dTerrain(captureMap, show3dTerrain, terrainExaggeration);
      applyContours(captureMap, showContours, contourUnit);
      applyMapLabels(captureMap, showLabels);
      // Road width: use preview cache if available, otherwise cache from capture map
      if (roadWidthMultiplier !== 1.0) {
        if (Object.keys(captureRoadCache).length === 0) cacheRoadWidths(captureMap);
        applyRoadWidth(captureMap, roadWidthMultiplier);
        roadLayerOriginalWidths = captureRoadCache; // restore
      }
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
      badge_position: badgePosition,
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
