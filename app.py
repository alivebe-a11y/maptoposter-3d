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
            return json.load(f)
    except FileNotFoundError:
        log.warning('stadiums.json not found at %s', STADIUMS_FILE)
        return []
    except json.JSONDecodeError as e:
        log.error('Invalid JSON in stadiums file: %s', e)
        return []
    except Exception as e:
        log.error('Failed to load stadiums: %s', e)
        return []


def load_themes():
    themes = []
    if os.path.exists(THEME_DIR):
        for f in sorted(os.listdir(THEME_DIR)):
            if f.endswith('.json'):
                themes.append(f.replace('.json', ''))
    return themes


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
            with open(os.path.join(THEME_DIR, f'{t}.json')) as f:
                themes_json[t] = json.load(f)
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
            cache_name = f"capture_{lat}_{lon}_z{zoom}_p{pitch}_b{bearing}.png"
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

    all_new_files = []
    try:
        for theme in themes:
            existing = set(glob.glob(os.path.join(POSTER_DIR, '*.png')))
            cmd = ['python', 'create_poster.py',
                   '--theme', theme,
                   '--stadium', stadium_name,
                   '--badge-scale', str(badge_scale)]
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


@app.route('/posters/<path:filename>')
def serve_poster(filename):
    return send_from_directory(POSTER_DIR, filename)


@app.route('/health')
def health():
    return jsonify({'status': 'healthy'})


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5025, debug=False)
