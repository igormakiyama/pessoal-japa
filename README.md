# Era Uma Vez Eu: histórias infantis personalizadas por assinatura, 100% automáticas

Os pais assinam e, toda semana, recebem por e-mail uma história nova em que **a criança é a protagonista**:
com o nome dela, a aparência dela nas ilustrações, os gostos, o bichinho de estimação e uma lição escolhida
pelos pais (coragem, dormir sozinho, amizade...). Cada história vem com **ilustrações, áudio narrado e PDF**.

Tudo roda sozinho no seu VPS: venda → pagamento → produção → entrega → renovação. **Sem nenhuma API paga.**

| Etapa | Como é feita | Custo |
|---|---|---|
| Página de vendas e cadastro | Site próprio (FastAPI) | grátis |
| Pagamento (Pix, cartão, boleto) | Mercado Pago Checkout Pro | só a taxa por venda |
| Texto da história | IA aberta rodando no VPS (Ollama + Gemma) | grátis |
| Revisão de segurança | Filtro automático + segunda passada da IA | grátis |
| Ilustrações | Desenho vetorial gerado por código, com o avatar da criança | grátis |
| Narração em áudio | Piper TTS (voz em português, roda na CPU) | grátis |
| PDF para imprimir | WeasyPrint | grátis |
| Entrega por e-mail | SMTP (Brevo grátis: 300 e-mails/dia) | grátis |
| HTTPS | Caddy + Let's Encrypt | grátis |

## Quanto custa de verdade

- **VPS**: a partir de ~R$ 40/mês (8 GB de RAM). Ou **R$ 0** no Oracle Cloud "Always Free"
  (4 núcleos ARM + 24 GB de RAM grátis para sempre; às vezes falta vaga na região).
- **Domínio**: ~R$ 40/ano no Registro.br.
- **Taxa do Mercado Pago**: cobrada só quando você vende (Pix cerca de 1%, cartão cerca de 4% a 5%). Não tem mensalidade.
- **Fora do sistema**: para vender com regularidade você precisa formalizar a empresa (ex.: MEI, ~R$ 80/mês de imposto
  fixo). Confirme com um contador se a atividade se enquadra.

## Como o sistema trabalha sozinho

```
Cliente paga ──► Mercado Pago avisa o site (webhook) ──► assinatura ativada
                                                          │
Worker (24h por dia, em loop):                            ▼
  • gera a 1ª história na hora, depois uma a cada 7 dias
      IA escreve ─► filtro + IA revisora ─► ilustra ─► narra ─► PDF ─► e-mail "nova história"
  • 3 dias antes de vencer: e-mail com link de renovação (Pix ou cartão)
  • venceu: para de gerar e manda "sentimos sua falta"
  • reembolso/chargeback: tira os dias pagos automaticamente
  • a cada 10 min: confere pagamentos cujo aviso se perdeu
  • história falhou 3 vezes: manda um alerta para você
```

Seu trabalho no dia a dia é divulgar o site e olhar o painel `/admin` de vez em quando.

## Desempenho medido (4 vCPUs, sem placa de vídeo)

| Modelo | RAM mínima | Tempo por história | Qualidade |
|---|---|---|---|
| `gemma3:4b` (padrão) | 8 GB | ~2 a 4 min | boa, com deslizes ocasionais de concordância |
| `gemma4:e4b` | 16 GB | ~8 a 9 min | bem melhor: mais coerente e com português mais correto |

Mesmo no modelo mais lento, um VPS produz ~150 histórias por dia, o suficiente para cerca de 1.000 assinantes
semanais. O instalador escolhe o modelo sozinho pela memória do servidor. Para trocar depois, edite `LLM_MODEL`
no `.env`.

## Instalação no VPS (Ubuntu 22.04/24.04)

1. Compre o domínio e crie um VPS Ubuntu com pelo menos 8 GB de RAM.
2. No servidor:
   ```bash
   git clone https://github.com/igormakiyama/pessoal-japa.git historinhas
   cd historinhas
   sudo bash deploy/install.sh
   ```
   Se o repositório for privado, o `git clone` vai pedir usuário e um *token* do GitHub
   (GitHub → Settings → Developer settings → Personal access tokens) no lugar da senha.
   O script instala o Docker, cria o `.env`, gera a senha do painel, sobe tudo e agenda backup diário.
3. No painel do domínio, crie um **registro A** apontando o domínio para o IP do VPS.
4. Abra `https://seudominio.com.br`. A primeira subida baixa o modelo de IA (3 a 7 GB), então aguarde alguns minutos.
   Acompanhe com `docker compose logs -f worker`.
5. Faça uma compra no **modo teste** (o pagamento começa simulado) e confira a história chegando.

### Ligar o Mercado Pago (para receber de verdade)

1. Crie uma conta em mercadopago.com.br (CPF ou CNPJ).
2. Acesse **Suas integrações → Criar aplicação → Credenciais de produção** e copie o **Access Token**.
3. No `.env`: `PAYMENT_PROVIDER=mercadopago` e `MP_ACCESS_TOKEN=APP_USR-...`
4. Rode `docker compose up -d`.

Não precisa cadastrar webhook no painel do Mercado Pago: o sistema informa o endereço em cada cobrança.
Por segurança, o sistema nunca confia no conteúdo do aviso: ele sempre consulta o pagamento direto na API com o seu token.

### Ligar o e-mail (Brevo, grátis)

1. Crie uma conta em brevo.com e verifique o seu domínio (eles mostram os registros DNS para copiar).
2. Em **SMTP & API**, gere uma chave SMTP.
3. No `.env`: `SMTP_USER` (o login que aparece lá) e `SMTP_PASSWORD` (a chave). Rode `docker compose up -d`.

Enquanto o SMTP não estiver configurado, os e-mails ficam salvos em `data/outbox/` para você conferir.

## Operação

| Tarefa | Comando ou lugar |
|---|---|
| Painel (vendas, histórias, falhas) | `https://seudominio.com.br/admin` |
| Ver o que o worker está fazendo | `docker compose logs -f worker` |
| Saúde do sistema | `https://seudominio.com.br/saude` |
| Atualizar o código | `git pull && docker compose up -d --build` |
| Backup manual | `bash deploy/backup.sh` (fica em `backups/`) |
| Refazer uma história | botão "Refazer" no painel |
| Reembolsar | pelo painel do Mercado Pago (o sistema percebe e ajusta sozinho) |

## Testar no seu computador (sem VPS)

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt pytest
python -m pytest                      # testes automáticos
# Rodar sem IA (histórias de modelo fixo), só para ver o fluxo:
export LLM_PROVIDER=demo PAYMENT_PROVIDER=fake ADMIN_PASSWORD=teste TTS_ENABLED=false
uvicorn historinhas.web:app --reload  # em um terminal
python -m historinhas.worker          # em outro terminal
```

Ou, com Docker: `cp .env.example .env`, ajuste `DOMAIN=localhost` e `BASE_URL=https://localhost`, e rode `docker compose up --build`.

## Estrutura

```
historinhas/
  web.py         site: vendas, cadastro, checkout, área do cliente, histórias, admin, webhook
  worker.py      loop automático: agenda, produz, envia e-mails, renova, alerta
  services.py    regras do negócio (pagamentos, assinaturas, lembretes, LGPD)
  pipeline.py    produção de uma história: texto → ilustrações → áudio → PDF
  llm.py         prompts, validação de segurança e revisão pela IA (Ollama ou API compatível)
  illustrate.py  ilustrador vetorial (13 cenários, dia e noite, avatar da criança)
  tts.py         narração com Piper
  pdf.py         livrinho em PDF
  payments.py    Mercado Pago
  mailer.py      e-mails por SMTP
  content.py     temas, cenários, opções de aparência, preços e história de exemplo
  templates/     páginas e e-mails
tests/           testes automáticos do fluxo inteiro
deploy/          instalador e backup
```

## Limitações (seja honesto com seus clientes)

- A IA local é boa, mas não perfeita: às vezes escapa um erro de concordância. O filtro bloqueia conteúdo
  impróprio, mas vale ler algumas histórias por semana no painel no começo.
- As ilustrações são vetoriais (estilo livro infantil "flat"), não pinturas de IA. Em troca, o personagem fica
  igual em todas as histórias, que é justamente o que os pais querem.
- Os textos de Termos e Privacidade são modelos iniciais: revise com um profissional.
- Divulgação não é automática: poste as páginas de exemplo (`/exemplo`) e vídeos de pais lendo nas redes sociais.

## Ideias para crescer (quando entrar dinheiro)

- Livro impresso de fim de ano com as melhores histórias (upsell).
- Trocar para um modelo de IA maior (mais RAM) ou para uma API paga mudando só o `.env`.
- Entrega por WhatsApp (API oficial, paga por conversa).
- Programa de afiliados ou cupom de indicação.
