import os
import glob
import json
import base64
import logging
import subprocess
from flask import Flask, render_template, request, jsonify, send_from_directory

app = Flask(__name__)
logging.basicConfig(level=logging.INFO, format='%(levelname)s %(name)s: %(message)s')
log = logging.getLogger(__name__)

BASE_DIR = os.getcwd()
POSTER_DIR = os.path.join(BASE_DIR, 'posters')
THEME_DIR = os.path.join(BASE_DIR, 'themes')
CUSTOM_THEME_DIR = os.path.join(BASE_DIR, 'custom_themes')
OVERLAY_CACHE_DIR = os.path.join(BASE_DIR, 'overlays_cache')
BADGES_DIR = os.path.join(BASE_DIR, 'badges')
# Allow stadiums.json override via mounted file, fallback to baked-in copy
STADIUMS_FILE = os.environ.get('STADIUMS_FILE',
    os.path.join(BASE_DIR, 'stadiums.json'))

for d in [POSTER_DIR, OVERLAY_CACHE_DIR, BADGES_DIR]:
    os.makedirs(d, exist_ok=True)

MAPBOX_TOKEN = os.environ.get('MAPBOX_TOKEN', '')


def load_stadiums():
    try:
        with open(STADIUMS_FILE) as f:
            data = json.load(f)
        # Support both list format [{name:..}, ..] and dict format {name: {..}, ..}
        if isinstance(data, dict):
            return [{'name': k, **v} if isinstance(v, dict) else {'name': k} for k, v in data.items()]
        return data
    except FileNotFoundError:
        log.warning('stadiums.json not found at %s', STADIUMS_FILE)
        return []
    except json.JSONDecodeError as e:
        log.error('Invalid JSON in stadiums file: %s', e)
        return []
    except Exception as e:
        log.error('Failed to load stadiums: %s', e)
        return []


def is_mapbox_style(data):
    """True if data is a full Mapbox GL style spec (has version + layers)."""
    return isinstance(data, dict) and 'version' in data and 'layers' in data


def derive_theme_colors(style):
    """Extract bg/text/water colors from a full Mapbox GL style for the poster compositor."""
    bg = '#111111'
    text = '#FFFFFF'
    water = '#1A3A5C'
    for layer in style.get('layers', []):
        lid = layer.get('id', '')
        ltype = layer.get('type', '')
        paint = layer.get('paint', {})
        if ltype == 'background':
            c = paint.get('background-color')
            if isinstance(c, str) and c.startswith('#'):
                bg = c
        if 'water' in lid and ltype == 'fill':
            c = paint.get('fill-color')
            if isinstance(c, str) and c.startswith('#'):
                water = c
        if ('country-label' in lid or 'place-city' in lid) and ltype == 'symbol':
            c = paint.get('text-color')
            if isinstance(c, str) and c.startswith('#'):
                text = c
    return {'bg': bg, 'text': text, 'water': water}


def load_themes():
    themes = []
    if os.path.exists(THEME_DIR):
        for f in sorted(os.listdir(THEME_DIR)):
            if f.endswith('.json'):
                themes.append(f.replace('.json', ''))
    if os.path.exists(CUSTOM_THEME_DIR):
        for d in sorted(os.listdir(CUSTOM_THEME_DIR)):
            style_path = os.path.join(CUSTOM_THEME_DIR, d, 'style.json')
            if os.path.isdir(os.path.join(CUSTOM_THEME_DIR, d)) and os.path.exists(style_path):
                themes.append(d)
    return themes


def load_theme_data(theme_name):
    """Return theme data for poster compositor.
    Built-in themes: returned as-is.
    Custom themes with simplified format: returned as-is.
    Custom themes with full Mapbox style JSON: colors extracted + style_url set to /api/styles/<name>.
    """
    flat = os.path.join(THEME_DIR, f'{theme_name}.json')
    if os.path.exists(flat):
        with open(flat) as f:
            return json.load(f)
    custom = os.path.join(CUSTOM_THEME_DIR, theme_name, 'style.json')
    if os.path.exists(custom):
        with open(custom) as f:
            data = json.load(f)
        if is_mapbox_style(data):
            colors = derive_theme_colors(data)
            return {
                'name': data.get('name', theme_name),
                'description': f"Custom Mapbox style: {data.get('name', theme_name)}",
                'style_url': f'/api/styles/{theme_name}',
                **colors
            }
        return data
    raise FileNotFoundError(f'Theme not found: {theme_name}')


@app.route('/')
def index():
    themes = load_themes()
    stadiums = load_stadiums()
    stadiums_json = json.dumps({s['name']: s for s in stadiums})
    badges = []
    if os.path.exists(BADGES_DIR):
        badges = [f for f in sorted(os.listdir(BADGES_DIR))
                  if f.lower().endswith(('.png', '.jpg', '.jpeg', '.webp'))]
    themes_json = {}
    for t in themes:
        try:
            themes_json[t] = load_theme_data(t)
        except Exception as e:
            log.warning('Failed to load theme %s: %s', t, e)
    return render_template('index.html',
                           themes=themes,
                           themes_json=json.dumps(themes_json),
                           stadiums=stadiums,
                           stadiums_json=stadiums_json,
                           badges=badges,
                           mapbox_token=MAPBOX_TOKEN)


@app.route('/generate', methods=['POST'])
def generate():
    data = request.json

    stadium_name = data.get('stadium', '')
    themes = data.get('themes', [])
    if not themes:
        single = data.get('theme')
        if single:
            themes = [single]
    if not themes:
        return jsonify({'success': False, 'error': 'No theme selected.'})

    # Handle Mapbox capture
    mapbox_capture = data.get('mapbox_capture')
    overlay_config = data.get('overlay_config', {})
    capture_path = None

    if mapbox_capture:
        try:
            lat = round(float(overlay_config.get('lat', 0)), 5)
            lon = round(float(overlay_config.get('lon', 0)), 5)
            zoom = round(float(overlay_config.get('zoom', 0)), 1)
            pitch = int(overlay_config.get('pitch', 0))
            bearing = int(overlay_config.get('bearing', 0))
            light = overlay_config.get('lightPreset', 'dusk')
            first_theme = themes[0] if themes else 'default'
            cache_name = f"capture_{lat}_{lon}_z{zoom}_p{pitch}_b{bearing}_{light}_{first_theme}.png"
            capture_path = os.path.join(OVERLAY_CACHE_DIR, cache_name)
            if not os.path.exists(capture_path):
                img_data = mapbox_capture
                if ',' in img_data:
                    img_data = img_data.split(',', 1)[1]
                with open(capture_path, 'wb') as f:
                    f.write(base64.b64decode(img_data))
                print(f"Capture cached: {cache_name}")
            else:
                print(f"Capture cache hit: {cache_name}")
        except Exception as e:
            return jsonify({'success': False, 'error': f'Failed to save capture: {e}'})

    badge = data.get('badge', '')
    badge_path = os.path.join(BADGES_DIR, badge) if badge else ''
    badge_scale = int(overlay_config.get('badgeScale', 18))
    badge_scale = max(5, min(35, badge_scale))  # clamp to valid range
    badge_position = data.get('badge_position', 'center')
    if badge_position not in ('center', 'bottom'):
        badge_position = 'center'

    all_new_files = []
    try:
        for theme in themes:
            existing = set(glob.glob(os.path.join(POSTER_DIR, '*.png')))
            cmd = ['python', 'create_poster.py',
                   '--theme', theme,
                   '--stadium', stadium_name,
                   '--badge-scale', str(badge_scale),
                   '--badge-position', badge_position]
            if capture_path:
                cmd.extend(['--capture', capture_path])
            if badge_path and os.path.exists(badge_path):
                cmd.extend(['--badge', badge_path])
            subprocess.run(cmd, check=True, timeout=120)
            current = set(glob.glob(os.path.join(POSTER_DIR, '*.png')))
            new_files = list(current - existing)
            if new_files:
                all_new_files.extend(new_files)
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

    if len(themes) == 1:
        if all_new_files:
            latest = max(all_new_files, key=os.path.getctime)
            return jsonify({'success': True, 'filename': os.path.basename(latest)})
        return jsonify({'success': False, 'error': 'No poster generated.'})
    else:
        return jsonify({'success': True, 'batch': True,
                        'count': len(all_new_files), 'themes': themes})


@app.route('/api/styles/<path:theme_name>')
def serve_custom_style(theme_name):
    """Serve raw Mapbox GL style JSON for a custom theme dropped into custom_themes/."""
    # Block path traversal; allow alphanumeric plus the characters common in Mapbox style IDs
    if '..' in theme_name or '/' in theme_name or '\\' in theme_name:
        return jsonify({'error': 'Invalid theme name'}), 400
    style_path = os.path.join(CUSTOM_THEME_DIR, theme_name, 'style.json')
    if not os.path.exists(style_path):
        return jsonify({'error': 'Style not found'}), 404
    with open(style_path) as f:
        style = json.load(f)
    return jsonify(style)


@app.route('/posters/<path:filename>')
def serve_poster(filename):
    return send_from_directory(POSTER_DIR, filename)


@app.route('/health')
def health():
    return jsonify({'status': 'healthy'})


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5025, debug=False)
