# Roteiro de publicação (para a sessão do Claude no PC do Igor)

Este projeto foi preparado numa sessão na nuvem, que não alcança o PC nem o servidor. Esta sessão, rodando no
PC, faz os passos 3 a 6 do pedido original: publicar, testar no navegador, conferir o que ficou público e
devolver a ficha. Não altere o script de publicação nem nada dentro do servidor.

**Dados do projeto**
- Nome curto: `era-uma-vez-eu` → https://era-uma-vez-eu.metodoim.com.br
- Título: `Era Uma Vez Eu` · Grupo: `Projetos` · Tipo: aplicação Node (`npm start`, sem dependências)

## 1. Pegar o código

Clone o branch numa pasta do PC (pergunte ao Igor qual; sugestão: ao lado dos outros projetos):

```powershell
git clone -b claude/zealous-ramanujan-s4vie3 https://github.com/igormakiyama/pessoal-japa.git "<PASTA>"
cd "<PASTA>"
node -v          # precisa ser 20 ou mais novo
npm test         # todos os testes devem passar
```

## 2. Criar o .env.site (segredos)

Pergunte ao Igor **qual e-mail** usar para entrar no painel e como contato do site, e rode:

```powershell
node scripts/setup-env.js --admin-email=<EMAIL> --base-url=https://era-uma-vez-eu.metodoim.com.br
```

O script gera a senha do painel e o segredo de sessão e grava no `.env.site`. **Não leia nem mostre a senha
na conversa.** Para entrar no painel nos testes, leia o valor do arquivo apenas para digitá-lo no navegador,
sem imprimi-lo.

O site sobe em modo seguro: pagamentos de teste (só o admin logado simula), histórias de demonstração (sem
chave da Groq) e e-mails gravados em `DATA_DIR/outbox` (sem chave do Brevo).

## 3. Publicar

```powershell
powershell -ExecutionPolicy Bypass -File "G:\Meu Drive\PROJETOS IA\PROFISSIONAIS\INTEGRADOR\infra\publicar-site.ps1" -Nome era-uma-vez-eu -Pasta "<PASTA>" -Titulo "Era Uma Vez Eu" -Grupo "Projetos"
```

Se der erro, leia a mensagem, corrija no projeto e rode de novo.

## 4. Testar no navegador (https://era-uma-vez-eu.metodoim.com.br)

1. Carrega por HTTPS sem aviso de certificado; `/saude` responde `{"web":"ok","worker":"ok","email":"ok"}`
   (o worker aparece como "ok" uns 2 segundos após subir).
2. Caminho principal, ponta a ponta:
   - `/assinar`: preencha com dados fictícios (ex.: criança "Teste", e-mail `teste+<data>@example.com`),
     marque o aceite e envie. Deve abrir "Pagamento de teste: pagamentos ainda não liberados".
   - Entre em `/admin/login` com o e-mail do painel e a senha do `.env.site`. Volte ao link do pagamento de
     teste e clique em "Simular pagamento aprovado". Deve aparecer "Pagamento confirmado", **sem** link para a
     conta (por segurança, o link da conta só vai por e-mail).
   - Em até 1 minuto, a história aparece no painel com status `ready`. Abra-a pelo título: as imagens carregam,
     o botão "Ouvir a história" fala (se o navegador tiver voz em português) e "Baixar PDF" baixa um PDF que abre.
   - No painel, em "Assinaturas", clique em "abrir conta do cliente": a história aparece listada na conta.
     (Sem Brevo configurado, o e-mail com esse link fica guardado em `DATA_DIR/outbox` no servidor.)
3. Console do navegador sem erros (DevTools) na página inicial, no `/assinar` (inclusive trocando a aparência:
   a prévia do avatar muda), na história e no painel.
4. Tela de celular (~390 px de largura): página inicial, `/assinar`, história e conta sem rolagem horizontal.
5. Páginas sensíveis sem login, pela URL direta numa janela anônima:
   - `/admin` → redireciona para `/admin/login`
   - POST em `/checkout-teste/<token>` sem login → redireciona para o login (o GET só mostra "não liberado")
   - POST em `/admin/historia/1/refazer` sem login → redireciona para o login
   - `/conta/qualquer-coisa`, `/h/qualquer-coisa`, `/h/qualquer-coisa/pdf` → 404
   - `/.env.site`, `/static/..%2fpackage.json`, `/store.json` → 404
6. No fim, apague os dados de teste: na conta de teste, "Apagar meus dados" → digite APAGAR.

## 5. Conferir o que ficou público

Rotas que respondem sem login (todas devem mostrar só conteúdo de vitrine, nunca dados de clientes):
`/`, `/exemplo`, `/assinar`, `/entrar` (sempre a mesma resposta), `/termos`, `/privacidade`,
`/robots.txt`, `/saude` (só `web`/`worker`/`email`), `/avatar.svg` (desenho a partir dos parâmetros),
`/static/style.css`, `/static/form.js`, `/static/story.js`, `/admin/login` (formulário vazio),
`/webhooks/mercadopago` (POST; ignora o corpo e responde `{"ok":true,"ignored":true}` no modo de teste).

Rotas com link secreto (token aleatório de 144 bits, enviado só por e-mail ao cliente):
`/conta/<token>`, `/h/<token>`, `/h/<token>/pdf`, `/obrigado/<token>`, `/checkout-teste/<token>`.

## 6. Devolver a ficha

Use a ficha preenchida que está na resposta da sessão na nuvem (mesmo formato pedido) e atualize:
endereço confirmado, e-mail do usuário criado e qualquer achado dos testes.
