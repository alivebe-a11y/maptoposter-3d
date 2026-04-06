"""
create_poster.py — PIL-based poster compositor for maptoposter-3d
Takes a Mapbox GL JS capture + theme + stadium data, outputs a print-quality poster
"""
import os
import json
import argparse
from datetime import datetime
from PIL import Image, ImageDraw, ImageFont

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
FONTS_DIR = os.path.join(BASE_DIR, 'fonts')
POSTERS_DIR = os.path.join(BASE_DIR, 'posters')
THEMES_DIR = os.path.join(BASE_DIR, 'themes')
STADIUMS_FILE = os.path.join(BASE_DIR, 'stadiums.json')

DPI = 500
WIDTH_IN = 24
HEIGHT_IN = 34
WIDTH_PX = WIDTH_IN * DPI    # 12000
HEIGHT_PX = HEIGHT_IN * DPI  # 17000

# Map occupies top 80% of poster; text area is bottom 20%
MAP_HEIGHT = int(HEIGHT_PX * 0.80)
TEXT_AREA_TOP = MAP_HEIGHT


def load_theme(theme_name):
    path = os.path.join(THEMES_DIR, f'{theme_name}.json')
    if not os.path.exists(path):
        raise FileNotFoundError(f'Theme not found: {theme_name}')
    with open(path) as f:
        return json.load(f)


def load_stadiums():
    if not os.path.exists(STADIUMS_FILE):
        print(f'Warning: stadiums.json not found at {STADIUMS_FILE}')
        return []
    with open(STADIUMS_FILE) as f:
        return json.load(f)


def load_fonts():
    bold = os.path.join(FONTS_DIR, 'Roboto-Bold.ttf')
    regular = os.path.join(FONTS_DIR, 'Roboto-Regular.ttf')
    light = os.path.join(FONTS_DIR, 'Roboto-Light.ttf')
    missing = [p for p in [bold, regular, light] if not os.path.exists(p)]
    if missing:
        print(f'Warning: fonts missing from {FONTS_DIR}: {[os.path.basename(p) for p in missing]}')
        return None
    return {'bold': bold, 'regular': regular, 'light': light}


def hex_to_rgb(hex_color):
    h = hex_color.lstrip('#')
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))


def create_poster(theme_name, stadium_name='', capture_path=None, badge_path=None, badge_scale=18):
    theme = load_theme(theme_name)
    stadiums = load_stadiums()

    # Find stadium data
    stadium = None
    for s in stadiums:
        if s['name'].lower() == stadium_name.lower() or s['key'].lower() == stadium_name.lower():
            stadium = s
            break

    # Poster canvas
    bg_color = theme['bg']
    r, g, b = hex_to_rgb(bg_color)
    canvas = Image.new('RGB', (WIDTH_PX, HEIGHT_PX), (r, g, b))

    # Composite Mapbox capture onto top 80%
    if capture_path and os.path.exists(capture_path):
        map_img = Image.open(capture_path).convert('RGB')
        map_img = map_img.resize((WIDTH_PX, MAP_HEIGHT), Image.Resampling.LANCZOS)
        canvas.paste(map_img, (0, 0))

        # Apply semi-transparent theme colour tint over map area so each theme looks
        # visually distinct (Mapbox Standard style doesn't support per-theme map colours,
        # so the same capture is used for all themes in a batch — this tint differentiates them).
        tint = Image.new('RGBA', (WIDTH_PX, MAP_HEIGHT), (r, g, b, 64))  # 25% opacity
        canvas_rgba = canvas.convert('RGBA')
        canvas_rgba.alpha_composite(tint, (0, 0))
        canvas = canvas_rgba.convert('RGB')

        # Apply gradient fade at bottom of map
        fade_height = int(MAP_HEIGHT * 0.20)
        gradient_strip = Image.new('RGBA', (WIDTH_PX, fade_height))
        gd = ImageDraw.Draw(gradient_strip)
        for y in range(fade_height):
            a = int(255 * ((fade_height - y) / fade_height) ** 2)
            gd.line([(0, y), (WIDTH_PX, y)], fill=(r, g, b, a))
        canvas_rgba = canvas.convert('RGBA')
        canvas_rgba.alpha_composite(gradient_strip, (0, MAP_HEIGHT - fade_height))
        canvas = canvas_rgba.convert('RGB')

    # Add badge overlay if provided
    if badge_path and os.path.exists(badge_path):
        try:
            badge = Image.open(badge_path).convert('RGBA')
            badge_size = int(WIDTH_PX * (max(5, min(35, badge_scale)) / 100))
            badge = badge.resize((badge_size, badge_size), Image.Resampling.LANCZOS)
            bx = (WIDTH_PX - badge_size) // 2
            by = (MAP_HEIGHT - badge_size) // 2
            canvas_rgba = canvas.convert('RGBA')
            canvas_rgba.alpha_composite(badge, (bx, by))
            canvas = canvas_rgba.convert('RGB')
        except Exception as e:
            print(f"Badge error: {e}")

    # Typography
    fonts = load_fonts()
    draw = ImageDraw.Draw(canvas)
    text_color = theme['text']
    tr, tg, tb = hex_to_rgb(text_color)

    if stadium:
        title = stadium['name'].upper()
        subtitle = stadium['team'].upper()
        coord_text = (
            f"{abs(stadium['lat']):.4f}°{'N' if stadium['lat'] >= 0 else 'S'}"
            f"  {abs(stadium['lon']):.4f}°{'E' if stadium['lon'] >= 0 else 'W'}"
        )
    else:
        title = 'STADIUM'
        subtitle = ''
        coord_text = ''

    # Title (stadium name) — spaced letters
    title_spaced = '  '.join(title)

    text_center_x = WIDTH_PX // 2

    if fonts:
        font_size_title = 420
        try:
            font_bold = ImageFont.truetype(fonts['bold'], font_size_title)
            font_light = ImageFont.truetype(fonts['light'], 180)
            font_small = ImageFont.truetype(fonts['light'], 130)
        except Exception:
            font_bold = ImageFont.load_default()
            font_light = font_bold
            font_small = font_bold
    else:
        font_bold = ImageFont.load_default()
        font_light = font_bold
        font_small = font_bold

    # Text y positions — bottom 20% of poster
    title_y = int(HEIGHT_PX * 0.855)
    subtitle_y = int(HEIGHT_PX * 0.905)
    line_y = int(HEIGHT_PX * 0.880)
    coord_y = int(HEIGHT_PX * 0.935)
    attr_y = int(HEIGHT_PX * 0.965)

    # Draw title
    draw.text((text_center_x, title_y), title_spaced,
              font=font_bold, fill=(tr, tg, tb), anchor='mm')

    # Decorative line
    line_width = int(WIDTH_PX * 0.4)
    draw.line([(text_center_x - line_width // 2, line_y),
               (text_center_x + line_width // 2, line_y)],
              fill=(tr, tg, tb), width=14)

    # Subtitle
    if subtitle:
        draw.text((text_center_x, subtitle_y), subtitle,
                  font=font_light, fill=(tr, tg, tb), anchor='mm')

    # Coordinates
    if coord_text:
        draw.text((text_center_x, coord_y), coord_text,
                  font=font_small, fill=(tr, tg, tb), anchor='mm')

    # Attribution
    draw.text((WIDTH_PX - 300, attr_y), 'BlueBearLabs',
              font=font_small, fill=(tr, tg, tb), anchor='rm')

    # Save
    os.makedirs(POSTERS_DIR, exist_ok=True)
    slug = stadium['key'] if stadium else 'poster'
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    output_path = os.path.join(POSTERS_DIR, f'{slug}_{theme_name}_{timestamp}.png')
    canvas.save(output_path, dpi=(DPI, DPI))
    print(f"Poster saved: {output_path}")
    return output_path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--theme', required=True)
    parser.add_argument('--stadium', default='')
    parser.add_argument('--capture', default='')
    parser.add_argument('--badge', default='')
    parser.add_argument('--badge-scale', type=int, default=18)
    args = parser.parse_args()
    create_poster(args.theme, args.stadium, args.capture or None, args.badge or None,
                  badge_scale=args.badge_scale)


if __name__ == '__main__':
    main()
