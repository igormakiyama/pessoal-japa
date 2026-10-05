# Era Uma Vez Eu: histórias infantis personalizadas por assinatura

Os pais assinam e recebem toda semana, por e-mail, uma história nova em que **a criança é a protagonista**:
o nome dela, a aparência dela nas ilustrações, os gostos, o bichinho de estimação e uma lição escolhida pelos
pais. Cada história tem ilustrações, narração (pela voz do próprio celular ou computador) e PDF para imprimir.

Venda, pagamento, produção, entrega e renovação acontecem sozinhas, num único processo Node.

## Como roda

- **App Node sem nenhuma dependência**: `npm start` (= `node server.js`), sem `npm install` e sem módulos nativos.
  Funciona igual no Windows e no Linux, com Node 20 ou mais novo.
- Lê **PORT** e **HOSTNAME** do ambiente e grava tudo em **DATA_DIR**.
- Variáveis de produção ficam em **`.env.site`** na raiz (fora do Git). Crie com:
  ```
  node scripts/setup-env.js --admin-email=<seu e-mail> --base-url=https://<nome>.metodoim.com.br
  ```
  O script gera a senha do painel e o segredo de sessão, grava no `.env.site` e não mostra nada na tela.
  Veja o modelo em `.env.site.example`.

## O que acontece sozinho

```
Cliente paga ──► Mercado Pago avisa o site (webhook) ──► assinatura ativada
                                                          │
Worker (no mesmo processo, a cada 20 s):                  ▼
  • 1ª história logo após o pagamento, depois uma a cada 7 dias
      IA escreve (Groq) ─► filtro + IA revisora ─► ilustra ─► PDF ─► e-mail "nova história"
  • 3 dias antes de vencer: e-mail com link de renovação (Pix ou cartão)
  • venceu: para de gerar e manda "sentimos sua falta"
  • reembolso ou chargeback: tira os dias pagos automaticamente
  • a cada 10 min: confere pagamentos cujo aviso se perdeu
  • história falhou 3 vezes: alerta para o administrador
```

| Peça | Como | Custo |
|---|---|---|
| Texto | Groq (API compatível com OpenAI), plano gratuito com limites | R$ 0 |
| Privacidade | o nome da criança e o do bichinho nunca saem do servidor: vão apelidos fictícios e o nome real só volta à história localmente | — |
| Ilustrações | desenho vetorial gerado por código, com o avatar da criança | R$ 0 |
| PDF | gerador próprio, sem bibliotecas | R$ 0 |
| Narração | Web Speech API do navegador do cliente | R$ 0 |
| Pagamento | Mercado Pago Checkout Pro (Pix, cartão, boleto), pré-pago | só a taxa por venda |
| E-mail | Brevo (API HTTP), grátis até 300 por dia | R$ 0 |

## Modos seguros enquanto falta configuração

| Falta no `.env.site` | O que acontece |
|---|---|
| `MP_ACCESS_TOKEN` (`PAYMENT_PROVIDER=fake`) | O site recebe cadastros, mas só o admin logado consegue simular o pagamento. O público vê "pagamentos ainda não liberados". |
| `LLM_API_KEY` | As histórias saem de um modelo fixo de demonstração. |
| `BREVO_API_KEY` | Os e-mails ficam gravados em `DATA_DIR/outbox`. |

O painel (`/admin`) mostra um aviso para cada item pendente.

## Para vender de verdade

1. **Groq**: crie a chave em https://console.groq.com/keys e coloque em `LLM_API_KEY`.
2. **Mercado Pago**: Suas integrações → Credenciais de produção → Access Token. No `.env.site`, coloque
   `PAYMENT_PROVIDER=mercadopago` e `MP_ACCESS_TOKEN=...`. Não precisa cadastrar webhook: o endereço vai em cada cobrança.
3. **Brevo**: crie a conta, verifique o domínio do remetente, gere uma chave de API e coloque em `BREVO_API_KEY`
   e o remetente verificado em `EMAIL_FROM`.
4. Publique de novo (o `DATA_DIR` é mantido).

## Rotas

| Rota | Acesso |
|---|---|
| `/`, `/exemplo`, `/assinar`, `/entrar`, `/termos`, `/privacidade`, `/robots.txt`, `/saude`, `/avatar.svg`, `/static/*` | público, sem dados de clientes |
| `/conta/<token>`, `/h/<token>`, `/h/<token>/pdf` | link secreto enviado só por e-mail (token aleatório de 144 bits) |
| `/obrigado/<token>` | página após o pagamento; nunca mostra o link da conta (ele vai só para o e-mail cadastrado) |
| `/checkout-teste/<token>` | só existe no modo de teste; o pagamento simulado exige o admin logado |
| `/webhooks/mercadopago` | público; ignora o conteúdo e reconsulta o pagamento na API |
| `/admin` e ações | exige login (`/admin/login`); ações com token anti-CSRF; "Sair" invalida todas as sessões |

## Limites do plano grátis da Groq

Cada modelo tem uma cota diária própria. Quando um modelo estoura, o sistema passa para o próximo da lista
`LLM_MODEL`. Se todos estourarem, a história volta para a fila e é tentada de novo a cada 15 minutos, sem contar
como falha. Se ficar adiada por mais de 2 horas, o admin recebe um alerta. Para produzir mais histórias por dia:
coloque mais modelos em `LLM_MODEL`, desligue a revisão (`LLM_REVIEW=false` gasta metade dos tokens) ou passe
para o plano pago da Groq (centavos por história).

## Robustez

- O banco (`DATA_DIR/store.json`) é gravado com fsync e mantém a versão anterior em `store.json.bak`. Se o
  principal estiver corrompido, o site abre pela cópia.
- E-mails entram numa fila e são reenviados com espera crescente se o Brevo falhar. Problemas aparecem no painel
  e em `/saude` (`"email":"falhando"`).
- Uma faxina diária apaga e-mails com mais de 30 dias e pastas de histórias sem registro.
- Valores inválidos no `.env.site` (ex.: `STORY_INTERVAL_DAYS=0`) usam o padrão e avisam no log.

## Desenvolvimento

```
npm test        # testes (node --test), sem rede
npm run dev     # sobe em http://localhost:3000 com histórias de demonstração
```

Estrutura: `server.js` (entrada), `src/web.js` (rotas), `src/services.js` (regras), `src/worker.js` (ciclo
automático), `src/pipeline.js` (produção da história), `src/llm.js` (IA), `src/illustrate.js` (ilustrações),
`src/pdf.js` (PDF), `src/payments.js` (Mercado Pago), `src/mailer.js` (e-mail), `src/store.js` (banco em JSON),
`src/views/` (HTML), `public/` (CSS e JS do navegador).

A versão anterior (Python + Docker + IA local) está no histórico do Git, no commit `a39c660`.
