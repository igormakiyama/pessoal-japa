// E-mails (layout em tabelas com estilo inline, que é o que os clientes de e-mail entendem).
// Cada função devolve o HTML pronto; os campos vindos do usuário são escapados pelo html``.
import { config } from '../config.js';
import { html } from '../html.js';
import { dateBr } from '../util.js';

const NOTE = 'font-size:14px;color:#6F6A82;';

// Link com cara de botão
const button = (url, label) => html`<p style="margin:24px 0;"><a href="${url}" style="background:#F2785C;color:#FFFFFF;text-decoration:none;font-weight:bold;padding:14px 26px;border-radius:999px;display:inline-block;">${label}</a></p>`;

function layout(subject, body) {
  return String(html`<!doctype html>
<html lang="pt-BR">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${subject || config.siteName}</title></head>
<body style="margin:0;background:#FFF8EE;font-family:Arial,Helvetica,sans-serif;color:#2D2A3E;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FFF8EE;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border-radius:18px;padding:28px;">
        <tr><td style="font-size:22px;font-weight:bold;color:#5B3E96;padding-bottom:16px;">${config.siteName} ⭐</td></tr>
        <tr><td style="font-size:16px;line-height:1.6;">
          ${body}
        </td></tr>
        <tr><td style="font-size:12px;color:#8A8499;padding-top:24px;border-top:1px solid #EDE4D6;">
          Você recebeu este e-mail porque assinou ${config.siteName}.
          Dúvidas? Responda este e-mail ou escreva para ${config.supportEmail}.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>
`);
}

export function pagamentoConfirmado({ parentName, childName, paidUntil, first, accountUrl, subject }) {
  const firstName = String(parentName ?? '').trim().split(/\s+/)[0];
  return layout(subject, html`
<p>${firstName ? html`Olá, ${firstName}!` : 'Olá!'}</p>
${first ? html`<p>Pagamento confirmado. A primeira história de <b>${childName}</b> já está sendo escrita, ilustrada e narrada.
  Ela chega em outro e-mail daqui a alguns minutos.</p>
<p>Depois disso, chega uma história nova a cada ${config.storyIntervalDays} dias, até ${dateBr(paidUntil)}.</p>`
    : html`<p>Renovação confirmada! As histórias de <b>${childName}</b> continuam chegando até ${dateBr(paidUntil)}.</p>`}
<p>Este é o link da sua conta. Guarde este e-mail: por ele você vê todas as histórias, edita os dados e renova o plano.</p>
${button(accountUrl, 'Abrir minha conta')}
<p>Boas leituras! 📚</p>
`);
}

export function historiaPronta({ childName, title, summary, storyUrl, accountUrl, subject }) {
  return layout(subject, html`
<p>Uma história nova acabou de sair do forno para <b>${childName}</b>:</p>
<h2 style="color:#5B3E96;margin:8px 0;">${title}</h2>
<p style="color:#6F6A82;">${summary}</p>
${button(storyUrl, 'Ler e ouvir a história')}
<p style="${NOTE}">Dica: abra no celular na hora de dormir e aperte o play do áudio.
  Todas as histórias ficam guardadas na <a href="${accountUrl}" style="color:#5B3E96;">sua conta</a>.</p>
`);
}

export function lembreteRenovacao({ childName, paidUntil, accountUrl, subject }) {
  return layout(subject, html`
<p>Olá!</p>
<p>O plano de histórias de <b>${childName}</b> vai até <b>${dateBr(paidUntil)}</b>.
  Para as histórias continuarem chegando sem pausa, é só renovar (Pix ou cartão, leva 1 minuto).</p>
${button(accountUrl, 'Renovar agora')}
<p style="${NOTE}">Não quer renovar? Tudo bem, não cobramos nada automaticamente.
  As histórias que já chegaram continuam guardadas na sua conta.</p>
`);
}

export function planoExpirou({ childName, accountUrl, subject }) {
  return layout(subject, html`
<p>Olá!</p>
<p>O plano de <b>${childName}</b> terminou, e a próxima aventura está esperando para ser escrita. ✨</p>
<p>Renove quando quiser: as histórias continuam de onde pararam, sem repetir as anteriores.</p>
${button(accountUrl, 'Renovar as histórias')}
`);
}

export function linkAcesso({ accountUrl, subject }) {
  return layout(subject, html`
<p>Olá! Aqui está o link para acessar sua conta:</p>
${button(accountUrl, 'Entrar na minha conta')}
<p style="${NOTE}">Não pediu este link? Pode ignorar este e-mail.</p>
`);
}

export function alertaAdmin({ rows = [], adminUrl, subject }) {
  return layout(subject, html`
<p>Algumas histórias falharam 3 vezes seguidas e precisam de atenção:</p>
<ul>${rows.map((r) => html`<li>História #${r.id}: ${String(r.error ?? '').slice(0, 300)}</li>`)}</ul>
${button(adminUrl, 'Abrir o painel')}
`);
}

export const TEMPLATES = {
  pagamento_confirmado: pagamentoConfirmado,
  historia_pronta: historiaPronta,
  lembrete_renovacao: lembreteRenovacao,
  plano_expirou: planoExpirou,
  link_acesso: linkAcesso,
  alerta_admin: alertaAdmin,
};
