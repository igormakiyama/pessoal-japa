"""Ilustrador vetorial: desenha cada cena em SVG com o avatar da criança.

Roda instantaneamente na CPU, não custa nada e mantém a criança sempre com a mesma
aparência em todas as histórias (algo difícil com geradores de imagem).
A IA escolhe o cenário de cada cena; o ilustrador compõe o desenho.
"""

import hashlib
import math
import random

from .content import (
    DEFAULT_APPEARANCE, EYE_COLORS, FAVORITE_COLORS, HAIR_COLORS, SKIN_TONES,
)

W, H = 800, 500
NIGHT_TINT = "#1E2350"


def _f(v: float) -> str:
    return f"{v:.1f}".rstrip("0").rstrip(".")


def _hex_to_rgb(color: str) -> tuple[int, int, int]:
    color = color.lstrip("#")
    return int(color[0:2], 16), int(color[2:4], 16), int(color[4:6], 16)


def _mix(a: str, b: str, t: float) -> str:
    ra, ga, ba = _hex_to_rgb(a)
    rb, gb, bb = _hex_to_rgb(b)
    return "#{:02X}{:02X}{:02X}".format(
        round(ra + (rb - ra) * t), round(ga + (gb - ga) * t), round(ba + (bb - ba) * t)
    )


class Ctx:
    """Contexto de desenho: aleatoriedade determinística e paleta dia/noite."""

    def __init__(self, seed: str, night: bool, uid: str):
        self.rng = random.Random(seed)
        self.night = night
        self.uid = uid

    def c(self, color: str, amount: float = 0.42) -> str:
        return _mix(color, NIGHT_TINT, amount) if self.night else color


# ---------------------------------------------------------------- personagens

def avatar(app: dict, x: float, y: float, scale: float = 1.0, flip: bool = False, shade=None) -> str:
    """Desenha a criança com os pés em (x, y). Coordenadas locais: 200 x 300."""
    app = {**DEFAULT_APPEARANCE, **(app or {})}
    shade = shade or (lambda col: col)
    skin = shade(SKIN_TONES.get(app["skin"], SKIN_TONES["media_clara"]))
    skin_dark = _mix(skin, "#000000", 0.12)
    hair = shade(HAIR_COLORS.get(app["hair_color"], HAIR_COLORS["castanho"]))
    shirt = shade(FAVORITE_COLORS.get(app["fav_color"], FAVORITE_COLORS["azul"]))
    shirt_dark = _mix(shirt, "#000000", 0.15)
    eye = EYE_COLORS.get(app["eyes"], EYE_COLORS["castanhos"])
    pants = shade("#3D4F7A")
    style = app["hair_style"]

    back, front = [], []
    if style == "liso_longo":
        back.append(f'<path d="M36,100 C34,40 166,40 164,100 L168,214 Q100,232 32,214 Z" fill="{hair}"/>')
        front.append(
            f'<path d="M38,118 C30,38 170,38 162,118 C156,92 146,80 132,74 C112,88 82,90 60,80 C48,90 42,104 38,118 Z" fill="{hair}"/>'
        )
    elif style == "crespo":
        back.append(f'<circle cx="100" cy="88" r="84" fill="{hair}"/>')
        front.append(
            f'<path d="M44,100 C44,48 156,48 156,100 C148,82 126,72 100,72 C74,72 52,82 44,100 Z" fill="{hair}"/>'
        )
    elif style == "cacheado":
        for cx, cy, r in [(44, 118, 18), (156, 118, 18), (42, 150, 16), (158, 150, 16)]:
            back.append(f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="{hair}"/>')
        for i in range(9):
            ang = 3.30 + i * (2.82 / 8)
            cx = 100 + 60 * math.cos(ang)
            cy = 100 + 58 * math.sin(ang)
            front.append(f'<circle cx="{_f(cx)}" cy="{_f(cy)}" r="19" fill="{hair}"/>')
    elif style == "rabo":
        back.append(
            f'<ellipse cx="166" cy="128" rx="20" ry="42" transform="rotate(-18 166 128)" fill="{hair}"/>'
        )
        front.append(
            f'<path d="M40,108 C38,42 162,42 160,108 C150,82 126,70 100,70 C74,70 50,82 40,108 Z" fill="{hair}"/>'
        )
        front.append(f'<circle cx="156" cy="96" r="8" fill="{shirt}"/>')
    elif style == "raspado":
        front.append(
            f'<path d="M42,100 C42,46 158,46 158,100 C150,78 126,66 100,66 C74,66 50,78 42,100 Z" fill="{hair}" opacity="0.55"/>'
        )
    else:  # curto
        front.append(
            f'<path d="M40,108 C36,40 164,40 160,108 C154,86 140,74 124,70 C116,82 94,86 74,80 C60,84 46,94 40,108 Z" fill="{hair}"/>'
        )

    eyes = []
    for ex in (80, 120):
        eyes.append(f'<ellipse cx="{ex}" cy="112" rx="7.5" ry="9" fill="{eye}"/>')
        eyes.append(f'<circle cx="{ex}" cy="113" r="4" fill="#1A1414"/>')
        eyes.append(f'<circle cx="{ex + 2.5}" cy="109" r="2.6" fill="#FFFFFF"/>')
    brows = (
        f'<path d="M70,96 Q80,90 90,96" stroke="{hair}" stroke-width="3.5" fill="none" stroke-linecap="round"/>'
        f'<path d="M110,96 Q120,90 130,96" stroke="{hair}" stroke-width="3.5" fill="none" stroke-linecap="round"/>'
    )
    glasses = ""
    if app.get("glasses"):
        glasses = (
            '<g stroke="#2E2A3A" stroke-width="3.5" fill="#FFFFFF" fill-opacity="0.18">'
            '<circle cx="80" cy="112" r="15"/><circle cx="120" cy="112" r="15"/></g>'
            '<path d="M95,111 Q100,107 105,111" stroke="#2E2A3A" stroke-width="3.5" fill="none"/>'
        )

    body = f"""
<ellipse cx="100" cy="292" rx="58" ry="8" fill="#000000" opacity="0.15"/>
{''.join(back)}
<rect x="74" y="226" width="23" height="56" rx="9" fill="{pants}"/>
<rect x="103" y="226" width="23" height="56" rx="9" fill="{pants}"/>
<ellipse cx="82" cy="284" rx="18" ry="9" fill="#5A3A2A"/>
<ellipse cx="118" cy="284" rx="18" ry="9" fill="#5A3A2A"/>
<path d="M66,174 L46,222" stroke="{shirt_dark}" stroke-width="20" stroke-linecap="round"/>
<path d="M134,174 L154,222" stroke="{shirt_dark}" stroke-width="20" stroke-linecap="round"/>
<circle cx="45" cy="228" r="11" fill="{skin}"/>
<circle cx="155" cy="228" r="11" fill="{skin}"/>
<rect x="89" y="148" width="22" height="24" fill="{skin_dark}"/>
<path d="M60,172 Q100,152 140,172 L148,236 Q100,248 52,236 Z" fill="{shirt}"/>
<path d="M84,160 Q100,172 116,160" stroke="{shirt_dark}" stroke-width="4" fill="none"/>
<circle cx="41" cy="114" r="12" fill="{skin}"/>
<circle cx="159" cy="114" r="12" fill="{skin}"/>
<circle cx="100" cy="106" r="60" fill="{skin}"/>
{''.join(front)}
{brows}
{''.join(eyes)}
<circle cx="70" cy="132" r="9" fill="#F28C9B" opacity="0.45"/>
<circle cx="130" cy="132" r="9" fill="#F28C9B" opacity="0.45"/>
<path d="M97,124 Q100,128 103,124" stroke="{skin_dark}" stroke-width="3" fill="none" stroke-linecap="round"/>
<path d="M85,138 Q100,154 115,138 Q100,145 85,138 Z" fill="#8C3B33"/>
{glasses}
"""
    sx = -scale if flip else scale
    tx = x + (100 * scale if flip else -100 * scale)
    return f'<g transform="translate({_f(tx)},{_f(y - 292 * scale)}) scale({_f(sx)},{_f(scale)})">{body}</g>'


def pet(kind: str, x: float, y: float, scale: float = 1.0, flip: bool = False, shade=None) -> str:
    """Desenha o bichinho com as patas em (x, y). Coordenadas locais: 140 x 110."""
    shade = shade or (lambda col: col)
    if kind == "cachorro":
        fur, dark = shade("#C98B4E"), shade("#8A5A2E")
        body = f"""
<ellipse cx="70" cy="106" rx="46" ry="6" fill="#000" opacity="0.15"/>
<path d="M22,62 Q6,46 14,36" stroke="{fur}" stroke-width="9" fill="none" stroke-linecap="round"/>
<ellipse cx="60" cy="70" rx="40" ry="24" fill="{fur}"/>
<rect x="30" y="78" width="12" height="28" rx="6" fill="{fur}"/><rect x="76" y="78" width="12" height="28" rx="6" fill="{fur}"/>
<circle cx="104" cy="46" r="26" fill="{fur}"/>
<ellipse cx="86" cy="44" rx="9" ry="20" transform="rotate(20 86 44)" fill="{dark}"/>
<ellipse cx="122" cy="44" rx="9" ry="20" transform="rotate(-20 122 44)" fill="{dark}"/>
<ellipse cx="112" cy="58" rx="13" ry="10" fill="#F2D3B1"/>
<circle cx="116" cy="54" r="5" fill="#2A1A14"/>
<circle cx="97" cy="42" r="3.5" fill="#2A1A14"/><circle cx="111" cy="42" r="3.5" fill="#2A1A14"/>
<path d="M108,64 Q113,68 118,64" stroke="#2A1A14" stroke-width="2" fill="none"/>
"""
    elif kind == "gato":
        fur, dark = shade("#E89A4F"), shade("#B86A2A")
        body = f"""
<ellipse cx="70" cy="106" rx="44" ry="6" fill="#000" opacity="0.15"/>
<path d="M24,80 Q2,60 16,30" stroke="{fur}" stroke-width="9" fill="none" stroke-linecap="round"/>
<ellipse cx="62" cy="78" rx="36" ry="22" fill="{fur}"/>
<rect x="36" y="84" width="11" height="22" rx="5" fill="{fur}"/><rect x="74" y="84" width="11" height="22" rx="5" fill="{fur}"/>
<path d="M58,70 L66,70 M50,78 L60,78" stroke="{dark}" stroke-width="4" stroke-linecap="round"/>
<path d="M84,34 L88,10 L100,28 Z" fill="{fur}"/><path d="M124,34 L120,10 L108,28 Z" fill="{fur}"/>
<circle cx="104" cy="50" r="24" fill="{fur}"/>
<circle cx="96" cy="48" r="3.5" fill="#2A1A14"/><circle cx="112" cy="48" r="3.5" fill="#2A1A14"/>
<path d="M101,56 L107,56 L104,60 Z" fill="#E06A7A"/>
<path d="M86,58 L74,56 M86,62 L74,64 M122,58 L134,56 M122,62 L134,64" stroke="#5A3A2A" stroke-width="1.5"/>
"""
    elif kind == "coelho":
        fur, inner = shade("#F1EDEA"), "#F4B6C2"
        body = f"""
<ellipse cx="70" cy="106" rx="40" ry="6" fill="#000" opacity="0.15"/>
<circle cx="30" cy="80" r="10" fill="#FFFFFF"/>
<ellipse cx="62" cy="80" rx="34" ry="24" fill="{fur}"/>
<ellipse cx="80" cy="100" rx="14" ry="7" fill="{fur}"/>
<ellipse cx="94" cy="20" rx="8" ry="26" fill="{fur}"/><ellipse cx="94" cy="20" rx="4" ry="18" fill="{inner}"/>
<ellipse cx="112" cy="20" rx="8" ry="26" fill="{fur}"/><ellipse cx="112" cy="20" rx="4" ry="18" fill="{inner}"/>
<circle cx="104" cy="56" r="22" fill="{fur}"/>
<circle cx="96" cy="53" r="3.5" fill="#2A1A14"/><circle cx="112" cy="53" r="3.5" fill="#2A1A14"/>
<ellipse cx="104" cy="62" rx="3.5" ry="2.5" fill="#E06A7A"/>
"""
    else:
        return ""
    sx = -scale if flip else scale
    tx = x + (70 * scale if flip else -70 * scale)
    return f'<g transform="translate({_f(tx)},{_f(y - 106 * scale)}) scale({_f(sx)},{_f(scale)})">{body}</g>'


# ---------------------------------------------------------------- elementos

def _sky(ctx: Ctx, day=("#8FD3F4", "#E4F6FF"), night=("#151B3D", "#4A3F78")) -> str:
    top, bottom = night if ctx.night else day
    gid = f"{ctx.uid}-sky"
    return (
        f'<defs><linearGradient id="{gid}" x1="0" y1="0" x2="0" y2="1">'
        f'<stop offset="0" stop-color="{top}"/><stop offset="1" stop-color="{bottom}"/></linearGradient></defs>'
        f'<rect width="{W}" height="{H}" fill="url(#{gid})"/>'
    )


def _stars(ctx: Ctx, n: int = 40, max_y: float = 260) -> str:
    out = []
    for _ in range(n):
        x, y = ctx.rng.uniform(5, W - 5), ctx.rng.uniform(5, max_y)
        r = ctx.rng.choice([1.2, 1.6, 2.2, 2.8])
        out.append(f'<circle cx="{_f(x)}" cy="{_f(y)}" r="{r}" fill="#FFF8D6" opacity="{ctx.rng.uniform(0.6, 1):.2f}"/>')
    return "".join(out)


def _moon(x: float, y: float, r: float = 34) -> str:
    return (
        f'<circle cx="{_f(x)}" cy="{_f(y)}" r="{_f(r * 1.7)}" fill="#FFF6C8" opacity="0.12"/>'
        f'<path d="M{_f(x)},{_f(y - r)} A{_f(r)},{_f(r)} 0 1 0 {_f(x)},{_f(y + r)} '
        f'A{_f(r * 0.72)},{_f(r)} 0 1 1 {_f(x)},{_f(y - r)} Z" fill="#FFF3B8"/>'
    )


def _sun(x: float, y: float, r: float = 38) -> str:
    return (
        f'<circle cx="{_f(x)}" cy="{_f(y)}" r="{_f(r * 1.6)}" fill="#FFE58A" opacity="0.35"/>'
        f'<circle cx="{_f(x)}" cy="{_f(y)}" r="{_f(r)}" fill="#FFD54F"/>'
    )


def _cloud(x: float, y: float, s: float = 1.0, color: str = "#FFFFFF") -> str:
    return (
        f'<g fill="{color}" opacity="0.92" transform="translate({_f(x)},{_f(y)}) scale({_f(s)})">'
        '<ellipse cx="0" cy="10" rx="52" ry="18"/><circle cx="-20" cy="2" r="20"/>'
        '<circle cx="10" cy="-6" r="26"/><circle cx="34" cy="6" r="16"/></g>'
    )


def _sky_details(ctx: Ctx, sun_x: float | None = None) -> str:
    if ctx.night:
        return _stars(ctx) + _moon(ctx.rng.uniform(560, 720), ctx.rng.uniform(60, 100))
    out = [_sun(sun_x if sun_x is not None else ctx.rng.uniform(600, 720), ctx.rng.uniform(60, 90))]
    for _ in range(ctx.rng.randint(2, 3)):
        out.append(_cloud(ctx.rng.uniform(60, 520), ctx.rng.uniform(50, 130), ctx.rng.uniform(0.6, 1.0)))
    return "".join(out)


def _hill(ctx: Ctx, y: float, color: str, amp: float = 30) -> str:
    a, b = ctx.rng.uniform(-amp, amp), ctx.rng.uniform(-amp, amp)
    return (
        f'<path d="M0,{_f(y)} C200,{_f(y + a)} 300,{_f(y - amp + b)} 450,{_f(y)} '
        f'S700,{_f(y + a)} {W},{_f(y - b / 2)} L{W},{H} L0,{H} Z" fill="{ctx.c(color)}"/>'
    )


def _tree(ctx: Ctx, x: float, y: float, s: float = 1.0, crown: str = "#5DBB63") -> str:
    trunk = ctx.c("#8B5A3C")
    c1, c2 = ctx.c(crown), ctx.c(_mix(crown, "#FFFFFF", 0.18))
    return (
        f'<g transform="translate({_f(x)},{_f(y)}) scale({_f(s)})">'
        f'<rect x="-9" y="-70" width="18" height="70" rx="5" fill="{trunk}"/>'
        f'<circle cx="0" cy="-100" r="42" fill="{c1}"/><circle cx="-30" cy="-78" r="30" fill="{c1}"/>'
        f'<circle cx="30" cy="-80" r="30" fill="{c1}"/><circle cx="-10" cy="-118" r="22" fill="{c2}"/></g>'
    )


def _pine(ctx: Ctx, x: float, y: float, s: float = 1.0, snow: bool = False) -> str:
    green = ctx.c("#2E7D5B")
    tops = ""
    if snow:
        white = ctx.c("#FFFFFF", 0.25)
        tops = (f'<path d="M0,-150 L-16,-124 L16,-124 Z" fill="{white}"/>'
                f'<path d="M-30,-82 L30,-82 L22,-74 L-22,-74 Z" fill="{white}"/>')
    return (
        f'<g transform="translate({_f(x)},{_f(y)}) scale({_f(s)})">'
        f'<rect x="-7" y="-24" width="14" height="24" fill="{ctx.c("#7A4E35")}"/>'
        f'<path d="M0,-150 L-36,-82 L36,-82 Z" fill="{green}"/>'
        f'<path d="M0,-120 L-46,-24 L46,-24 Z" fill="{green}"/>{tops}</g>'
    )


def _flower(ctx: Ctx, x: float, y: float, color: str, s: float = 1.0) -> str:
    petal = ctx.c(color, 0.3)
    return (
        f'<g transform="translate({_f(x)},{_f(y)}) scale({_f(s)})">'
        f'<path d="M0,0 L0,-22" stroke="{ctx.c("#3E8E41")}" stroke-width="3"/>'
        f'<circle cx="0" cy="-30" r="6" fill="{petal}"/><circle cx="-7" cy="-24" r="6" fill="{petal}"/>'
        f'<circle cx="7" cy="-24" r="6" fill="{petal}"/><circle cx="-5" cy="-16" r="6" fill="{petal}"/>'
        f'<circle cx="5" cy="-16" r="6" fill="{petal}"/><circle cx="0" cy="-23" r="5" fill="#FFD54F"/></g>'
    )


def _flowers(ctx: Ctx, n: int, y0: float, y1: float) -> str:
    colors = ["#F06292", "#BA68C8", "#FFB74D", "#E57373", "#64B5F6", "#FFFFFF"]
    return "".join(
        _flower(ctx, ctx.rng.uniform(10, W - 10), ctx.rng.uniform(y0, y1), ctx.rng.choice(colors), ctx.rng.uniform(0.8, 1.2))
        for _ in range(n)
    )


def _fireflies(ctx: Ctx, n: int = 14, y0: float = 220, y1: float = 440) -> str:
    out = []
    for _ in range(n):
        x, y = _f(ctx.rng.uniform(20, W - 20)), _f(ctx.rng.uniform(y0, y1))
        out.append(f'<circle cx="{x}" cy="{y}" r="8" fill="#FFF59D" opacity="0.3"/>'
                   f'<circle cx="{x}" cy="{y}" r="3" fill="#FFF9C4"/>')
    return "".join(out)


def _butterfly(x: float, y: float, color: str) -> str:
    return (
        f'<g transform="translate({_f(x)},{_f(y)})"><ellipse cx="-8" cy="-4" rx="9" ry="7" fill="{color}"/>'
        f'<ellipse cx="8" cy="-4" rx="9" ry="7" fill="{color}"/><ellipse cx="-6" cy="6" rx="6" ry="5" fill="{color}"/>'
        f'<ellipse cx="6" cy="6" rx="6" ry="5" fill="{color}"/><rect x="-1.5" y="-8" width="3" height="18" rx="1.5" fill="#3A2A2A"/></g>'
    )


# ---------------------------------------------------------------- cenários
# Cada cenário devolve (fundo, frente, chão_y). O personagem é desenhado entre os dois.

def scene_quarto(ctx: Ctx):
    wall = "#F6E3CF" if not ctx.night else "#3E3868"
    floor = "#C99E73" if not ctx.night else "#5E4A55"
    win_sky = ("#9BD8F7" if not ctx.night else "#1A2148")
    parts = [
        f'<rect width="{W}" height="{H}" fill="{wall}"/>',
        f'<path d="M0,0 L{W},0 L{W},40 L0,40 Z" fill="{_mix(wall, "#000000", 0.05)}"/>',
        f'<rect x="0" y="390" width="{W}" height="110" fill="{floor}"/>',
        f'<rect x="0" y="384" width="{W}" height="8" fill="{_mix(floor, "#000000", 0.2)}"/>',
        # janela
        '<rect x="90" y="90" width="190" height="170" rx="10" fill="#FFFFFF"/>',
        f'<rect x="102" y="102" width="166" height="146" rx="6" fill="{win_sky}"/>',
    ]
    if ctx.night:
        parts.append('<g>' + "".join(
            f'<circle cx="{_f(ctx.rng.uniform(110, 260))}" cy="{_f(ctx.rng.uniform(110, 240))}" r="1.8" fill="#FFF8D6"/>'
            for _ in range(14)) + '</g>')
        parts.append(_moon(220, 150, 22))
    else:
        parts.append(_cloud(160, 170, 0.6))
        parts.append(_sun(235, 135, 18))
    parts += [
        '<rect x="183" y="102" width="6" height="146" fill="#FFFFFF"/>',
        '<rect x="102" y="172" width="166" height="6" fill="#FFFFFF"/>',
        f'<path d="M80,84 Q130,180 96,270 L80,270 Z" fill="{ctx.c("#F28C9B", 0.3)}"/>',
        f'<path d="M290,84 Q240,180 274,270 L290,270 Z" fill="{ctx.c("#F28C9B", 0.3)}"/>',
        # quadro de estrela
        f'<rect x="360" y="110" width="80" height="80" rx="6" fill="{ctx.c("#FFFFFF", 0.2)}" stroke="{ctx.c("#C58B5C", 0.2)}" stroke-width="6"/>',
        '<path d="M400,128 L408,146 L428,148 L413,161 L418,180 L400,170 L382,180 L387,161 L372,148 L392,146 Z" fill="#FFD54F"/>',
        # cama
        f'<rect x="520" y="300" width="250" height="110" rx="14" fill="{ctx.c("#8D6E63")}"/>',
        f'<rect x="510" y="250" width="26" height="170" rx="8" fill="{ctx.c("#6D4C41")}"/>',
        f'<rect x="540" y="280" width="90" height="36" rx="16" fill="{ctx.c("#FFFFFF", 0.25)}"/>',
        f'<path d="M560,300 L780,300 L780,380 Q660,400 560,380 Z" fill="{ctx.c("#7FA7E0", 0.3)}"/>',
        f'<path d="M600,330 L780,330" stroke="{ctx.c("#FFFFFF", 0.3)}" stroke-width="6" opacity="0.6"/>',
        # tapete
        f'<ellipse cx="380" cy="455" rx="220" ry="30" fill="{ctx.c("#F2C14E", 0.3)}"/>',
    ]
    if ctx.night:
        parts.append('<circle cx="470" cy="300" r="70" fill="#FFE9A8" opacity="0.18"/>')
        parts.append('<rect x="452" y="320" width="36" height="90" rx="4" fill="#A1887F"/>'
                     '<path d="M444,300 L496,300 L486,270 L454,270 Z" fill="#FFE082"/>')
    else:
        parts.append(f'<rect x="440" y="330" width="60" height="70" rx="6" fill="{ctx.c("#4FC3F7")}"/>'
                     f'<rect x="452" y="300" width="36" height="30" rx="4" fill="{ctx.c("#E57373")}"/>')
    return "".join(parts), "", 455


def scene_jardim(ctx: Ctx):
    parts = [_sky(ctx), _sky_details(ctx), _hill(ctx, 300, "#9CCC65", 20), _hill(ctx, 360, "#7CB342", 14)]
    fence = ctx.c("#FFFFFF", 0.35)
    for x in range(0, W + 1, 46):
        parts.append(f'<path d="M{x},380 L{x},322 L{x + 14},308 L{x + 28},322 L{x + 28},380 Z" fill="{fence}"/>')
    parts.append(f'<rect x="0" y="336" width="{W}" height="10" fill="{fence}"/>')
    parts.append(f'<rect x="0" y="380" width="{W}" height="120" fill="{ctx.c("#8BC34A")}"/>')
    parts.append(_flowers(ctx, 16, 390, 430))
    front = _flowers(ctx, 8, 470, 500)
    if ctx.night:
        front += _fireflies(ctx)
    else:
        front += _butterfly(ctx.rng.uniform(100, 300), ctx.rng.uniform(200, 280), "#BA68C8")
        front += _butterfly(ctx.rng.uniform(500, 700), ctx.rng.uniform(220, 300), "#FFB74D")
    return "".join(parts), front, 460


def scene_parque(ctx: Ctx):
    parts = [_sky(ctx), _sky_details(ctx), _hill(ctx, 320, "#9CCC65", 24)]
    parts.append(f'<rect x="0" y="380" width="{W}" height="120" fill="{ctx.c("#8BC34A")}"/>')
    parts.append(_tree(ctx, 90, 390, 1.2))
    metal = ctx.c("#E57373")
    # balanço
    parts.append(f'<path d="M560,390 L600,200 L640,390 M680,390 L720,200 L760,390 M592,206 L728,206" '
                 f'stroke="{metal}" stroke-width="10" fill="none" stroke-linecap="round"/>')
    parts.append(f'<path d="M640,206 L640,330 M680,206 L680,330" stroke="{ctx.c("#757575")}" stroke-width="3"/>')
    parts.append(f'<rect x="630" y="328" width="60" height="10" rx="4" fill="{ctx.c("#FFB74D")}"/>')
    # escorregador
    parts.append(f'<path d="M190,390 L190,250 M230,390 L230,250" stroke="{ctx.c("#64B5F6")}" stroke-width="8"/>')
    for yy in range(270, 390, 24):
        parts.append(f'<path d="M190,{yy} L230,{yy}" stroke="{ctx.c("#64B5F6")}" stroke-width="5"/>')
    parts.append(f'<path d="M230,250 L250,250 Q300,260 330,385 L310,390 Q282,276 230,268 Z" fill="{ctx.c("#FFD54F")}"/>')
    front = _flowers(ctx, 7, 470, 500)
    if ctx.night:
        front += _fireflies(ctx)
    return "".join(parts), front, 460


def scene_floresta(ctx: Ctx):
    parts = [_sky(ctx, day=("#A8E0C8", "#E8F7EE")), _sky_details(ctx)]
    for i in range(9):
        parts.append(_tree(ctx, i * 100 + ctx.rng.uniform(-20, 20), 330, ctx.rng.uniform(0.8, 1.1), "#3F8F5A"))
    parts.append(_hill(ctx, 340, "#6AAF5C", 16))
    parts.append(f'<rect x="0" y="390" width="{W}" height="110" fill="{ctx.c("#5E9E4E")}"/>')
    for x in (60, 720):
        parts.append(_tree(ctx, x + ctx.rng.uniform(-20, 20), 420, 1.5, "#4CAF50"))
    front = ""
    for _ in range(4):
        mx, my = ctx.rng.uniform(150, 650), ctx.rng.uniform(455, 490)
        front += (f'<rect x="{_f(mx - 5)}" y="{_f(my - 18)}" width="10" height="18" rx="3" fill="#FFF3E0"/>'
                  f'<path d="M{_f(mx - 18)},{_f(my - 16)} Q{_f(mx)},{_f(my - 44)} {_f(mx + 18)},{_f(my - 16)} Z" fill="{ctx.c("#E53935", 0.3)}"/>'
                  f'<circle cx="{_f(mx - 6)}" cy="{_f(my - 26)}" r="3" fill="#FFFFFF"/><circle cx="{_f(mx + 7)}" cy="{_f(my - 23)}" r="2.5" fill="#FFFFFF"/>')
    if ctx.night:
        front += _fireflies(ctx, 20, 150, 440)
    return "".join(parts), front, 465


def scene_praia(ctx: Ctx):
    parts = [_sky(ctx, day=("#7FD0F5", "#FFF1D0")), _sky_details(ctx)]
    sea = ctx.c("#3BA6DB")
    parts.append(f'<rect x="0" y="250" width="{W}" height="120" fill="{sea}"/>')
    for i in range(6):
        y = 270 + i * 16
        parts.append(f'<path d="M{_f(ctx.rng.uniform(0, 400))},{y} q20,-8 40,0 t40,0" stroke="#FFFFFF" '
                     f'stroke-width="3" fill="none" opacity="0.6"/>')
    parts.append(f'<path d="M0,360 Q200,340 400,356 T{W},350 L{W},{H} L0,{H} Z" fill="{ctx.c("#F7DCA0")}"/>')
    parts.append(f'<path d="M0,360 Q200,340 400,356 T{W},350" stroke="#FFFFFF" stroke-width="6" fill="none" opacity="0.7"/>')
    # coqueiro
    trunk, leaf = ctx.c("#A1704A"), ctx.c("#43A047")
    parts.append(f'<path d="M700,440 Q690,320 730,220" stroke="{trunk}" stroke-width="18" fill="none" stroke-linecap="round"/>')
    for d in ("M730,220 Q680,190 640,230", "M730,220 Q700,170 660,170", "M730,220 Q770,180 800,210",
              "M730,220 Q760,160 790,150", "M730,220 Q730,240 700,280"):
        parts.append(f'<path d="{d}" stroke="{leaf}" stroke-width="16" fill="none" stroke-linecap="round"/>')
    # guarda-sol
    parts.append(f'<path d="M150,440 L170,300" stroke="{ctx.c("#795548")}" stroke-width="5"/>'
                 f'<path d="M90,310 Q170,240 250,300 Z" fill="{ctx.c("#EF5350")}"/>'
                 f'<path d="M130,290 Q170,250 210,295 Z" fill="{ctx.c("#FFFFFF", 0.3)}"/>')
    front = (f'<circle cx="{_f(ctx.rng.uniform(260, 340))}" cy="470" r="18" fill="{ctx.c("#FFD54F")}"/>'
             f'<path d="M{_f(ctx.rng.uniform(560, 620))},480 q8,-16 16,0 z" fill="{ctx.c("#F48FB1")}"/>')
    return "".join(parts), front, 455


def scene_fundo_do_mar(ctx: Ctx):
    gid = f"{ctx.uid}-sea"
    top, bottom = ("#2BA3DB", "#0D4F86") if not ctx.night else ("#123A6B", "#081C3A")
    parts = [
        f'<defs><linearGradient id="{gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{top}"/>'
        f'<stop offset="1" stop-color="{bottom}"/></linearGradient></defs>',
        f'<rect width="{W}" height="{H}" fill="url(#{gid})"/>',
    ]
    for x in (120, 330, 560):
        parts.append(f'<path d="M{x},0 L{x + 70},0 L{x + 180},420 L{x + 60},420 Z" fill="#FFFFFF" opacity="0.07"/>')
    parts.append(f'<path d="M0,410 Q200,390 400,410 T{W},404 L{W},{H} L0,{H} Z" fill="{ctx.c("#E8C98A", 0.3)}"/>')
    for x in (40, 110, 660, 740):
        parts.append(f'<path d="M{x},420 q-18,-40 0,-80 q18,-40 0,-80" stroke="{ctx.c("#2E9E5B", 0.3)}" '
                     f'stroke-width="10" fill="none" stroke-linecap="round"/>')
    for x, col in ((200, "#FF8A65"), (600, "#F06292")):
        parts.append(f'<path d="M{x},420 L{x},370 M{x},390 L{x - 22},360 M{x},385 L{x + 20},350" '
                     f'stroke="{ctx.c(col, 0.3)}" stroke-width="12" stroke-linecap="round"/>')
    fish = []
    for _ in range(5):
        fx, fy, col = ctx.rng.uniform(60, 740), ctx.rng.uniform(60, 300), ctx.rng.choice(["#FFB74D", "#FFEB3B", "#F06292", "#4DD0E1"])
        d = ctx.rng.choice([1, -1])
        fish.append(f'<g transform="translate({_f(fx)},{_f(fy)}) scale({d},1)"><ellipse cx="0" cy="0" rx="24" ry="14" fill="{ctx.c(col, 0.3)}"/>'
                    f'<path d="M-20,0 L-38,-12 L-38,12 Z" fill="{ctx.c(col, 0.3)}"/><circle cx="12" cy="-3" r="3" fill="#222"/></g>')
    bubbles = "".join(
        f'<circle cx="{_f(ctx.rng.uniform(20, 780))}" cy="{_f(ctx.rng.uniform(20, 380))}" r="{_f(ctx.rng.uniform(4, 10))}" '
        'fill="none" stroke="#FFFFFF" stroke-width="2" opacity="0.5"/>'
        for _ in range(16)
    )
    return "".join(parts) + "".join(fish), bubbles, 462


def scene_espaco(ctx: Ctx):
    gid = f"{ctx.uid}-space"
    parts = [
        f'<defs><linearGradient id="{gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0B1026"/>'
        f'<stop offset="1" stop-color="#3A2470"/></linearGradient></defs>',
        f'<rect width="{W}" height="{H}" fill="url(#{gid})"/>',
        _stars(ctx, 70, 380),
        '<circle cx="640" cy="110" r="52" fill="#FF8A65"/><circle cx="625" cy="95" r="10" fill="#F4511E" opacity="0.5"/>'
        '<ellipse cx="640" cy="110" rx="90" ry="16" fill="none" stroke="#FFE082" stroke-width="7" transform="rotate(-15 640 110)"/>',
        f'<circle cx="{_f(ctx.rng.uniform(100, 260))}" cy="{_f(ctx.rng.uniform(70, 150))}" r="24" fill="#4FC3F7"/>',
        # foguete
        '<g transform="translate(470,250) rotate(25)">'
        '<path d="M0,-80 Q30,-40 26,30 L-26,30 Q-30,-40 0,-80 Z" fill="#ECEFF1"/>'
        '<circle cx="0" cy="-20" r="13" fill="#4FC3F7" stroke="#90A4AE" stroke-width="4"/>'
        '<path d="M-26,10 L-46,44 L-24,34 Z M26,10 L46,44 L24,34 Z" fill="#E53935"/>'
        '<path d="M-16,32 Q0,80 16,32 Z" fill="#FFB300"/></g>',
        f'<path d="M0,400 Q200,370 400,392 T{W},380 L{W},{H} L0,{H} Z" fill="#B7B4C9"/>',
    ]
    for _ in range(6):
        cx, cy = ctx.rng.uniform(30, 770), ctx.rng.uniform(420, 490)
        parts.append(f'<ellipse cx="{_f(cx)}" cy="{_f(cy)}" rx="{_f(ctx.rng.uniform(14, 34))}" ry="7" fill="#9A97B0"/>')
    return "".join(parts), "", 462


def scene_castelo(ctx: Ctx):
    parts = [_sky(ctx, day=("#9AD5F7", "#FBE7F2")), _sky_details(ctx), _hill(ctx, 330, "#A5D6A7", 26)]
    stone, roof, dark = ctx.c("#D7CCE8"), ctx.c("#7E57C2"), ctx.c("#5E4B8B")
    parts += [
        f'<rect x="420" y="190" width="260" height="190" fill="{stone}"/>',
        f'<rect x="390" y="150" width="70" height="230" fill="{stone}"/>',
        f'<rect x="640" y="150" width="70" height="230" fill="{stone}"/>',
        f'<rect x="515" y="110" width="70" height="120" fill="{stone}"/>',
        f'<path d="M382,152 L425,80 L468,152 Z M632,152 L675,80 L718,152 Z M507,112 L550,40 L593,112 Z" fill="{roof}"/>',
        f'<path d="M550,40 L550,14" stroke="{dark}" stroke-width="3"/><path d="M550,14 L574,22 L550,30 Z" fill="{ctx.c("#EF5350")}"/>',
        f'<path d="M520,380 L520,320 Q550,286 580,320 L580,380 Z" fill="{dark}"/>',
    ]
    for wx, wy in ((415, 200), (665, 200), (540, 150), (460, 260), (620, 260)):
        lit = "#FFE082" if ctx.night else dark
        parts.append(f'<rect x="{wx}" y="{wy}" width="20" height="30" rx="10" fill="{lit}"/>')
    for x in range(420, 681, 26):
        parts.append(f'<rect x="{x}" y="176" width="16" height="16" fill="{stone}"/>')
    parts.append(f'<rect x="0" y="380" width="{W}" height="120" fill="{ctx.c("#81C784")}"/>')
    parts.append(f'<path d="M520,380 Q500,440 420,500 L620,500 Q590,440 580,380 Z" fill="{ctx.c("#E0C9A6")}"/>')
    parts.append(_tree(ctx, 90, 400, 1.1))
    front = _flowers(ctx, 6, 470, 500)
    return "".join(parts), front, 462


def scene_fazenda(ctx: Ctx):
    parts = [_sky(ctx), _sky_details(ctx), _hill(ctx, 300, "#AED581", 30), _hill(ctx, 350, "#9CCC65", 18)]
    red, white = ctx.c("#D84343"), ctx.c("#FFFFFF", 0.3)
    parts += [
        f'<rect x="520" y="220" width="200" height="170" fill="{red}"/>',
        f'<path d="M500,226 L620,140 L740,226 Z" fill="{ctx.c("#8D3A3A")}"/>',
        f'<rect x="580" y="290" width="80" height="100" fill="{_mix(red, "#000000", 0.2)}" stroke="{white}" stroke-width="6"/>',
        f'<path d="M580,290 L660,390 M660,290 L580,390" stroke="{white}" stroke-width="6"/>',
        f'<rect x="600" y="186" width="40" height="34" fill="{white}"/>',
    ]
    parts.append(f'<rect x="0" y="388" width="{W}" height="112" fill="{ctx.c("#8BC34A")}"/>')
    for x in range(0, 480, 40):
        parts.append(f'<rect x="{x}" y="350" width="10" height="44" fill="{ctx.c("#A1887F")}"/>')
    parts.append(f'<rect x="0" y="360" width="480" height="8" fill="{ctx.c("#A1887F")}"/>'
                 f'<rect x="0" y="378" width="480" height="8" fill="{ctx.c("#A1887F")}"/>')
    hay = ctx.c("#F2C14E")
    front = (f'<ellipse cx="740" cy="460" rx="46" ry="32" fill="{hay}"/>'
             f'<path d="M708,450 L772,450 M712,466 L768,466" stroke="{_mix(hay, "#000000", 0.2)}" stroke-width="3"/>')
    # galinha
    cx = ctx.rng.uniform(120, 220)
    front += (f'<g transform="translate({_f(cx)},470)"><ellipse cx="0" cy="-14" rx="18" ry="14" fill="{white}"/>'
              f'<circle cx="14" cy="-28" r="9" fill="{white}"/><path d="M22,-28 L30,-25 L22,-22 Z" fill="#FFB300"/>'
              f'<path d="M12,-38 L16,-44 L18,-36 Z" fill="#E53935"/><circle cx="16" cy="-30" r="1.8" fill="#222"/></g>')
    return "".join(parts), front, 462


def scene_cidade(ctx: Ctx):
    parts = [_sky(ctx, day=("#9BD3F2", "#F3F8FC")), _sky_details(ctx)]
    x = -10
    palette = ["#90A4AE", "#B0BEC5", "#F48FB1", "#FFCC80", "#A5D6A7", "#9FA8DA"]
    while x < W:
        w, h = ctx.rng.uniform(80, 130), ctx.rng.uniform(140, 260)
        top = 380 - h
        parts.append(f'<rect x="{_f(x)}" y="{_f(top)}" width="{_f(w)}" height="{_f(h)}" fill="{ctx.c(ctx.rng.choice(palette))}"/>')
        for wy in range(int(top) + 16, 360, 30):
            for wx in range(int(x) + 12, int(x + w) - 18, 26):
                lit = ctx.night and ctx.rng.random() < 0.6
                col = "#FFE082" if lit else ctx.c("#E3F2FD", 0.5)
                parts.append(f'<rect x="{wx}" y="{wy}" width="14" height="18" rx="2" fill="{col}"/>')
        x += w + ctx.rng.uniform(4, 14)
    parts.append(f'<rect x="0" y="380" width="{W}" height="30" fill="{ctx.c("#CFD8DC")}"/>')
    parts.append(f'<rect x="0" y="410" width="{W}" height="90" fill="{ctx.c("#607D8B")}"/>')
    parts.append(f'<rect x="0" y="404" width="{W}" height="8" fill="{ctx.c("#B0BEC5")}"/>')
    for sx in range(20, W, 90):
        parts.append(f'<rect x="{sx}" y="476" width="46" height="6" rx="3" fill="#FFFFFF" opacity="0.8"/>')
    lamp = (f'<rect x="96" y="250" width="8" height="160" fill="{ctx.c("#455A64")}"/>'
            f'<rect x="84" y="240" width="32" height="16" rx="6" fill="{ctx.c("#455A64")}"/>')
    if ctx.night:
        lamp += '<circle cx="100" cy="262" r="40" fill="#FFF59D" opacity="0.25"/><circle cx="100" cy="258" r="8" fill="#FFF59D"/>'
    parts.append(lamp)
    return "".join(parts), "", 462


def scene_montanha_neve(ctx: Ctx):
    parts = [_sky(ctx, day=("#B3E0F7", "#F2FAFF")), _sky_details(ctx)]
    rock, snow = ctx.c("#8EA3C2"), ctx.c("#FFFFFF", 0.25)
    for base_x, peak_y, width in ((80, 120, 360), (380, 70, 440), (650, 140, 340)):
        px = base_x + width / 2
        parts.append(f'<path d="M{_f(base_x - 40)},380 L{_f(px)},{peak_y} L{_f(base_x + width + 40)},380 Z" fill="{rock}"/>')
        cap = peak_y + 60
        parts.append(f'<path d="M{_f(px)},{peak_y} L{_f(px - 38)},{cap} Q{_f(px - 18)},{cap - 10} {_f(px)},{cap + 6} '
                     f'Q{_f(px + 18)},{cap - 10} {_f(px + 38)},{cap} Z" fill="{snow}"/>')
    parts.append(f'<path d="M0,370 Q200,350 400,372 T{W},360 L{W},{H} L0,{H} Z" fill="{ctx.c("#F4F8FF", 0.3)}"/>')
    parts.append(_pine(ctx, 70, 420, 1.1, snow=True) + _pine(ctx, 150, 400, 0.8, snow=True))
    parts.append(_pine(ctx, 720, 430, 1.2, snow=True))
    # boneco de neve
    sm = ctx.c("#FFFFFF", 0.2)
    parts.append(f'<g transform="translate(600,440)"><circle cx="0" cy="-24" r="30" fill="{sm}"/>'
                 f'<circle cx="0" cy="-74" r="22" fill="{sm}"/><circle cx="-7" cy="-78" r="3" fill="#333"/>'
                 f'<circle cx="7" cy="-78" r="3" fill="#333"/><path d="M0,-72 L18,-68 L0,-66 Z" fill="#FF8A3D"/>'
                 f'<path d="M-20,-56 Q0,-48 20,-56" stroke="#E53935" stroke-width="7" fill="none"/></g>')
    flakes = "".join(
        f'<circle cx="{_f(ctx.rng.uniform(0, W))}" cy="{_f(ctx.rng.uniform(0, H))}" r="{_f(ctx.rng.uniform(2, 4.5))}" fill="#FFFFFF" opacity="0.85"/>'
        for _ in range(45)
    )
    return "".join(parts), flakes, 462


def scene_dinossauros(ctx: Ctx):
    parts = [_sky(ctx, day=("#FFD59A", "#FFF4DD")), _sky_details(ctx)]
    parts.append(f'<path d="M520,330 L600,170 L660,170 L740,330 Z" fill="{ctx.c("#8D6E63")}"/>')
    parts.append(f'<path d="M600,170 L615,195 L630,180 L645,198 L660,170 Z" fill="{ctx.c("#FF7043")}"/>')
    parts.append(_cloud(630, 130, 0.7, ctx.c("#D7CCC8", 0.3)) + _cloud(660, 80, 0.55, ctx.c("#D7CCC8", 0.3)))
    parts.append(_hill(ctx, 330, "#C5D86D", 20))
    parts.append(f'<rect x="0" y="390" width="{W}" height="110" fill="{ctx.c("#A8C256")}"/>')
    # dinossauro pescoçudo e fofo
    dino, belly = ctx.c("#66BB6A"), ctx.c("#C5E1A5")
    parts.append(
        f'<g transform="translate(160,400)"><ellipse cx="0" cy="-40" rx="90" ry="48" fill="{dino}"/>'
        f'<path d="M-80,-40 Q-150,-30 -170,-10 Q-120,-20 -80,-20 Z" fill="{dino}"/>'
        f'<path d="M50,-60 Q90,-150 110,-190" stroke="{dino}" stroke-width="34" fill="none" stroke-linecap="round"/>'
        f'<ellipse cx="122" cy="-196" rx="32" ry="22" fill="{dino}"/><circle cx="130" cy="-202" r="4" fill="#222"/>'
        f'<path d="M126,-186 Q138,-180 148,-188" stroke="#2E5E30" stroke-width="3" fill="none"/>'
        f'<ellipse cx="-10" cy="-26" rx="56" ry="22" fill="{belly}"/>'
        f'<rect x="-60" y="-14" width="26" height="40" rx="10" fill="{dino}"/><rect x="30" y="-14" width="26" height="40" rx="10" fill="{dino}"/>'
        f'<circle cx="-20" cy="-70" r="9" fill="{belly}"/><circle cx="20" cy="-78" r="7" fill="{belly}"/></g>'
    )
    fern = ctx.c("#43A047")
    front = ""
    for fx in (60, 760, 420):
        for ang in (-50, -25, 0, 25, 50):
            front += (f'<path d="M{fx},500 q{_f(ang * 0.8)},-60 {_f(ang * 1.6)},-110" stroke="{fern}" '
                      f'stroke-width="12" fill="none" stroke-linecap="round"/>')
    return "".join(parts), front, 455


def scene_escola(ctx: Ctx):
    parts = [_sky(ctx), _sky_details(ctx), _hill(ctx, 330, "#AED581", 20)]
    wall, roof = ctx.c("#FFCC80"), ctx.c("#E57373")
    parts += [
        f'<rect x="380" y="200" width="360" height="190" fill="{wall}"/>',
        f'<path d="M360,206 L560,120 L760,206 Z" fill="{roof}"/>',
        f'<rect x="530" y="60" width="60" height="80" fill="{wall}"/>',
        f'<path d="M520,64 L560,30 L600,64 Z" fill="{roof}"/>',
        '<circle cx="560" cy="170" r="22" fill="#FFFFFF"/><path d="M560,170 L560,156 M560,170 L570,176" stroke="#333" stroke-width="3"/>',
        f'<path d="M530,390 L530,320 Q560,296 590,320 L590,390 Z" fill="{ctx.c("#8D6E63")}"/>',
    ]
    for wx in (410, 470, 630, 690):
        lit = "#FFE082" if ctx.night else ctx.c("#B3E5FC")
        parts.append(f'<rect x="{wx}" y="250" width="40" height="40" rx="4" fill="{lit}" stroke="#FFFFFF" stroke-width="4"/>')
    parts.append(f'<rect x="0" y="390" width="{W}" height="110" fill="{ctx.c("#8BC34A")}"/>')
    parts.append(f'<path d="M530,390 Q520,440 470,500 L650,500 Q600,440 590,390 Z" fill="{ctx.c("#E0C9A6")}"/>')
    parts.append(_tree(ctx, 110, 400, 1.2))
    return "".join(parts), _flowers(ctx, 6, 470, 500), 462


SCENE_DRAWERS = {
    "quarto": scene_quarto,
    "jardim": scene_jardim,
    "parque": scene_parque,
    "floresta": scene_floresta,
    "praia": scene_praia,
    "fundo_do_mar": scene_fundo_do_mar,
    "espaco": scene_espaco,
    "castelo": scene_castelo,
    "fazenda": scene_fazenda,
    "cidade": scene_cidade,
    "montanha_neve": scene_montanha_neve,
    "dinossauros": scene_dinossauros,
    "escola": scene_escola,
}

# Onde a criança fica em cada cenário (para não ficar em cima de prédios, cama etc.)
CHILD_X_RANGE = {
    "quarto": (300, 400),
    "parque": (380, 470),
    "castelo": (230, 330),
    "fazenda": (260, 420),
    "escola": (240, 360),
    "dinossauros": (420, 560),
    "praia": (330, 520),
}


def scene_svg(scene: str, night: bool, appearance: dict, pet_type: str = "", seed: str = "0") -> str:
    """SVG completo de uma cena com a criança (e o bichinho, se houver)."""
    drawer = SCENE_DRAWERS.get(scene, scene_jardim)
    uid = "s" + hashlib.md5(f"{scene}-{seed}".encode()).hexdigest()[:8]
    ctx = Ctx(f"{scene}-{seed}", night, uid)
    background, foreground, ground_y = drawer(ctx)
    lo, hi = CHILD_X_RANGE.get(scene, (250, 520))
    cx = ctx.rng.uniform(lo, hi)
    flip = ctx.rng.random() < 0.35
    shade = (lambda col: _mix(col, NIGHT_TINT, 0.12)) if night else None
    characters = avatar(appearance, cx, ground_y, 0.85, flip=flip, shade=shade)
    if pet_type:
        px = cx + (-120 if flip else 120)
        characters += pet(pet_type, px, ground_y + 6, 0.8, flip=not flip, shade=shade)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img">'
        f"{background}{characters}{foreground}</svg>"
    )


def avatar_svg(appearance: dict, pet_type: str = "", size: int = 260) -> str:
    """Retrato da criança (usado na prévia do formulário e na área do cliente)."""
    body = avatar(appearance, 130 if pet_type else 150, 290, 0.85)
    if pet_type:
        body += pet(pet_type, 225, 292, 0.62, flip=True)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300" width="{size}" height="{size}" role="img">'
        '<circle cx="150" cy="150" r="148" fill="#FFF1D6"/>'
        '<path d="M2,230 Q150,200 298,230 L298,300 L2,300 Z" fill="#CDE8B5"/>'
        f"{body}</svg>"
    )
