#!/usr/bin/env bash
# Instala tudo num VPS Ubuntu/Debian novo. Uso:
#   git clone <este repositório> historinhas && cd historinhas && sudo bash deploy/install.sh
set -euo pipefail

cd "$(dirname "$0")/.."

if [ "$(id -u)" -ne 0 ]; then
  echo "Rode com sudo: sudo bash deploy/install.sh"
  exit 1
fi

echo "==> Instalando Docker (se ainda não tiver)"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi

RAM_GB=$(awk '/MemTotal/ {printf "%d", $2/1024/1024}' /proc/meminfo)
echo "==> Memória do servidor: ${RAM_GB} GB"

# Swap ajuda servidores pequenos a carregar o modelo de IA sem travar
if [ "$RAM_GB" -lt 12 ] && ! swapon --show | grep -q .; then
  echo "==> Criando 4 GB de swap"
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo "/swapfile none swap sw 0 0" >> /etc/fstab
fi

if [ ! -f .env ]; then
  cp .env.example .env
  read -rp "Seu domínio (ex.: historinhas.com.br): " DOMAIN
  read -rp "Seu e-mail (recebe alertas do sistema): " ADMIN_EMAIL
  ADMIN_PASSWORD=$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 20)
  if [ "$RAM_GB" -ge 14 ]; then MODEL="gemma4:e4b"; else MODEL="gemma3:4b"; fi
  sed -i \
    -e "s|^DOMAIN=.*|DOMAIN=${DOMAIN}|" \
    -e "s|^BASE_URL=.*|BASE_URL=https://${DOMAIN}|" \
    -e "s|^SUPPORT_EMAIL=.*|SUPPORT_EMAIL=contato@${DOMAIN}|" \
    -e "s|^SMTP_FROM=.*|SMTP_FROM=Era Uma Vez Eu <contato@${DOMAIN}>|" \
    -e "s|^ADMIN_EMAIL=.*|ADMIN_EMAIL=${ADMIN_EMAIL}|" \
    -e "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=${ADMIN_PASSWORD}|" \
    -e "s|^LLM_MODEL=.*|LLM_MODEL=${MODEL}|" \
    .env
  echo
  echo "    Senha do painel admin (anote!): ${ADMIN_PASSWORD}"
  echo "    Modelo de IA escolhido para ${RAM_GB} GB de RAM: ${MODEL}"
  echo
fi

mkdir -p data
echo "==> Subindo o sistema (a primeira vez demora: baixa a IA de 3 a 7 GB)"
docker compose up -d --build

echo "==> Backup diário às 4h (guarda 7 dias)"
CRON="0 4 * * * cd $(pwd) && bash deploy/backup.sh >/dev/null 2>&1"
( crontab -l 2>/dev/null | grep -v deploy/backup.sh; echo "$CRON" ) | crontab -

DOMAIN=$(grep '^DOMAIN=' .env | cut -d= -f2)
cat <<EOF

Pronto! Próximos passos:
  1. No painel do seu domínio, crie um registro A apontando ${DOMAIN} para o IP deste servidor.
  2. Abra https://${DOMAIN} (o HTTPS aparece sozinho em 1-2 minutos depois do DNS propagar).
  3. Faça uma compra de teste (o pagamento começa em modo teste).
  4. Configure Mercado Pago e SMTP no arquivo .env e rode: docker compose up -d
  Painel: https://${DOMAIN}/admin   ·   Logs: docker compose logs -f worker
EOF
