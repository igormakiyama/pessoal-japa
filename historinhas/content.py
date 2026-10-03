"""Catálogo do produto: cenários, temas, opções de aparência e a história de exemplo."""

# Cenários que o ilustrador sabe desenhar. A IA escolhe um destes para cada cena.
SCENES = {
    "quarto": "quarto da criança",
    "jardim": "jardim florido",
    "parque": "parquinho com balanço e escorregador",
    "floresta": "floresta encantada",
    "praia": "praia",
    "fundo_do_mar": "fundo do mar",
    "espaco": "espaço sideral e planetas",
    "castelo": "castelo",
    "fazenda": "fazenda",
    "cidade": "cidade",
    "montanha_neve": "montanha com neve",
    "dinossauros": "terra dos dinossauros",
    "escola": "escola",
}

# Lições/temas que os pais podem escolher reforçar.
THEMES = {
    "coragem": ("Coragem", "ter coragem para enfrentar um pequeno medo"),
    "amizade": ("Amizade", "fazer amigos e ser um bom amigo"),
    "dividir": ("Dividir", "aprender a dividir e a esperar a vez"),
    "dormir": ("Hora de dormir", "dormir tranquilo, sem medo do escuro"),
    "irmao": ("Irmãozinho", "a chegada ou convivência com um irmão ou irmã"),
    "escola": ("Escola", "começar ou gostar de ir à escola"),
    "natureza": ("Natureza", "cuidar dos animais e da natureza"),
    "gentileza": ("Gentileza", "ser gentil, dizer por favor e obrigado"),
    "emocoes": ("Emoções", "entender e falar sobre os próprios sentimentos"),
    "alimentacao": ("Comer bem", "experimentar comidas novas e saudáveis"),
    "persistencia": ("Persistência", "não desistir quando algo é difícil"),
    "imaginacao": ("Imaginação", "usar a criatividade e a imaginação"),
}

INTERESTS = [
    "dinossauros", "espaço e foguetes", "animais", "fundo do mar", "castelos e magia",
    "super-heróis", "carros e caminhões", "futebol e esportes", "música e dança",
    "robôs", "fadas e unicórnios", "piratas", "natureza e plantas", "desenhar e pintar",
]

SKIN_TONES = {
    "clara": "#F8D9C0",
    "media_clara": "#EDC09A",
    "media": "#D7A074",
    "morena": "#A8714A",
    "escura": "#6E4429",
}

HAIR_COLORS = {
    "preto": "#2B2222",
    "castanho_escuro": "#4A2E1F",
    "castanho": "#7A4B2A",
    "loiro": "#E2B85C",
    "ruivo": "#C2552B",
}

HAIR_STYLES = {
    "curto": "Curto",
    "liso_longo": "Longo e liso",
    "cacheado": "Cacheado",
    "crespo": "Crespo (black power)",
    "rabo": "Rabo de cavalo",
    "raspado": "Raspadinho",
}

EYE_COLORS = {
    "castanhos": "#3B2A20",
    "azuis": "#3C7DC4",
    "verdes": "#3E8E5A",
}

FAVORITE_COLORS = {
    "azul": "#4A90D9",
    "vermelho": "#E2533D",
    "verde": "#4CAF6A",
    "amarelo": "#F2C230",
    "roxo": "#8E5CC9",
    "rosa": "#EE7FB0",
    "laranja": "#F28C38",
}

PETS = {
    "": "Nenhum",
    "cachorro": "Cachorro",
    "gato": "Gato",
    "coelho": "Coelho",
}

GENDERS = {
    "menino": "Menino",
    "menina": "Menina",
    "neutro": "Prefiro não informar",
}

LABELS = {
    "skin": {"clara": "Clara", "media_clara": "Média clara", "media": "Média", "morena": "Morena", "escura": "Escura"},
    "hair_color": {"preto": "Preto", "castanho_escuro": "Castanho escuro", "castanho": "Castanho",
                   "loiro": "Loiro", "ruivo": "Ruivo"},
    "eyes": {"castanhos": "Castanhos", "azuis": "Azuis", "verdes": "Verdes"},
    "fav_color": {k: k.capitalize() for k in FAVORITE_COLORS},
}

DEFAULT_APPEARANCE = {
    "skin": "media_clara",
    "hair_color": "castanho",
    "hair_style": "curto",
    "eyes": "castanhos",
    "glasses": False,
    "fav_color": "azul",
}


def word_target(age: int) -> tuple[int, int]:
    """Faixa de palavras da história conforme a idade."""
    if age <= 3:
        return 250, 400
    if age <= 6:
        return 400, 650
    return 600, 900


# História de exemplo exibida na landing page (escrita à mão, sem IA).
SAMPLE_CHILD = {
    "name": "Lia",
    "age": 5,
    "gender": "menina",
    "pet_type": "cachorro",
    "pet_name": "Pipoca",
    "appearance": {
        "skin": "morena",
        "hair_color": "preto",
        "hair_style": "crespo",
        "eyes": "castanhos",
        "glasses": False,
        "fav_color": "amarelo",
    },
}

SAMPLE_STORY = {
    "titulo": "Lia e a Estrela Pequenina",
    "resumo": "Lia encontra uma estrela caída no jardim e descobre que coragem é ajudar mesmo com um pouquinho de medo.",
    "licao": "Ter coragem não é não sentir medo: é fazer o que é certo mesmo com o coração batendo forte.",
    "cenas": [
        {
            "cenario": "quarto",
            "noite": True,
            "texto": "Era uma vez uma menina chamada Lia, que tinha um cabelo cheio de cachinhos e uma risada que parecia sininho. "
                     "Toda noite, antes de dormir, Lia e seu cachorrinho Pipoca olhavam pela janela para contar as estrelas. "
                     "— Uma, duas, três... — contava Lia. Mas naquela noite, uma estrelinha piscou diferente e fez zuuum! Caiu bem no jardim.",
        },
        {
            "cenario": "jardim",
            "noite": True,
            "texto": "Lia calçou as pantufas amarelas, segurou a lanterna e foi até o jardim, com Pipoca abanando o rabo ao lado. "
                     "O escuro parecia enorme, e o coração de Lia batia tum-tum, tum-tum. "
                     "Atrás das flores, uma luz fraquinha chorava baixinho: era a Estrela Pequenina, que tinha se perdido do céu.",
        },
        {
            "cenario": "montanha_neve",
            "noite": True,
            "texto": "— Eu preciso voltar lá para cima, mas sozinha não consigo! — disse a estrela. "
                     "Lia pensou um pouquinho, respirou fundo e falou: — Eu te ajudo! "
                     "Juntas, elas subiram o morrinho mais alto do bairro, passo a passo, enquanto Pipoca latia para espantar o medo.",
        },
        {
            "cenario": "quarto",
            "noite": True,
            "texto": "Lá no alto, Lia ergueu as mãos e a estrela pulou de volta para o céu, brilhando mais forte do que nunca. "
                     "De volta à cama, Lia sorriu: tinha sentido medo, mas foi corajosa mesmo assim. "
                     "E toda noite, desde então, uma estrelinha pisca duas vezes só para ela. Boa noite, Lia.",
        },
    ],
}
