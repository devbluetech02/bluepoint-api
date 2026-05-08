#!/bin/sh
# Entrypoint do container API.
#
# winthor-tsnet (Go binary com tsnet embarcado) substituiu o stack
# tailscaled+gost. Joina a tailnet direto pela biblioteca, escuta em
# 127.0.0.1:30492 e relaya o TCP cru pro peer winthor-bridge-pc (WSL
# Ubuntu no PC do escritório), que tem socat pra cloud-7445.reposit:30492.
#
# /etc/hosts redireciona o hostname público do reposit pro loopback, de
# forma que o oracledb conecta no DSN original mas cai no relay tsnet.

set -e

echo "[entrypoint] iniciando"

# 1) Override DNS reposit → loopback (winthor-tsnet vai escutar aí)
echo "127.0.0.1 cloud-7445.reposit.com.br" >> /etc/hosts

# 2) winthor-tsnet — relay tsnet → winthor-bridge-pc:30492
#    TS_AUTHKEY vem de SSM (secrets do task def). TS_BRIDGE_HOST opcional
#    sobrescreve o destino default na tailnet.
if [ -z "${TS_AUTHKEY}" ]; then
  echo "[entrypoint] AVISO: TS_AUTHKEY vazia — tunel Winthor desabilitado"
else
  TS_BRIDGE_HOST=${TS_BRIDGE_HOST:-100.121.93.39}
  export WINTHOR_BRIDGE="${TS_BRIDGE_HOST}:30492"
  export LISTEN_ADDR="127.0.0.1:30492"
  export TS_HOSTNAME="${TS_HOSTNAME:-people-api-fargate-tsnet}"
  export TS_STATE_DIR="${TS_STATE_DIR:-/var/lib/tsnet}"

  /usr/local/bin/winthor-tsnet >/var/log/winthor-tsnet.log 2>&1 &
  TSNET_PID=$!
  echo "[entrypoint] winthor-tsnet pid=${TSNET_PID} listen=${LISTEN_ADDR} bridge=${WINTHOR_BRIDGE}"

  # Aguarda listener ficar pronto (até 60s — tsnet precisa fazer login na tailnet).
  # busybox nc (Alpine) suporta -z (probe sem enviar dados).
  for i in $(seq 1 60); do
    if nc -z 127.0.0.1 30492 2>/dev/null; then
      echo "[entrypoint] winthor-tsnet pronto (loopback :30492 aceitando)"
      break
    fi
    if ! kill -0 "${TSNET_PID}" 2>/dev/null; then
      echo "[entrypoint] AVISO: winthor-tsnet morreu durante o boot"
      tail -n 50 /var/log/winthor-tsnet.log || true
      break
    fi
    sleep 1
  done
fi

# 3) Inicia API
echo "[entrypoint] exec node server.js"
exec node server.js
