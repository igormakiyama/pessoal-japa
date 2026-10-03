"""Pagamentos via Mercado Pago Checkout Pro (Pix, cartão e boleto; sem mensalidade, só taxa por venda).

Modelo pré-pago: cada pagamento libera N dias de assinatura e o sistema manda o link de
renovação automaticamente antes de vencer. Assim o Pix funciona, não só cartão.

Segurança: o conteúdo do webhook nunca é confiado. O sistema sempre consulta o pagamento
direto na API do Mercado Pago com o seu token antes de liberar qualquer coisa.
"""

import logging

import httpx

from .config import settings

log = logging.getLogger(__name__)

MP_API = "https://api.mercadopago.com"


class PaymentError(Exception):
    pass


def _mp_headers() -> dict:
    if not settings.mp_access_token:
        raise PaymentError("MP_ACCESS_TOKEN não configurado.")
    return {"Authorization": f"Bearer {settings.mp_access_token}"}


def create_checkout(order: dict, customer: dict, plan: dict) -> tuple[str, str | None]:
    """Cria o checkout e devolve (url_para_redirecionar, referência_do_provedor)."""
    if settings.payment_provider == "fake":
        return f"{settings.base_url}/checkout-teste/{order['token']}", None
    if settings.payment_provider != "mercadopago":
        raise PaymentError(f"PAYMENT_PROVIDER desconhecido: {settings.payment_provider}")

    back = f"{settings.base_url}/obrigado/{order['token']}"
    body = {
        "items": [{
            "id": order["plan"],
            "title": f"{settings.site_name} - Plano {plan['name']} ({plan['days']} dias)",
            "quantity": 1,
            "currency_id": "BRL",
            "unit_price": round(order["amount_cents"] / 100, 2),
        }],
        "payer": {"email": customer["email"], "name": customer["parent_name"]},
        "external_reference": order["token"],
        "notification_url": f"{settings.base_url}/webhooks/mercadopago",
        "back_urls": {"success": back, "pending": back, "failure": back},
        "auto_return": "approved",
        "statement_descriptor": settings.mp_statement_descriptor[:13],
    }
    try:
        resp = httpx.post(f"{MP_API}/checkout/preferences", json=body, headers=_mp_headers(), timeout=30)
        resp.raise_for_status()
    except httpx.HTTPError as exc:
        detail = exc.response.text[:300] if isinstance(exc, httpx.HTTPStatusError) else str(exc)
        raise PaymentError(f"Mercado Pago recusou a criação do checkout: {detail}") from exc
    data = resp.json()
    return data["init_point"], data.get("id")


def fetch_payment(payment_id: str) -> dict:
    resp = httpx.get(f"{MP_API}/v1/payments/{payment_id}", headers=_mp_headers(), timeout=30)
    resp.raise_for_status()
    return resp.json()


def search_payments(external_reference: str) -> list[dict]:
    resp = httpx.get(
        f"{MP_API}/v1/payments/search",
        params={"external_reference": external_reference, "sort": "date_created", "criteria": "desc"},
        headers=_mp_headers(),
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json().get("results", [])


STATUS_MAP = {
    "approved": "approved",
    "refunded": "refunded",
    "charged_back": "refunded",
    "rejected": "rejected",
    "cancelled": "rejected",
}


def normalize(payment: dict) -> dict:
    """Extrai o que interessa de um pagamento do Mercado Pago."""
    return {
        "payment_id": str(payment.get("id")),
        "order_token": payment.get("external_reference") or "",
        "status": STATUS_MAP.get(payment.get("status", ""), "pending"),
        "amount_cents": round(float(payment.get("transaction_amount") or 0) * 100),
    }
