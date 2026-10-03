"""Geração do texto da história com IA + validação + revisão automática.

Provedores:
- ollama: modelo aberto rodando no próprio VPS (grátis). Padrão.
- openai: qualquer API compatível com OpenAI (Groq, OpenRouter, Gemini, OpenAI...).
- demo: histórias de modelo fixo, sem IA (para testar o fluxo).
"""

import json
import logging
import random
import re
import unicodedata

import httpx

from .config import settings
from .content import SCENES, THEMES, word_target

log = logging.getLogger(__name__)

MAX_ATTEMPTS = 3

STORY_SCHEMA = {
    "type": "object",
    "properties": {
        "titulo": {"type": "string"},
        "resumo": {"type": "string"},
        "licao": {"type": "string"},
        "cenas": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "cenario": {"type": "string", "enum": list(SCENES)},
                    "noite": {"type": "boolean"},
                    "texto": {"type": "string"},
                },
                "required": ["cenario", "noite", "texto"],
            },
        },
    },
    "required": ["titulo", "resumo", "licao", "cenas"],
}

REVIEW_SCHEMA = {
    "type": "object",
    "properties": {
        "aprovada": {"type": "boolean"},
        "problemas": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["aprovada", "problemas"],
}

# Palavras que nunca devem aparecer numa história infantil (checagem determinística).
BANNED_PATTERNS = [
    r"\bmort[eoa]s?\b", r"\bmorr\w*", r"\bsangu\w*", r"\bmat(ar|ou|ando|aram)\b", r"\bassassin\w*",
    r"\barmas?\b", r"\brev[óo]lver\b", r"\bpistola\b", r"\btiros?\b", r"\bfacas?\b", r"\bdrogas?\b",
    r"\bcigarros?\b", r"\bcervejas?\b", r"\bb[êe]bad\w*", r"\b[áa]lcool\b", r"\bdiabo\w*", r"\binferno\b",
    r"\bdem[ôo]ni\w*", r"\bporra\b", r"\bmerda\b", r"\bcaralho\b", r"\bputa\w*", r"\bidiota\w*",
    r"\bestúpid\w*", r"\bsexo\b",
]

# Personagens/marcas protegidos que não podem ser usados.
BRANDS = [
    "patrulha canina", "frozen", "mickey", "minnie", "peppa", "homem-aranha", "homem aranha", "batman",
    "superman", "pokémon", "pokemon", "pikachu", "bluey", "sonic", "barbie", "hulk", "moana",
    "galinha pintadinha", "turma da mônica", "disney", "marvel", "minecraft", "bob esponja",
]


class LLMError(Exception):
    pass


class StoryGenerationError(Exception):
    pass


def _strip_accents(text: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", text) if unicodedata.category(c) != "Mn")


def _extract_json(text: str) -> dict:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start, end = text.find("{"), text.rfind("}")
        if start >= 0 and end > start:
            try:
                return json.loads(text[start:end + 1])
            except json.JSONDecodeError:
                pass
    raise LLMError(f"Resposta da IA não é JSON válido: {text[:200]!r}")


def chat_json(messages: list[dict], schema: dict, temperature: float = 0.8) -> dict:
    """Envia a conversa para o provedor configurado e devolve o JSON da resposta."""
    timeout = httpx.Timeout(settings.llm_timeout, connect=15)
    try:
        if settings.llm_provider == "ollama":
            resp = httpx.post(
                f"{settings.ollama_url}/api/chat",
                json={
                    "model": settings.llm_model,
                    "messages": messages,
                    "stream": False,
                    "format": schema,
                    "keep_alive": "15m",
                    # repeat_penalty evita que modelos pequenos entrem em loop repetindo tokens
                    "options": {
                        "temperature": temperature,
                        "num_ctx": settings.llm_num_ctx,
                        "num_predict": 3000,
                        "repeat_penalty": 1.1,
                    },
                },
                timeout=timeout,
            )
            resp.raise_for_status()
            content = resp.json()["message"]["content"]
        elif settings.llm_provider == "openai":
            resp = httpx.post(
                f"{settings.openai_base_url}/chat/completions",
                headers={"Authorization": f"Bearer {settings.openai_api_key}"},
                json={
                    "model": settings.llm_model,
                    "messages": messages,
                    "temperature": temperature,
                    "response_format": {"type": "json_object"},
                },
                timeout=timeout,
            )
            resp.raise_for_status()
            content = resp.json()["choices"][0]["message"]["content"]
        else:
            raise LLMError(f"LLM_PROVIDER desconhecido: {settings.llm_provider}")
    except httpx.HTTPStatusError as exc:
        raise LLMError(
            f"A IA ({settings.llm_provider}) respondeu {exc.response.status_code}: {exc.response.text[:300]}"
        ) from exc
    except httpx.HTTPError as exc:
        raise LLMError(f"Falha ao falar com a IA ({settings.llm_provider}): {exc}") from exc
    return _extract_json(content)


def _mask_brands(text: str) -> str:
    """Troca personagens de marca citados pelos pais por algo genérico, para a IA não copiar."""
    for brand in BRANDS:
        text = re.sub(rf"\b{re.escape(brand)}\b", "um personagem de desenho", text, flags=re.IGNORECASE)
    return text


def _gender_line(child: dict) -> str:
    return {
        "menino": "um menino (use pronomes masculinos)",
        "menina": "uma menina (use pronomes femininos)",
    }.get(child["gender"], "uma criança (não marque gênero; prefira repetir o nome)")


def build_story_messages(child: dict, theme_key: str, previous: list[dict], feedback: list[str]) -> list[dict]:
    name = child["name"]
    min_words, max_words = word_target(child["age"])
    interests = ", ".join(child.get("interests") or []) or "brincar e descobrir coisas novas"
    if child.get("interests_extra"):
        interests += f"; os pais contam também: {_mask_brands(child['interests_extra'])}"
    theme_desc = THEMES.get(theme_key, ("", "uma aventura divertida"))[1]

    lines = [
        "Escreva uma história infantil NOVA e original para ler em voz alta na hora de dormir.",
        "",
        f"Protagonista: {name}, {child['age']} anos, {_gender_line(child)}. Use o nome {name} várias vezes.",
        f"Coisas de que {name} gosta: {interests}.",
    ]
    if child.get("pet_type") and child.get("pet_name"):
        lines.append(f"Participa da história o {child['pet_type']} de estimação, chamado {child['pet_name']}.")
    lines += [
        f"Lição da história: {theme_desc}. Mostre a lição pelas ações, sem dar sermão.",
        f"Tamanho: entre {min_words} e {max_words} palavras no total, em 4 ou 5 cenas "
        f"(cada cena com {min_words // 4} a {max_words // 4} palavras).",
        "Linguagem simples, frases curtas, diálogos, onomatopeias e um final calmo e aconchegante.",
        f"A última cena termina com {name} tranquilo(a), pronto(a) para dormir.",
        "Nada de violência, sustos fortes, perigo real, morte, vilões malvados ou personagens de marcas famosas "
        "(se os pais citarem algum, crie um personagem original parecido).",
        "",
        "Para cada cena escolha o cenário (campo \"cenario\") usando exatamente uma destas palavras: "
        + ", ".join(f"{k} ({v})" for k, v in SCENES.items()) + ".",
        "Varie os cenários: no máximo duas cenas no mesmo cenário.",
        "Use \"noite\": true quando a cena se passa à noite.",
    ]
    if previous:
        lines += ["", "Histórias anteriores desta criança (NÃO repita enredos nem títulos):"]
        lines += [f"- {p['title']}: {p['summary']}" for p in previous]
    if feedback:
        lines += ["", "Uma versão anterior foi reprovada. Corrija estes problemas:"]
        lines += [f"- {f}" for f in feedback]
    lines += [
        "",
        "Responda somente com JSON neste formato:",
        '{"titulo": "...", "resumo": "uma frase", "licao": "uma frase", '
        '"cenas": [{"cenario": "jardim", "noite": false, "texto": "..."}]}',
    ]
    system = (
        "Você é um autor premiado de histórias infantis brasileiras. Escreve em português do Brasil correto, "
        "com carinho, humor e imaginação. Responde somente com JSON válido."
    )
    return [{"role": "system", "content": system}, {"role": "user", "content": "\n".join(lines)}]


def _normalize_scene(value: str) -> str:
    key = _strip_accents(str(value or "")).lower().strip().replace(" ", "_").replace("-", "_")
    if key in SCENES:
        return key
    for scene in SCENES:
        if scene.split("_")[0] in key:
            return scene
    return "jardim"


# Restos de JSON que modelos pequenos às vezes deixam no fim do texto, ex.: 'diferente.”} , 152, 0,'
JSON_TAIL = re.compile(r"(?:[\"”]\s*[}\]]*\s*(?:,\s*\d*\s*)+|[\"”]?\s*[}\]]+\s*,?\s*)$")


def _clean_text(text: str) -> str:
    text = re.sub(r"[*_#`]+", "", str(text or ""))
    text = re.sub(r"[ \t]+", " ", text).strip()
    return JSON_TAIL.sub("", text).strip()


def story_text(story: dict) -> str:
    return "\n\n".join(scene["texto"] for scene in story["cenas"])


def validate_story(data: dict, child: dict) -> tuple[dict, list[str]]:
    """Normaliza a história e devolve (história, problemas). Lista vazia = aprovada."""
    problems: list[str] = []
    scenes = []
    for raw in data.get("cenas") or []:
        if not isinstance(raw, dict):
            continue
        text = _clean_text(raw.get("texto"))
        if len(text) < 30:
            continue
        scenes.append({
            "cenario": _normalize_scene(raw.get("cenario")),
            "noite": bool(raw.get("noite")),
            "texto": text,
        })
    # Modelos pequenos às vezes "vazam" pedaços do JSON no título; corta no primeiro sinal disso.
    title = re.split(r"[“”\"{}]|\bcen[áa]rio\b", _clean_text(data.get("titulo")))[0].strip(" ,.:;-")
    story = {
        "titulo": title[:90],
        "resumo": _clean_text(data.get("resumo"))[:300],
        "licao": _clean_text(data.get("licao"))[:300],
        "cenas": scenes,
    }
    if not story["titulo"]:
        problems.append("A história não tem título.")
    if not 3 <= len(scenes) <= 7:
        problems.append(f"A história deve ter de 4 a 5 cenas (veio com {len(scenes)}).")

    full = story_text(story) if scenes else ""
    words = len(full.split())
    min_words, max_words = word_target(child["age"])
    if words < min_words * 0.6:
        problems.append(f"História curta demais ({words} palavras). Escreva entre {min_words} e {max_words} palavras.")
    elif words > max_words * 1.6:
        problems.append(f"História longa demais ({words} palavras). Escreva entre {min_words} e {max_words} palavras.")

    if re.search(r"[{}]|\"(?:cenario|texto|noite)\"", full):
        problems.append("O texto das cenas veio com pedaços de código/JSON. Escreva só a história.")

    name_hits = len(re.findall(rf"\b{re.escape(child['name'])}\b", full, flags=re.IGNORECASE))
    if name_hits < 2:
        problems.append(f"O nome da criança ({child['name']}) precisa aparecer na história várias vezes.")

    lowered = (story["titulo"] + "\n" + full).lower()
    for pattern in BANNED_PATTERNS:
        match = re.search(pattern, lowered)
        if match:
            problems.append(f"Remova a palavra imprópria para crianças: \"{match.group(0)}\".")
    own_names = {child["name"].lower(), (child.get("pet_name") or "").lower()}
    for brand in BRANDS:
        if brand not in own_names and re.search(rf"\b{re.escape(brand)}\b", lowered):
            problems.append(f"Não use personagens ou marcas protegidas (\"{brand}\"). Crie um personagem original.")
    return story, problems


def review_story(story: dict, child: dict) -> list[str]:
    """Segunda passada da IA, como revisora. Devolve a lista de problemas (vazia = aprovada)."""
    messages = [
        {"role": "system", "content": "Você é um revisor cuidadoso de livros infantis brasileiros. Responde somente com JSON."},
        {"role": "user", "content": (
            f"Revise a história abaixo, escrita para {child['name']}, de {child['age']} anos.\n"
            "Reprove SOMENTE se houver: conteúdo assustador, violento ou impróprio para crianças; texto incoerente "
            "ou sem sentido; erros graves de português; personagens de marcas famosas. "
            "Questões de gosto ou estilo NÃO são motivo para reprovar.\n"
            'Responda: {"aprovada": true ou false, "problemas": ["..."]}\n\n'
            f"TÍTULO: {story['titulo']}\n\n{story_text(story)}"
        )},
    ]
    result = chat_json(messages, REVIEW_SCHEMA, temperature=0.1)
    problems = [str(p).strip() for p in result.get("problemas") or [] if str(p).strip()]
    if result.get("aprovada") is False and problems:
        return problems
    return []


def generate_story(child: dict, theme_key: str, previous: list[dict]) -> dict:
    """Gera, valida e revisa uma história. Tenta até MAX_ATTEMPTS vezes antes de desistir."""
    if settings.llm_provider == "demo":
        story, problems = validate_story(demo_story(child, theme_key), child)
        if problems:
            raise StoryGenerationError("; ".join(problems))
        return story

    feedback: list[str] = []
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            data = chat_json(build_story_messages(child, theme_key, previous, feedback), STORY_SCHEMA)
        except LLMError as exc:
            log.warning("Tentativa %d: %s", attempt, exc)
            feedback = []
            last_error = str(exc)
            continue
        story, problems = validate_story(data, child)
        if not problems and settings.llm_review:
            try:
                problems = review_story(story, child)
            except LLMError as exc:
                log.warning("Revisão falhou (seguindo sem ela): %s", exc)
        if not problems:
            return story
        log.info("Tentativa %d reprovada: %s", attempt, problems)
        feedback = problems
        last_error = "; ".join(problems)
    raise StoryGenerationError(f"Não consegui gerar uma história aprovada em {MAX_ATTEMPTS} tentativas: {last_error}")


def demo_story(child: dict, theme_key: str) -> dict:
    """História de modelo fixo (sem IA) para testar o sistema de ponta a ponta."""
    rng = random.Random(f"{child['name']}-{theme_key}")
    name = child["name"]
    pet = f" e {child['pet_name']}" if child.get("pet_name") else ""
    lesson = THEMES.get(theme_key, ("Aventura", "viver uma aventura"))[1]
    place = rng.choice(["floresta", "praia", "castelo", "espaco", "fazenda"])
    min_words, _ = word_target(child["age"])
    filler = (
        f"{name} olhou em volta com os olhos brilhando. Tudo era novo, colorido e cheio de sons engraçados. "
        "O vento fazia fiu-fiu nas folhas e os passarinhos cantavam piu-piu bem baixinho. "
    )
    repeat = max(1, min_words // 160)
    return {
        "titulo": f"{name} e a Grande Descoberta",
        "resumo": f"{name}{pet} vivem uma aventura e aprendem sobre {lesson}.",
        "licao": f"Aprender sobre {lesson} deixa o coração quentinho.",
        "cenas": [
            {"cenario": "quarto", "noite": False,
             "texto": f"Era uma vez {name}, que acordou com uma ideia brilhante. " + filler * repeat},
            {"cenario": place, "noite": False,
             "texto": f"Logo {name}{pet} chegaram a um lugar mágico. " + filler * repeat},
            {"cenario": place, "noite": False,
             "texto": f"Ali, {name} descobriu o que significa {lesson}. " + filler * repeat},
            {"cenario": "quarto", "noite": True,
             "texto": f"De volta para casa, {name} deitou na cama, sorriu e fechou os olhinhos. Boa noite, {name}. "
                      + filler * repeat},
        ],
    }
