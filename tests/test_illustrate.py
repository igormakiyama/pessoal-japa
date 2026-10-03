import itertools
import xml.dom.minidom

from historinhas.content import EYE_COLORS, FAVORITE_COLORS, HAIR_STYLES, PETS, SKIN_TONES
from historinhas.illustrate import SCENE_DRAWERS, avatar_svg, scene_svg


def test_every_scene_renders_valid_svg_day_and_night():
    app = {"skin": "escura", "hair_style": "crespo", "hair_color": "preto", "eyes": "castanhos",
           "glasses": True, "fav_color": "roxo"}
    for scene, night in itertools.product(SCENE_DRAWERS, (False, True)):
        svg = scene_svg(scene, night, app, "cachorro", seed="t")
        xml.dom.minidom.parseString(svg)


def test_every_appearance_combination_renders():
    for skin, style, eyes, fav, pet in itertools.product(SKIN_TONES, HAIR_STYLES, EYE_COLORS, FAVORITE_COLORS, PETS):
        svg = avatar_svg({"skin": skin, "hair_style": style, "hair_color": "loiro", "eyes": eyes,
                          "glasses": False, "fav_color": fav}, pet)
        xml.dom.minidom.parseString(svg)


def test_same_seed_gives_same_drawing_and_unknown_scene_falls_back():
    a = scene_svg("praia", False, {}, "", seed="x")
    assert a == scene_svg("praia", False, {}, "", seed="x")
    assert a != scene_svg("praia", False, {}, "", seed="y")
    xml.dom.minidom.parseString(scene_svg("cenario_inexistente", False, {}, "", seed="x"))
