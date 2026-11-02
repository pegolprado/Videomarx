#!/bin/bash
# VideoAI Studio - instalacao automatica do worker (Oracle Cloud, Ubuntu).
# Somente caracteres ASCII: o console da Oracle recusa acentos e travessoes.
# Troque APENAS a linha SERVICE_ROLE_KEY (e, se tiver, as chaves de IA).
set -euxo pipefail

SERVICE_ROLE_KEY='COLE_AQUI_A_CHAVE_SERVICE_ROLE'
RUNWAY_KEY=''
ANTHROPIC_KEY=''
SUPABASE_URL='https://qsljtyhjlxbkcvvzmwtn.supabase.co'

# memoria extra (swap) para maquinas pequenas
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y docker.io git
apt-get install -y docker-buildx || true
systemctl enable --now docker

# segredos ficam so nesta maquina, legiveis apenas pelo root
cat > /etc/videoai-worker.env <<EOF
SUPABASE_URL=${SUPABASE_URL}
SUPABASE_SERVICE_ROLE_KEY=${SERVICE_ROLE_KEY}
RUNWAYML_API_SECRET=${RUNWAY_KEY}
ANTHROPIC_API_KEY=${ANTHROPIC_KEY}
WORKER_CONCURRENCY=2
EOF
chmod 600 /etc/videoai-worker.env

# atualizacao: baixa o codigo do GitHub e reconstroi o worker quando houver mudanca
cat > /usr/local/bin/videoai-update <<'EOS'
#!/bin/bash
set -euo pipefail
BRANCH=ccr-c2e2102b-fbrd2v
DIR=/opt/videomarx
FORCE=""
if [ ! -d "$DIR/.git" ]; then
  git clone --depth 1 -b "$BRANCH" https://github.com/pegolprado/Videomarx.git "$DIR"
  FORCE=1
fi
cd "$DIR"
OLD=$(git rev-parse HEAD)
git fetch --depth 1 origin "$BRANCH"
git reset --hard FETCH_HEAD
NEW=$(git rev-parse HEAD)
if [ "$OLD" != "$NEW" ] || [ -n "$FORCE" ] || ! docker ps --format '{{.Names}}' | grep -qx videoai-worker; then
  echo "$(date) atualizando para $NEW"
  docker build -f worker/Dockerfile -t videoai-worker .
  docker rm -f videoai-worker 2>/dev/null || true
  docker run -d --restart unless-stopped --name videoai-worker --env-file /etc/videoai-worker.env videoai-worker
  docker image prune -f
fi
EOS
chmod 755 /usr/local/bin/videoai-update

# verifica atualizacoes a cada hora
echo '17 * * * * root /usr/local/bin/videoai-update >> /var/log/videoai-update.log 2>&1' > /etc/cron.d/videoai-update

/usr/local/bin/videoai-update >> /var/log/videoai-update.log 2>&1
