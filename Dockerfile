# =====================================================
# BluePoint API - Dockerfile
# Versão leve: reconhecimento facial via microserviço Python
# Tunel Winthor: binary Go embedding tsnet (sem tailscaled+gost)
# =====================================================

# Stage 1: Dependencies
FROM node:20-alpine AS deps

WORKDIR /app

# Copiar arquivos de dependências
COPY package.json package-lock.json ./
RUN npm ci

# Stage 2: Builder
FROM node:20-alpine AS builder

WORKDIR /app

# Copiar dependências do stage anterior (incluindo devDependencies para build)
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build da aplicação
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# Stage 2b: winthor-tsnet (Go binary que substitui tailscaled+gost)
# Embeda a lib tailscale.com/tsnet pra dispensar SOCKS5 — o handshake do
# Oracle quebrava com gost+SOCKS5 (ORA-12547). Aqui o relay disca direto
# via wireguard userspace pro peer winthor-bridge-pc.
FROM golang:1.24-alpine AS winthor-tsnet
WORKDIR /src
RUN apk add --no-cache git ca-certificates
# GOFLAGS=-mod=mod faz go build resolver/baixar deps faltantes de runtime
# sem precisar de `go mod tidy` (que arrasta dependências só de testes do
# tsnet — ssh/tailssh, dhcp, etc — que falham na verificação do sum DB).
ENV GOFLAGS=-mod=mod
COPY winthor-tsnet/ ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -trimpath -ldflags="-s -w" -o /out/winthor-tsnet .

# Stage 3: Runner (Produção)
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Oracle Instant Client (necessário pra integrar com Winthor via oracledb thick).
# Alpine usa musl — Instant Client precisa de glibc-compat. Stack:
#  - libaio: requirement do client
#  - libc6-compat / gcompat: shim de glibc no Alpine
#  - libnsl, libstdc++: deps adicionais do client
RUN apk add --no-cache curl unzip libaio libc6-compat libnsl libstdc++ gcompat \
    ca-certificates

ARG INSTANT_CLIENT_VER=21.10.0.0.0dbru
RUN mkdir -p /opt/oracle && cd /opt/oracle \
 && curl -sL -o ic.zip https://download.oracle.com/otn_software/linux/instantclient/2110000/instantclient-basiclite-linux.x64-${INSTANT_CLIENT_VER}.zip \
 && unzip -q ic.zip \
 && rm ic.zip \
 && ln -s /opt/oracle/instantclient_21_10 /opt/oracle/instantclient

# IMPORTANT: NUNCA setar /etc/ld-musl-x86_64.path apontando só pra instantclient
# — substitui o loader path padrão (/lib:/usr/lib:/usr/local/lib) e quebra o
# node procurando libstdc++ ("Error relocating /usr/local/bin/node: _ZTV...
# symbol not found"). LD_LIBRARY_PATH é prepend, mantém /lib e /usr/lib
# acessíveis. Instant Client basiclite não traz libstdc++ na pasta, então
# prepend é seguro — só vai achar libclntsh/libnnz21/libclntshcore.
ENV ORACLE_INSTANT_CLIENT_DIR=/opt/oracle/instantclient
ENV LD_LIBRARY_PATH=/opt/oracle/instantclient

# winthor-tsnet: relay TCP que joina a tailnet via lib embarcada e disca
# direto pro winthor-bridge-pc (sem SOCKS5). Fica em /usr/local/bin pra
# o entrypoint chamar. Estado da tailnet em /var/lib/tsnet (efêmero).
COPY --from=winthor-tsnet /out/winthor-tsnet /usr/local/bin/winthor-tsnet
RUN chmod +x /usr/local/bin/winthor-tsnet && mkdir -p /var/lib/tsnet

# Roda como root (simplifica permissões em /var/lib/tsnet e /etc/hosts).
# Fargate isola via task role + ENI; não há multi-tenant no container.

# Copiar arquivos necessários do build standalone
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# Copiar schema do banco para inicialização (opcional)
COPY --from=builder /app/database ./database

# Copiar módulos que precisam de arquivos de dados em runtime (fontes do pdfkit)
COPY --from=builder /app/node_modules/pdfkit ./node_modules/pdfkit
COPY --from=builder /app/node_modules/fontkit ./node_modules/fontkit
COPY --from=builder /app/node_modules/linebreak ./node_modules/linebreak
COPY --from=builder /app/node_modules/png-js ./node_modules/png-js
# oracledb (precisa do binário nativo + Instant Client em runtime)
COPY --from=builder /app/node_modules/oracledb ./node_modules/oracledb

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# Entrypoint customizado: sobe winthor-tsnet (joina tailnet + escuta :30492)
# antes de exec node server.js. Veja entrypoint.sh.
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
CMD ["/entrypoint.sh"]
