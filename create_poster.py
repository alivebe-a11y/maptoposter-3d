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
CUSTOM_THEMES_DIR = os.path.join(BASE_DIR, 'custom_themes')
STADIUMS_FILE = os.path.join(BASE_DIR, 'stadiums.json')

DPI = 500
WIDTH_IN = 24
HEIGHT_IN = 34
WIDTH_PX = WIDTH_IN * DPI    # 12000
HEIGHT_PX = HEIGHT_IN * DPI  # 17000

# Map occupies top 80% of poster; text area is bottom 20%
MAP_HEIGHT = int(HEIGHT_PX * 0.80)
TEXT_AREA_TOP = MAP_HEIGHT


def is_mapbox_style(data):
    return isinstance(data, dict) and 'version' in data and 'layers' in data


def derive_theme_colors(style):
    """Extract bg/text/water from a full Mapbox GL style for the poster compositor."""
    bg, text, water = '#111111', '#FFFFFF', '#1A3A5C'
    for layer in style.get('layers', []):
        lid = layer.get('id', '')
        paint = layer.get('paint', {})
        if layer.get('type') == 'background':
            c = paint.get('background-color')
            if isinstance(c, str) and c.startswith('#'):
                bg = c
        if 'water' in lid and layer.get('type') == 'fill':
            c = paint.get('fill-color')
            if isinstance(c, str) and c.startswith('#'):
                water = c
        if ('country-label' in lid or 'place-city' in lid) and layer.get('type') == 'symbol':
            c = paint.get('text-color')
            if isinstance(c, str) and c.startswith('#'):
                text = c
    return {'bg': bg, 'text': text, 'water': water, 'style_url': '__local__'}


def load_theme(theme_name):
    flat = os.path.join(THEMES_DIR, f'{theme_name}.json')
    if os.path.exists(flat):
        with open(flat) as f:
            return json.load(f)
    custom = os.path.join(CUSTOM_THEMES_DIR, theme_name, 'style.json')
    if os.path.exists(custom):
        with open(custom) as f:
            data = json.load(f)
        if is_mapbox_style(data):
            return derive_theme_colors(data)
        return data
    raise FileNotFoundError(f'Theme not found: {theme_name}')


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


def create_poster(theme_name, stadium_name='', capture_path=None, badge_path=None,
                  badge_scale=18, badge_position='center'):
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

        # Apply tint only when using Mapbox Standard style (no dedicated style_url).
        # Themes with style_url render their own colours in the map capture itself.
        if not theme.get('style_url'):
            tint = Image.new('RGBA', (WIDTH_PX, MAP_HEIGHT), (r, g, b, 64))  # 25% opacity
            canvas_rgba = canvas.convert('RGBA')
            canvas_rgba.alpha_composite(tint, (0, 0))
            canvas = canvas_rgba.convert('RGB')

        # Gradient fade at the bottom of the map: transparent at top → opaque bg at bottom,
        # so the map blends smoothly into the text area instead of cutting off.
        fade_height = int(MAP_HEIGHT * 0.10)
        gradient_strip = Image.new('RGBA', (WIDTH_PX, fade_height))
        gd = ImageDraw.Draw(gradient_strip)
        for y in range(fade_height):
            a = int(255 * (y / fade_height) ** 2)
            gd.line([(0, y), (WIDTH_PX, y)], fill=(r, g, b, a))
        canvas_rgba = canvas.convert('RGBA')
        canvas_rgba.alpha_composite(gradient_strip, (0, MAP_HEIGHT - fade_height))
        canvas = canvas_rgba.convert('RGB')

    # Add badge overlay if provided. Layer order: map → badge → text, so the badge
    # sits in front of the map but behind the title/subtitle/coords text.
    if badge_path and os.path.exists(badge_path):
        try:
            badge = Image.open(badge_path).convert('RGBA')
            badge_size = int(WIDTH_PX * (max(5, min(35, badge_scale)) / 100))
            badge = badge.resize((badge_size, badge_size), Image.Resampling.LANCZOS)
            bx = (WIDTH_PX - badge_size) // 2
            if badge_position == 'bottom':
                # Sit the badge so its centre lands on the map/text boundary, with a
                # subtle bg-tinted disc behind it for visual separation.
                cy = MAP_HEIGHT
                by = cy - badge_size // 2
                canvas_rgba = canvas.convert('RGBA')
                disc_draw = ImageDraw.Draw(canvas_rgba)
                disc_r = badge_size // 2 + int(badge_size * 0.08)
                cx = WIDTH_PX // 2
                disc_draw.ellipse(
                    [cx - disc_r, cy - disc_r, cx + disc_r, cy + disc_r],
                    fill=(r, g, b, 235),
                )
                canvas = canvas_rgba.convert('RGB')
            else:
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

    # Auto-fit title font: start at 7% of poster height (~1190px) and shrink until the
    # spaced title fits inside 90% of the poster width. Sub-fonts scale proportionally.
    title_font_size = int(HEIGHT_PX * 0.07)
    subtitle_font_size = 540
    coord_font_size = 380
    attr_font_size = 240

    if fonts:
        try:
            max_title_width = int(WIDTH_PX * 0.90)
            while title_font_size >= 400:
                test_font = ImageFont.truetype(fonts['bold'], title_font_size)
                bbox = draw.textbbox((0, 0), title_spaced, font=test_font)
                if (bbox[2] - bbox[0]) <= max_title_width:
                    break
                title_font_size -= 40
            font_bold = ImageFont.truetype(fonts['bold'], title_font_size)
            # Scale sub-fonts in proportion to the (possibly shrunk) title size
            scale = title_font_size / int(HEIGHT_PX * 0.07)
            font_light = ImageFont.truetype(fonts['light'], int(subtitle_font_size * scale))
            font_small = ImageFont.truetype(fonts['light'], int(coord_font_size * scale))
            font_attr = ImageFont.truetype(fonts['light'], int(attr_font_size * scale))
        except Exception as e:
            print(f"Font load error: {e}")
            font_bold = ImageFont.load_default()
            font_light = font_bold
            font_small = font_bold
            font_attr = font_bold
    else:
        font_bold = ImageFont.load_default()
        font_light = font_bold
        font_small = font_bold
        font_attr = font_bold

    # Text y positions — bottom 20% of poster (sized for the new larger fonts)
    title_y = int(HEIGHT_PX * 0.840)
    line_y = int(HEIGHT_PX * 0.872)
    subtitle_y = int(HEIGHT_PX * 0.900)
    coord_y = int(HEIGHT_PX * 0.935)
    attr_y = int(HEIGHT_PX * 0.972)

    # Title
    draw.text((text_center_x, title_y), title_spaced,
              font=font_bold, fill=(tr, tg, tb), anchor='mm')

    # Decorative divider
    line_width = int(WIDTH_PX * 0.4)
    line_thickness = max(8, int(WIDTH_PX * 0.003))
    draw.line([(text_center_x - line_width // 2, line_y),
               (text_center_x + line_width // 2, line_y)],
              fill=(tr, tg, tb), width=line_thickness)

    # Subtitle
    if subtitle:
        draw.text((text_center_x, subtitle_y), subtitle,
                  font=font_light, fill=(tr, tg, tb), anchor='mm')

    # Coordinates
    if coord_text:
        draw.text((text_center_x, coord_y), coord_text,
                  font=font_small, fill=(tr, tg, tb), anchor='mm')

    # Attribution
    draw.text((WIDTH_PX - 360, attr_y), 'BlueBearLabs',
              font=font_attr, fill=(tr, tg, tb), anchor='rm')

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
    parser.add_argument('--badge-position', default='center', choices=['center', 'bottom'])
    args = parser.parse_args()
    create_poster(args.theme, args.stadium, args.capture or None, args.badge or None,
                  badge_scale=args.badge_scale, badge_position=args.badge_position)


if __name__ == '__main__':
    main()
