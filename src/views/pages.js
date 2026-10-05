// Páginas do site (HTML gerado no servidor, sem depender de JavaScript para o conteúdo).
import { config, plans } from '../config.js';
import {
  EYE_COLORS, FAVORITE_COLORS, GENDERS, HAIR_COLORS, HAIR_STYLES, INTERESTS, LABELS, PETS, SKIN_TONES, THEMES,
} from '../content.js';
import { html, raw } from '../html.js';
import { brl, dateBr } from '../util.js';

// Texto fixo da página inicial (usado também pelo monitoramento do painel).
export const HOME_HEADLINE = 'Toda semana, uma história onde seu filho é o herói';

const FAVICON = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>⭐</text></svg>";

export function layout({ title, content, head = '', scripts = [], noindex = false }) {
  const fullTitle = title ? `${title} · ${config.siteName}` : `${config.siteName} · Histórias personalizadas onde seu filho é o herói`;
  return html`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${fullTitle}</title>
<meta name="description" content="Toda semana, uma história nova com o nome, o jeitinho e os gostos do seu filho. Ilustrada, com áudio para a hora de dormir e PDF para imprimir.">
${noindex ? raw('<meta name="robots" content="noindex">') : ''}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Baloo+2:wght@600;800&family=Nunito:wght@400;600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/static/style.css?v=4">
<link rel="icon" href="${FAVICON}">
${head}
</head>
<body>
<header class="topbar">
  <div class="wrap">
    <a class="logo" href="/">${config.siteName}<span>.</span></a>
    <nav>
      <a class="hide-sm" href="/exemplo">Ver exemplo</a>
      <a href="/entrar">Minha conta</a>
      <a class="btn small" href="/assinar">Assinar</a>
    </nav>
  </div>
</header>
<main>
${content}
</main>
<footer>
  <div class="wrap">
    <span>© ${config.siteName} · ${config.llmProvider === 'demo'
      ? 'Site em fase de testes: as histórias atuais são de demonstração.'
      : 'Histórias criadas com inteligência artificial e revisadas automaticamente.'}</span>
    <span><a href="/entrar">Minha conta</a> · <a href="/exemplo">Exemplo</a> · <a href="/termos">Termos</a> · <a href="/privacidade">Privacidade</a> · <a href="mailto:${config.supportEmail}">${config.supportEmail}</a></span>
  </div>
</footer>
${scripts.map((src) => html`<script src="${src}" defer></script>`)}
</body>
</html>`;
}

const errorsBox = (errors) => (errors && errors.length
  ? html`<div class="errors" role="alert"><b>Confira os campos abaixo:</b><ul>${errors.map((e) => html`<li>${e}</li>`)}</ul></div>`
  : '');

export function message({ title, text, link = ['/', 'Voltar para o início'] }) {
  return layout({
    title,
    noindex: true,
    content: html`<div class="wrap narrow page-pad"><div class="card center">
      <h1>${title}</h1><p>${text}</p>
      <p><a class="btn secondary" href="${link[0]}">${link[1]}</a></p></div></div>`,
  });
}

// ---------------------------------------------------------------- página inicial

export function home({ sample, sampleScenes }) {
  const allPlans = plans();
  const monthly = allPlans.mensal.priceCents;
  return layout({
    content: html`
<section class="hero">
  <div class="wrap">
    <div>
      <h1>${HOME_HEADLINE}</h1>
      <p class="lead">Com o nome, o jeitinho, os gostos e até o bichinho de estimação dele. Ilustrada, com áudio para
        ouvir na hora de dormir e uma lição que você escolhe: coragem, amizade, dormir sozinho...</p>
      <div class="cta-row">
        <a class="btn" href="/assinar">Quero as histórias</a>
        <a class="btn ghost" href="/exemplo">Ler um exemplo</a>
      </div>
      <ul class="badges">
        <li>📖 Nova toda semana</li><li>🎧 Áudio para dormir</li><li>🖨️ PDF para imprimir</li><li>💳 Pix ou cartão</li>
      </ul>
    </div>
    <div class="art">${raw(sampleScenes[1])}</div>
  </div>
</section>

<section class="block alt">
  <div class="wrap center">
    <h2>Como funciona</h2>
    <p class="muted">Leva 2 minutos. Depois disso, é só esperar o e-mail chegar.</p>
    <div class="steps">
      <div class="step"><div class="num">1</div><h3>Conte sobre a criança</h3>
        <p>Nome, idade, aparência, o que ela ama e os temas que você quer reforçar.</p></div>
      <div class="step"><div class="num">2</div><h3>A mágica acontece</h3>
        <p>Nossa inteligência artificial escreve e ilustra uma história inédita, só dela.</p></div>
      <div class="step"><div class="num">3</div><h3>Chega no seu e-mail</h3>
        <p>A primeira chega logo após o pagamento. Depois, uma nova toda semana, para ler ou ouvir.</p></div>
    </div>
  </div>
</section>

<section class="block">
  <div class="wrap">
    <div class="center">
      <h2>Veja um pedacinho</h2>
      <p class="muted">“${sample.titulo}”, feita para a Lia, de 5 anos, e seu cachorro Pipoca.</p>
    </div>
    <div class="sample">
      <div class="art">${raw(sampleScenes[0])}</div>
      <div>
        <blockquote>${sample.cenas[0].texto}</blockquote>
        <p class="mt"><a class="btn secondary" href="/exemplo">Ler a história inteira</a></p>
      </div>
    </div>
  </div>
</section>

<section class="block alt" id="planos">
  <div class="wrap center">
    <h2>Planos</h2>
    <p class="muted">Sem fidelidade e sem renovação automática no cartão: avisamos antes de acabar e você renova se quiser.</p>
    <div class="plans">
      ${Object.entries(allPlans).map(([key, plan]) => {
        const saving = Math.round(100 - (plan.priceCents * 100) / ((monthly * plan.days) / 30));
        return html`
      <div class="plan${key === 'trimestral' ? ' featured' : ''}">
        <h3>${plan.name}</h3>
        <div class="price">${brl(plan.priceCents)}</div>
        <div class="muted">${plan.days} dias · cerca de ${Math.round(plan.days / 7)} histórias</div>
        <ul>
          <li>História nova toda semana</li>
          <li>Ilustrações com a aparência da criança</li>
          <li>Áudio para ouvir e PDF para imprimir</li>
          ${key !== 'mensal' ? html`<li><b>Economize ${saving}%</b></li>` : ''}
        </ul>
        <a class="btn${key === 'trimestral' ? '' : ' secondary'} block" href="/assinar?plano=${key}">Escolher</a>
      </div>`;
      })}
    </div>
  </div>
</section>

<section class="block">
  <div class="wrap narrow faq">
    <h2 class="center">Perguntas frequentes</h2>
    <details><summary>As histórias são escritas por quem?</summary>
      <p>Por uma inteligência artificial orientada a escrever histórias infantis. Cada história passa por uma revisão
        automática que confere se o conteúdo é adequado para a idade antes de ser enviada.</p></details>
    <details><summary>Preciso mandar foto da criança?</summary>
      <p>Não. Você escolhe a aparência (pele, cabelo, olhos, óculos e cor favorita) e nós desenhamos um personagem
        que fica igualzinho em todas as histórias.</p></details>
    <details><summary>Como recebo as histórias?</summary>
      <p>Por e-mail, com um link para ler no celular, ouvir a história narrada e baixar o PDF para imprimir.</p></details>
    <details><summary>Posso cancelar?</summary>
      <p>Não existe cobrança automática: o plano vale pelo período pago. Avisamos alguns dias antes de acabar e você
        decide se quer renovar. Se se arrepender em até 7 dias da compra, devolvemos o valor.</p></details>
    <details><summary>Tenho mais de um filho. E agora?</summary>
      <p>Faça uma assinatura para cada criança usando o mesmo e-mail. Todas aparecem juntas na sua conta.</p></details>
  </div>
</section>

<section class="block alt">
  <div class="wrap center">
    <h2>Que tal começar hoje à noite?</h2>
    <p class="muted">A primeira história chega minutos depois do pagamento.</p>
    <a class="btn" href="/assinar">Criar a primeira história</a>
  </div>
</section>`,
  });
}

// ---------------------------------------------------------------- formulário da criança

const checked = (cond) => (cond ? raw(' checked') : '');
const selected = (cond) => (cond ? raw(' selected') : '');

export function childFields(values) {
  const app = values.appearance || {};
  const chips = (name, options, current, labelOf, swatch) => Object.entries(options).map(([key, value]) => html`
        <label><input type="radio" name="${name}" value="${key}"${checked(current === key)}><span>${swatch ? html`<i style="background:${value}"></i>` : ''}${labelOf(key, value)}</span></label>`);
  return html`
<div class="card">
  <h2 class="h3">Sobre a criança</h2>
  <div class="form-grid">
    <div>
      <label for="child_name">Nome ou apelido</label>
      <input type="text" id="child_name" name="child_name" maxlength="40" required autocomplete="off" value="${values.child_name || ''}">
      <div class="hint">Do jeito que vocês chamam em casa.</div>
    </div>
    <div>
      <label for="age">Idade</label>
      <select id="age" name="age" required>
        ${Array.from({ length: 12 }, (_, i) => i + 1).map((a) => html`<option value="${a}"${selected(Number(values.age || 5) === a)}>${a} ${a === 1 ? 'ano' : 'anos'}</option>`)}
      </select>
    </div>
    <fieldset class="full">
      <legend class="label">É...</legend>
      <div class="chips">${chips('gender', GENDERS, values.gender || 'neutro', (k, v) => v)}</div>
    </fieldset>
  </div>
</div>

<div class="card">
  <h2 class="h3">Como ela é</h2>
  <div class="avatar-box">
    <img id="avatar-preview" src="/avatar.svg" alt="Prévia do personagem" width="220" height="220">
    <div class="form-grid">
      <fieldset class="full"><legend class="label">Tom de pele</legend>
        <div class="chips swatches">${chips('skin', SKIN_TONES, app.skin || 'media_clara', (k) => LABELS.skin[k], true)}</div></fieldset>
      <fieldset class="full"><legend class="label">Cabelo</legend>
        <div class="chips">${chips('hair_style', HAIR_STYLES, app.hair_style || 'curto', (k, v) => v)}</div></fieldset>
      <fieldset class="full"><legend class="label">Cor do cabelo</legend>
        <div class="chips swatches">${chips('hair_color', HAIR_COLORS, app.hair_color || 'castanho', (k) => LABELS.hair_color[k], true)}</div></fieldset>
      <fieldset class="full"><legend class="label">Olhos</legend>
        <div class="chips swatches">${chips('eyes', EYE_COLORS, app.eyes || 'castanhos', (k) => LABELS.eyes[k], true)}
          <label><input type="checkbox" name="glasses" value="1"${checked(app.glasses)}><span>👓 Usa óculos</span></label></div></fieldset>
      <fieldset class="full"><legend class="label">Cor favorita</legend>
        <div class="chips swatches">${chips('fav_color', FAVORITE_COLORS, app.fav_color || 'azul', (k) => LABELS.fav_color[k], true)}</div></fieldset>
      <div>
        <label for="pet_type">Bichinho de estimação</label>
        <select id="pet_type" name="pet_type">
          ${Object.entries(PETS).map(([key, label]) => html`<option value="${key}"${selected((values.pet_type || '') === key)}>${label}</option>`)}
        </select>
      </div>
      <div>
        <label for="pet_name">Nome do bichinho</label>
        <input type="text" id="pet_name" name="pet_name" maxlength="30" autocomplete="off" value="${values.pet_name || ''}">
      </div>
    </div>
  </div>
</div>

<div class="card">
  <h2 class="h3">Do que ela gosta</h2>
  <div class="chips">
    ${INTERESTS.map((item) => html`<label><input type="checkbox" name="interests" value="${item}"${checked((values.interests || []).includes(item))}><span>${item}</span></label>`)}
  </div>
  <div class="hint">Escolha até 5.</div>
  <div class="mt">
    <label for="interests_extra">Algo mais que a gente deva saber? (opcional)</label>
    <textarea id="interests_extra" name="interests_extra" rows="2" maxlength="200" placeholder="Ex.: ama girafas, tem uma irmã chamada Bia, adora panqueca">${values.interests_extra || ''}</textarea>
  </div>
</div>

<div class="card">
  <h2 class="h3">Temas que você quer reforçar</h2>
  <div class="chips">
    ${Object.entries(THEMES).map(([key, theme]) => html`<label><input type="checkbox" name="themes" value="${key}"${checked((values.themes || []).includes(key))}><span>${theme[0]}</span></label>`)}
  </div>
  <div class="hint">Escolha até 4. As histórias vão alternando entre eles. Se não escolher nenhum, variamos todos.</div>
</div>`;
}

export function signup({ values, errors = [], paused = null }) {
  return layout({
    title: 'Assinar',
    scripts: ['/static/form.js?v=3'],
    content: html`
<div class="wrap narrow page-pad">
  <div class="center intro">
    <h1>Vamos criar a primeira história</h1>
    <p class="muted">Quanto mais você contar, mais a história vai ter a cara da criança.</p>
  </div>
  ${errorsBox(errors)}
  ${config.paymentProvider === 'fake' ? html`<div class="notice">Este site está em fase de testes: os pagamentos ainda não estão liberados.</div>` : ''}
  ${paused ? html`<div class="errors">As novas assinaturas estão pausadas por alguns instantes. Volte em breve!</div>` : ''}
  <form method="post" action="/assinar" data-avatar>
    ${childFields(values)}
    <div class="card">
      <h2 class="h3">Seus dados</h2>
      <div class="form-grid">
        <div>
          <label for="parent_name">Seu nome</label>
          <input type="text" id="parent_name" name="parent_name" maxlength="80" required autocomplete="name" value="${values.parent_name || ''}">
        </div>
        <div>
          <label for="email">Seu e-mail</label>
          <input type="email" id="email" name="email" required autocomplete="email" value="${values.email || ''}">
          <div class="hint">É por aqui que as histórias chegam.</div>
        </div>
        <fieldset class="full">
          <legend class="label">Plano</legend>
          <div class="plan-pick">
            ${Object.entries(plans()).map(([key, plan]) => html`
            <label><input type="radio" name="plan" value="${key}"${checked((values.plan || 'mensal') === key)}>
              <span>${plan.name}<b>${brl(plan.priceCents)}</b><small class="muted">${plan.days} dias</small></span></label>`)}
          </div>
        </fieldset>
        <div class="full">
          <label class="check"><input type="checkbox" name="consent" value="1" required>
            <span>Sou pai, mãe ou responsável pela criança, li e aceito os <a href="/termos" target="_blank">termos</a>
              e a <a href="/privacidade" target="_blank">política de privacidade</a>, e autorizo o uso destes dados
              apenas para criar as histórias.</span></label>
        </div>
      </div>
    </div>
    <button class="btn block" type="submit">Ir para o pagamento (Pix ou cartão)</button>
    <p class="hint center mt">Pagamento seguro pelo Mercado Pago. Sem renovação automática.</p>
  </form>
</div>`,
  });
}

export function editChild({ customer, child, values, errors = [] }) {
  return layout({
    title: `Editar ${child.name}`,
    noindex: true,
    scripts: ['/static/form.js?v=3'],
    content: html`
<div class="wrap narrow page-pad">
  <p><a href="/conta/${customer.token}">← Voltar para minha conta</a></p>
  <h1>Editar dados de ${child.name}</h1>
  <p class="muted">As mudanças valem a partir da próxima história.</p>
  ${errorsBox(errors)}
  <form method="post" data-avatar>
    ${childFields(values)}
    <button class="btn block" type="submit">Salvar</button>
  </form>
</div>`,
  });
}

// ---------------------------------------------------------------- pagamento

const csrfField = (csrf) => html`<input type="hidden" name="csrf" value="${csrf}">`;

export function fakeCheckout({ order, plan, admin, csrf }) {
  return layout({
    title: 'Pagamento de teste',
    noindex: true,
    content: html`
<div class="wrap narrow page-pad"><div class="card center">
  <h1>Pagamento de teste</h1>
  ${admin ? html`
    <p class="muted">O site está em <b>modo de teste</b> (PAYMENT_PROVIDER=fake). Nenhum dinheiro é cobrado.</p>
    <p>Plano <b>${plan.name}</b> · ${brl(order.amountCents)}</p>
    <form method="post">${csrfField(csrf)}<button class="btn" type="submit">Simular pagamento aprovado</button></form>`
    : html`
    <p>Os pagamentos deste site ainda não foram liberados. Seus dados ficaram guardados e avisaremos assim que as vendas abrirem.</p>
    <p class="hint">Administrador? <a href="/admin/login?next=${encodeURIComponent(`/checkout-teste/${order.token}`)}">Entre</a> para simular o pagamento.</p>`}
</div></div>`,
  });
}

export function thanks({ order }) {
  let body;
  if (order.status === 'canceled' || order.note) {
    body = html`<h1>Pedido cancelado</h1>
      <p>Os dados desta conta foram apagados a pedido do responsável, então este pedido não vale mais.
        Se algum valor foi pago, ele será devolvido integralmente.</p>
      <p class="hint">Dúvidas: <a href="mailto:${config.supportEmail}">${config.supportEmail}</a></p>`;
  } else if (order.status === 'approved') {
    body = html`<h1>Pagamento confirmado! 🎉</h1>
      <p>As histórias de <b>${order.childName}</b> estão garantidas. Se esta é a primeira compra, a primeira
        história já está sendo escrita e ilustrada e chega no seu e-mail em alguns minutos.</p>
      <p>Enviamos para o e-mail cadastrado a confirmação com o <b>link da sua conta</b>: guarde esse e-mail.</p>
      <p class="hint">Não chegou? Confira o spam ou peça um novo link em <a href="/entrar">Minha conta</a>.</p>`;
  } else if (order.status === 'pending') {
    body = html`<h1>Aguardando o pagamento...</h1>
      <p>Assim que o Mercado Pago confirmar (no Pix costuma ser na hora), esta página atualiza sozinha e você recebe um e-mail.</p>
      <p class="hint">Pagou com boleto? A confirmação pode levar até 2 dias úteis.</p>`;
  } else {
    body = html`<h1>O pagamento não foi concluído</h1>
      <p>Nada foi cobrado. Você pode tentar de novo com outra forma de pagamento.</p>
      <p><a class="btn" href="/assinar">Tentar de novo</a></p>`;
  }
  return layout({
    title: 'Obrigado!',
    noindex: true,
    head: order.status === 'pending' ? raw('<meta http-equiv="refresh" content="10">') : '',
    content: html`<div class="wrap narrow page-pad"><div class="card center">${body}</div></div>`,
  });
}

// ---------------------------------------------------------------- área do cliente

export function account({ customer, subs, saved }) {
  const allPlans = plans();
  return layout({
    title: 'Minha conta',
    noindex: true,
    content: html`
<div class="wrap narrow page-pad">
  <h1>Olá, ${customer.parentName.split(' ')[0]}!</h1>
  <p class="muted">Guarde o link desta página: ele é a chave da sua conta. Perdeu? Peça um novo em <a href="/entrar">Minha conta</a>.</p>
  ${saved ? html`<div class="notice">Dados salvos! Valem a partir da próxima história.</div>` : ''}
  ${subs.length ? '' : html`<div class="card"><p>Ainda não há assinaturas ativas. Se você acabou de pagar, aguarde alguns instantes e atualize a página.</p></div>`}
  ${subs.map((sub) => html`
  <div class="card" id="renovar-${sub.id}">
    <div class="sub-card">
      <div class="sub-avatar">${raw(sub.avatar)}</div>
      <div>
        <h2 class="tight">${sub.child.name}</h2>
        ${sub.status === 'active' ? html`<span class="status active">Ativa</span>
          <p>Plano pago até <b>${dateBr(sub.paidUntil)}</b>. Próxima história: <b>${dateBr(sub.nextStoryAt)}</b>.</p>`
          : sub.status === 'expired' ? html`<span class="status expired">Vencida</span>
          <p>As histórias pararam em ${dateBr(sub.paidUntil)}. Renove para continuar de onde parou.</p>`
          : html`<span class="status canceled">Cancelada</span>`}
        ${sub.status !== 'canceled' ? html`
        <form class="inline-form" method="post" action="/conta/${customer.token}/renovar/${sub.id}">
          <select name="plan" aria-label="Plano">
            ${Object.entries(allPlans).map(([key, plan]) => html`<option value="${key}">${plan.name} · ${brl(plan.priceCents)}</option>`)}
          </select>
          <button class="btn small" type="submit">${sub.status === 'expired' ? 'Renovar' : 'Adicionar mais tempo'}</button>
        </form>
        <p class="mt-s"><a href="/conta/${customer.token}/editar/${sub.childId}">Editar dados de ${sub.child.name}</a></p>
        ${sub.status === 'active' ? html`
        <form method="post" action="/conta/${customer.token}/lembretes/${sub.id}" class="mt-s">
          <input type="hidden" name="enabled" value="${sub.remindersEnabled ? '0' : '1'}">
          <button class="btn ghost small" type="submit">${sub.remindersEnabled ? 'Não quero renovar (parar lembretes)' : 'Voltar a receber lembretes de renovação'}</button>
        </form>` : ''}` : ''}

        <h3 class="mt">Histórias</h3>
        ${sub.stories.length ? '' : html`<p class="muted">A primeira história está a caminho!</p>`}
        <ul class="story-list">
          ${sub.stories.map((st) => html`<li>${st.readyAt
            ? html`<span><b>${st.title}</b><br><small class="muted">${dateBr(st.readyAt)}</small></span>
              <a class="btn small secondary" href="/h/${st.token}">Abrir</a>`
            : html`<span class="muted">✨ Uma nova história está sendo criada...</span>`}</li>`)}
        </ul>
      </div>
    </div>
  </div>`)}

  <div class="card">
    <h2 class="h3">Novo filho ou filha?</h2>
    <p>Faça uma nova assinatura com o mesmo e-mail e ela aparece aqui.</p>
    <a class="btn secondary small" href="/assinar">Nova assinatura</a>
  </div>

  <details class="card">
    <summary><b>Apagar meus dados</b></summary>
    <p>Apaga seus dados, os dados das crianças e todas as histórias. Não dá para desfazer. Os registros de pagamento
      ficam guardados de forma anônima, como exige a lei fiscal.</p>
    <form method="post" action="/conta/${customer.token}/apagar" class="inline-form">
      <input type="text" name="confirm" placeholder="Digite APAGAR" aria-label="Confirmação" autocomplete="off">
      <button class="btn small danger" type="submit">Apagar tudo</button>
    </form>
  </details>
</div>`,
  });
}

export function login({ sent }) {
  return layout({
    title: 'Minha conta',
    content: html`
<div class="wrap narrow page-pad"><div class="card">
  <h1>Acessar minha conta</h1>
  ${sent ? html`<div class="notice">Se este e-mail tiver uma assinatura, enviamos agora um link de acesso. Confira também a caixa de spam.</div>`
    : html`<p class="muted">Não usamos senha. Digite o e-mail da assinatura e mandamos um link de acesso.</p>`}
  <form method="post" action="/entrar">
    <label for="email">E-mail</label>
    <input type="email" id="email" name="email" required autocomplete="email">
    <p><button class="btn" type="submit">Receber link de acesso</button></p>
  </form>
</div></div>`,
  });
}

// ---------------------------------------------------------------- história

export function storyPage({ story, scenes, childName, pdfUrl, isSample }) {
  return layout({
    title: story.titulo,
    noindex: !isSample,
    scripts: ['/static/story.js?v=4'],
    content: html`
<div class="wrap page-pad">
  <div class="story-head">
    ${isSample ? html`<p class="muted">Exemplo de história · feita para ${childName}, 5 anos</p>` : ''}
    <h1 id="story-title">${story.titulo}</h1>
    <p class="muted">Uma história feita especialmente para ${childName}</p>
  </div>
  <div class="player" id="player" hidden>
    <button class="btn small" type="button" id="tts-play">▶ Ouvir a história</button>
    <button class="btn small secondary" type="button" id="tts-stop" hidden>■ Parar</button>
    <span class="player-note">Narrada pelo seu celular ou computador</span>
  </div>
  <div id="story-body">
    ${story.cenas.map((scene, i) => html`
    <div class="story-scene">
      <div class="art">${raw(scenes[i])}</div>
      <p class="scene-text">${scene.texto}</p>
    </div>`)}
  </div>
  <div class="story-end">
    <h2>Fim ✨</h2>
    ${story.licao ? html`<p>${story.licao}</p>` : ''}
    ${pdfUrl ? html`<p><a class="btn" href="${pdfUrl}">Baixar PDF para imprimir</a></p>` : ''}
    ${isSample ? html`<p><a class="btn" href="/assinar">Quero uma história assim para meu filho</a></p>` : ''}
  </div>
</div>`,
  });
}

// ---------------------------------------------------------------- textos legais

export function privacy() {
  return layout({
    title: 'Privacidade',
    content: html`
<div class="wrap narrow card legal">
  <h1>Política de privacidade</h1>
  <p class="muted">Modelo inicial. Revise com um profissional antes de vender.</p>
  <h2 class="h3">Quais dados coletamos</h2>
  <p>Do responsável: nome e e-mail. Da criança: nome ou apelido, idade, gênero (opcional), características de
    aparência escolhidas em uma lista (não pedimos fotos), gostos, temas e nome do bichinho de estimação.
    Os dados de pagamento ficam com o Mercado Pago; não temos acesso ao número do seu cartão.</p>
  <h2 class="h3">Para que usamos</h2>
  <p>Exclusivamente para criar e entregar as histórias, enviar avisos da assinatura e cumprir obrigações legais.
    Não vendemos nem compartilhamos dados para publicidade.</p>
  <h2 class="h3">Dados de crianças (LGPD, art. 14)</h2>
  <p>Tratamos dados de crianças somente com o consentimento do responsável, dado no momento da assinatura, e apenas
    o mínimo necessário para personalizar as histórias. Para escrever o texto usamos um serviço de inteligência
    artificial externo: enviamos a idade, os gostos, os temas e o texto livre que você escrever, mas
    <b>nunca o nome da criança nem o do bichinho</b>. Eles são trocados por apelidos fictícios e só voltam para a
    história dentro do nosso servidor.</p>
  <h2 class="h3">Por quanto tempo guardamos</h2>
  <p>Enquanto houver assinatura ou até você pedir a exclusão. Registros de pagamento são guardados pelo prazo exigido
    pela legislação fiscal, sem os dados da criança.</p>
  <h2 class="h3">Seus direitos</h2>
  <p>Você pode corrigir os dados na sua conta a qualquer momento e apagar tudo pelo botão “Apagar meus dados”.
    Dúvidas: <a href="mailto:${config.supportEmail}">${config.supportEmail}</a>.</p>
</div>`,
  });
}

export function terms() {
  return layout({
    title: 'Termos',
    content: html`
<div class="wrap narrow card legal">
  <h1>Termos de uso</h1>
  <p class="muted">Modelo inicial. Revise com um profissional antes de vender.</p>
  <h2 class="h3">O serviço</h2>
  <p>${config.siteName} entrega histórias infantis personalizadas, criadas por inteligência artificial a partir das
    informações fornecidas pelo responsável, com ilustrações, narração pelo navegador e PDF. Cada plano dá direito a
    uma história nova a cada ${config.storyIntervalDays} dias durante o período pago.</p>
  <h2 class="h3">Conteúdo gerado por IA</h2>
  <p>Toda história passa por verificações automáticas de adequação à idade. Ainda assim, recomendamos que um adulto
    leia antes ou junto com a criança. Se algo não agradar, fale com a gente que refazemos a história.</p>
  <h2 class="h3">Pagamento e renovação</h2>
  <p>O pagamento é feito pelo Mercado Pago (Pix, cartão ou boleto). Não há renovação automática: o plano vale pelo
    período pago e avisamos antes do vencimento.</p>
  <h2 class="h3">Arrependimento e reembolso</h2>
  <p>Conforme o Código de Defesa do Consumidor (art. 49), você pode desistir em até 7 dias após a compra e receber o
    valor de volta. Basta escrever para <a href="mailto:${config.supportEmail}">${config.supportEmail}</a>.</p>
  <h2 class="h3">Uso das histórias</h2>
  <p>As histórias são para uso pessoal e familiar: ler, ouvir, imprimir e presentear à vontade.</p>
</div>`,
  });
}

// ---------------------------------------------------------------- administração

export function adminLogin({ error, next, enabled }) {
  return layout({
    title: 'Entrar no painel',
    noindex: true,
    content: html`
<div class="wrap narrow page-pad"><div class="card">
  <h1>Painel administrativo</h1>
  ${!enabled ? html`<div class="errors">Painel desativado: defina ADMIN_EMAIL, ADMIN_PASSWORD e SESSION_SECRET no .env.site.</div>` : ''}
  ${error ? html`<div class="errors" role="alert">${error}</div>` : ''}
  <form method="post" action="/admin/login">
    <input type="hidden" name="next" value="${next || '/admin'}">
    <label for="email">E-mail</label>
    <input type="email" id="email" name="email" required autocomplete="username">
    <label for="password" class="mt-s">Senha</label>
    <input type="password" id="password" name="password" required autocomplete="current-password">
    <p><button class="btn" type="submit">Entrar</button></p>
  </form>
</div></div>`,
  });
}

export function admin({ stats, subs, stories, orders, warnings, csrf }) {
  const heartbeat = stats.workerHeartbeat ? stats.workerHeartbeat.slice(0, 16).replace('T', ' ') : 'nunca';
  return layout({
    title: 'Painel',
    noindex: true,
    content: html`
<div class="wrap page-pad">
  <div class="admin-head">
    <h1>Painel</h1>
    <form method="post" action="/admin/logout">${csrfField(csrf)}<button class="btn ghost small" type="submit">Sair</button></form>
  </div>
  ${warnings.map((w) => html`<div class="errors">⚠️ ${w}</div>`)}
  <div class="stats">
    <div class="stat"><b>${stats.active}</b>assinaturas ativas</div>
    <div class="stat"><b>${brl(stats.revenue30d)}</b>faturado em 30 dias (${stats.orders30d} ${stats.orders30d === 1 ? 'venda' : 'vendas'})</div>
    <div class="stat"><b>${stats.storiesReady}</b>histórias entregues</div>
    <div class="stat"><b>${stats.storiesQueued} / ${stats.storiesFailed}</b>na fila / com falha</div>
  </div>
  <p class="muted">Worker visto por último: ${heartbeat} (UTC) · IA: ${config.llmProvider === 'demo' ? 'modo demonstração' : config.llmModels.join(' → ')} · E-mail: ${config.emailProvider}</p>

  <div class="card">
    <h2 class="h3">Histórias recentes</h2>
    <div class="table-wrap"><table>
      <tr><th>#</th><th>Criança</th><th>Título</th><th>Status</th><th>Tentativas</th><th>Criada</th><th></th></tr>
      ${stories.map((st) => html`<tr>
        <td>${st.id}</td><td>${st.childName}</td>
        <td>${st.status === 'ready' ? html`<a href="/h/${st.token}" target="_blank" rel="noopener">${st.title}</a>` : st.title || '—'}
          ${st.error ? html`<br><small class="err">${st.error.slice(0, 200)}</small>` : ''}</td>
        <td>${st.status}${st.retryAt && st.status === 'queued' ? html`<br><small class="muted">nova tentativa às ${st.retryAt.slice(11, 16)} (UTC)</small>` : ''}</td><td>${st.attempts}</td><td>${dateBr(st.createdAt)}</td>
        <td><form method="post" action="/admin/historia/${st.id}/refazer">${csrfField(csrf)}<button class="btn ghost small" type="submit">Refazer</button></form></td>
      </tr>`)}
    </table></div>
  </div>

  <div class="card">
    <h2 class="h3">Assinaturas</h2>
    <div class="table-wrap"><table>
      <tr><th>#</th><th>E-mail</th><th>Criança</th><th>Status</th><th>Pago até</th><th>Próxima</th><th></th></tr>
      ${subs.map((s) => html`<tr>
        <td>${s.id}</td><td>${s.email}<br><a href="/conta/${s.customerToken}" target="_blank" rel="noopener">abrir conta do cliente</a></td><td>${s.childName} (${s.age})</td><td>${s.status}</td>
        <td>${dateBr(s.paidUntil)}</td><td>${dateBr(s.nextStoryAt)}</td>
        <td>${s.status === 'active' ? html`<form method="post" action="/admin/assinatura/${s.id}/gerar">${csrfField(csrf)}<button class="btn ghost small" type="submit">Gerar agora</button></form>` : ''}</td>
      </tr>`)}
    </table></div>
  </div>

  <div class="card">
    <h2 class="h3">Pedidos</h2>
    <div class="table-wrap"><table>
      <tr><th>#</th><th>E-mail</th><th>Plano</th><th>Valor</th><th>Status</th><th>Pagamento</th><th>Data</th></tr>
      ${orders.map((o) => html`<tr><td>${o.id}</td><td>${o.email}</td><td>${o.plan}</td><td>${brl(o.amountCents)}</td>
        <td>${o.status}${o.note ? html`<br><small class="err">${o.note}</small>` : ''}${(o.duplicatePayments || []).length ? html`<br><small class="err">pago em duplicidade: ${o.duplicatePayments.join(', ')} (estornar)</small>` : ''}</td>
        <td>${o.paymentId || '—'}</td><td>${dateBr(o.createdAt)}</td></tr>`)}
    </table></div>
  </div>
</div>`,
  });
}
