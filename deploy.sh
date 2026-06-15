#!/bin/bash
# Deploy Pet Hub Leads — VPS (pethubsystem.com)
# Uso: bash deploy.sh

set -e

APP_DIR="/opt/pethub-leads"
REPO_URL="$(git remote get-url origin 2>/dev/null || echo '')"

echo "=== Pet Hub Leads — Deploy ==="

# 1. Cria pasta se não existir
if [ ! -d "$APP_DIR" ]; then
  echo "[1/5] Criando $APP_DIR..."
  mkdir -p "$APP_DIR"
  if [ -n "$REPO_URL" ]; then
    git clone "$REPO_URL" "$APP_DIR"
  else
    echo "AVISO: Sem remote git. Copie os arquivos manualmente para $APP_DIR"
    exit 1
  fi
else
  echo "[1/5] Atualizando código..."
  cd "$APP_DIR"
  git pull origin main
fi

cd "$APP_DIR"

# 2. Instala dependências
echo "[2/5] Instalando dependências..."
npm install --omit=dev

# 3. Cria pasta de logs
echo "[3/5] Preparando logs..."
mkdir -p logs

# 4. Verifica .env
if [ ! -f ".env" ]; then
  echo ""
  echo "ATENÇÃO: arquivo .env não encontrado em $APP_DIR"
  echo "Copie o .env.example e preencha as variáveis:"
  echo "  cp .env.example .env && nano .env"
  echo ""
  exit 1
fi

# 5. Reinicia com PM2
echo "[4/5] Reiniciando com PM2..."
if pm2 list | grep -q "pethub-leads"; then
  pm2 reload ecosystem.config.cjs --env production
else
  pm2 start ecosystem.config.cjs --env production
  pm2 save
fi

echo "[5/5] Configurando Evolution API..."
source .env
INSTANCE="${EVOLUTION_INSTANCE:-pethub-leads}"
EVOL_URL="${EVOLUTION_API_URL:-http://localhost:8080}"
EVOL_KEY="${EVOLUTION_API_KEY}"
PORT="${PORT:-3001}"

# Cria instância se não existir
echo "  Criando instância '$INSTANCE' no Evolution..."
curl -s -X POST "$EVOL_URL/instance/create" \
  -H "apikey: $EVOL_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"instanceName\": \"$INSTANCE\", \"qrcode\": true}" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('  Instância: ' + d.get('instance',{}).get('instanceName','?'))" 2>/dev/null || true

# Configura webhook
echo "  Configurando webhook..."
curl -s -X POST "$EVOL_URL/webhook/set/$INSTANCE" \
  -H "apikey: $EVOL_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"url\": \"http://localhost:$PORT/api/whatsapp/webhook\",
    \"webhook_by_events\": false,
    \"events\": [\"MESSAGES_UPSERT\"]
  }" > /dev/null && echo "  Webhook configurado: localhost:$PORT/api/whatsapp/webhook" || true

echo ""
echo "=== Deploy concluído ==="
echo "  App rodando na porta $PORT"
echo "  Logs: pm2 logs pethub-leads"
echo "  Status: pm2 status"
echo ""
echo "  Próximo passo — escanear QR Code:"
echo "  curl -s $EVOL_URL/instance/connect/$INSTANCE -H 'apikey: $EVOL_KEY'"
echo ""
