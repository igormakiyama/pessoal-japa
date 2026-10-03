import pytest

from historinhas import llm

CHILD = {"name": "Theo", "age": 5, "gender": "menino", "interests": ["dinossauros"],
         "interests_extra": "ama o Homem-Aranha", "pet_type": "gato", "pet_name": "Bolinha", "themes": []}


def make_story(text_extra="", name="Theo", scenes=4, words_per_scene=110, title="Theo e o Foguete"):
    filler = " ".join(["palavra"] * words_per_scene)
    return {
        "titulo": title,
        "resumo": "Resumo.",
        "licao": "Lição.",
        "cenas": [{"cenario": "jardim", "noite": False, "texto": f"{name} brincou. {filler} {text_extra}"}
                  for _ in range(scenes)],
    }


def test_valid_story_passes():
    story, problems = llm.validate_story(make_story(), CHILD)
    assert problems == []
    assert len(story["cenas"]) == 4


@pytest.mark.parametrize("extra, expected", [
    ("e encontrou sangue no chão", "imprópria"),
    ("com o Homem-Aranha", "marcas"),
])
def test_banned_content_is_rejected(extra, expected):
    _, problems = llm.validate_story(make_story(extra), CHILD)
    assert any(expected in p for p in problems)


def test_missing_name_and_short_story_are_rejected():
    _, problems = llm.validate_story(make_story(name="Joana", words_per_scene=10), CHILD)
    assert any("curta" in p for p in problems)
    assert any("nome" in p for p in problems)


def test_leaked_json_in_title_is_trimmed_and_scenes_normalized():
    data = make_story(title='Theo e o Estranho”, “ cenário: quarto”')
    data["cenas"][0]["cenario"] = "Espaço sideral"
    data["cenas"][1]["cenario"] = "lugar desconhecido"
    story, problems = llm.validate_story(data, CHILD)
    assert story["titulo"] == "Theo e o Estranho"
    assert story["cenas"][0]["cenario"] == "espaco"
    assert story["cenas"][1]["cenario"] == "jardim"
    assert problems == []


def test_leaked_json_at_end_of_scene_is_removed():
    data = make_story()
    data["cenas"][0]["texto"] += " brilhava de forma diferente.”} , 152, 0,"
    data["cenas"][1]["texto"] += " o brilho da lanterna.” , 402, 0,"
    data["cenas"][2]["texto"] += " — Boa noite, Theo! — disse a mãe: “durma bem.”"
    story, problems = llm.validate_story(data, CHILD)
    assert story["cenas"][0]["texto"].endswith("diferente.")
    assert story["cenas"][1]["texto"].endswith("lanterna.")
    assert story["cenas"][2]["texto"].endswith("“durma bem.”")
    assert problems == []
    data["cenas"][3]["texto"] += ' {"cenario": "quarto"} e mais texto'
    _, problems = llm.validate_story(data, CHILD)
    assert any("JSON" in p for p in problems)


def test_prompt_masks_brands_and_lists_previous_stories():
    messages = llm.build_story_messages(CHILD, "coragem", [{"title": "Theo no Mar", "summary": "Mergulho."}], [])
    prompt = messages[1]["content"]
    assert "Homem-Aranha" not in prompt
    assert "Theo no Mar" in prompt
    assert "Bolinha" in prompt


def test_generate_retries_with_feedback(monkeypatch):
    monkeypatch.setattr(llm.settings, "llm_provider", "ollama")
    monkeypatch.setattr(llm.settings, "llm_review", True)
    calls = []

    def fake_chat(messages, schema, temperature=0.8):
        calls.append(messages[-1]["content"])
        if schema is llm.REVIEW_SCHEMA:
            return {"aprovada": True, "problemas": []}
        story_calls = [c for c in calls if "Escreva uma história" in c]
        return make_story("muito sangue") if len(story_calls) == 1 else make_story()

    monkeypatch.setattr(llm, "chat_json", fake_chat)
    story = llm.generate_story(CHILD, "coragem", [])
    assert story["titulo"] == "Theo e o Foguete"
    assert "Corrija estes problemas" in calls[1]


def test_generate_gives_up_after_max_attempts(monkeypatch):
    monkeypatch.setattr(llm.settings, "llm_provider", "ollama")
    monkeypatch.setattr(llm, "chat_json", lambda *a, **k: make_story("sangue"))
    with pytest.raises(llm.StoryGenerationError):
        llm.generate_story(CHILD, "coragem", [])


def test_extract_json_handles_fences_and_noise():
    assert llm._extract_json('```json\n{"a": 1}\n```') == {"a": 1}
    assert llm._extract_json('Claro! {"a": 2} pronto') == {"a": 2}
    with pytest.raises(llm.LLMError):
        llm._extract_json("sem json")
