// Pagamentos via Mercado Pago Checkout Pro (Pix, cartão e boleto; sem mensalidade, só taxa por venda).
// Modelo pré-pago: cada pagamento libera N dias e o sistema manda o link de renovação antes de vencer.
// Segurança: o conteúdo do webhook nunca é confiado; o pagamento é sempre reconsultado na API.
import { config } from './config.js';

const MP_API = 'https://api.mercadopago.com';
const TIMEOUT_MS = 30000;

export class PaymentError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'PaymentError';
  }
}

function mpHeaders() {
  if (!config.mpAccessToken) throw new PaymentError('MP_ACCESS_TOKEN não configurado.');
  return { Authorization: `Bearer ${config.mpAccessToken}`, accept: 'application/json' };
}

// Chamada à API do Mercado Pago: erro de rede ou status fora de 2xx vira PaymentError.
async function mpRequest(method, url, body, what) {
  const headers = mpHeaders();
  if (body !== undefined) headers['content-type'] = 'application/json';
  let res;
  let text;
  try {
    res = await fetch(MP_API + url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    text = await res.text();
  } catch (err) {
    throw new PaymentError(`${what}: ${err.message}`, { cause: err });
  }
  if (!res.ok) throw new PaymentError(`${what} (HTTP ${res.status}): ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new PaymentError(`${what}: resposta inválida: ${text.slice(0, 300)}`);
  }
}

// Cria o checkout e devolve { url para redirecionar, ref do provedor }.
export async function createCheckout(order, customer, plan) {
  if (config.paymentProvider === 'fake') {
    return { url: `${config.baseUrl}/checkout-teste/${order.token}`, ref: null };
  }
  if (config.paymentProvider !== 'mercadopago') {
    throw new PaymentError(`PAYMENT_PROVIDER desconhecido: ${config.paymentProvider}`);
  }

  const back = `${config.baseUrl}/obrigado/${order.token}`;
  const body = {
    items: [{
      id: order.plan,
      title: `${config.siteName} - Plano ${plan.name} (${plan.days} dias)`,
      quantity: 1,
      currency_id: 'BRL',
      unit_price: Math.round(Number(order.amountCents)) / 100,
    }],
    payer: { email: customer.email, name: customer.parentName },
    external_reference: order.token,
    notification_url: `${config.baseUrl}/webhooks/mercadopago`,
    back_urls: { success: back, pending: back, failure: back },
    auto_return: 'approved',
    statement_descriptor: String(config.mpStatementDescriptor ?? '').slice(0, 13),
  };
  const data = await mpRequest('POST', '/checkout/preferences', body, 'Mercado Pago recusou a criação do checkout');
  if (!data?.init_point) {
    throw new PaymentError(`Mercado Pago não devolveu o link do checkout: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return { url: data.init_point, ref: data.id ?? null };
}

export async function fetchPayment(paymentId) {
  return mpRequest('GET', `/v1/payments/${encodeURIComponent(String(paymentId))}`, undefined,
    `Falha ao consultar o pagamento ${paymentId}`);
}

export async function searchPayments(externalReference) {
  const params = new URLSearchParams({
    external_reference: externalReference, sort: 'date_created', criteria: 'desc',
  });
  const data = await mpRequest('GET', `/v1/payments/search?${params}`, undefined,
    'Falha ao buscar pagamentos no Mercado Pago');
  return Array.isArray(data?.results) ? data.results : [];
}

const STATUS_MAP = {
  approved: 'approved',
  refunded: 'refunded',
  charged_back: 'refunded',
  rejected: 'rejected',
  cancelled: 'rejected',
};

// Extrai o que interessa de um pagamento do Mercado Pago.
export function normalize(payment) {
  const status = String(payment?.status ?? '');
  return {
    paymentId: String(payment?.id ?? ''),
    orderToken: payment?.external_reference || '',
    status: Object.hasOwn(STATUS_MAP, status) ? STATUS_MAP[status] : 'pending',
    amountCents: Math.round(Number(payment?.transaction_amount || 0) * 100),
  };
}
