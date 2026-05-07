# =====================================================
# BluePoint API - Dockerfile
# Versão leve: reconhecimento facial via microserviço Python
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
RUN apk add --no-cache curl unzip libaio libc6-compat libnsl libstdc++ gcompat

ARG INSTANT_CLIENT_VER=21.10.0.0.0dbru
RUN mkdir -p /opt/oracle && cd /opt/oracle \
 && curl -sL -o ic.zip https://download.oracle.com/otn_software/linux/instantclient/2110000/instantclient-basiclite-linux.x64-${INSTANT_CLIENT_VER}.zip \
 && unzip -q ic.zip \
 && rm ic.zip \
 && ln -s /opt/oracle/instantclient_21_10 /opt/oracle/instantclient \
 && echo "/opt/oracle/instantclient" > /etc/ld-musl-x86_64.path

ENV ORACLE_INSTANT_CLIENT_DIR=/opt/oracle/instantclient
ENV LD_LIBRARY_PATH=/opt/oracle/instantclient

# Criar usuário não-root para segurança
RUN addgroup -S -g 1001 nodejs
RUN adduser -S -u 1001 -G nodejs nextjs

# Copiar arquivos necessários do build standalone
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Copiar schema do banco para inicialização (opcional)
COPY --from=builder /app/database ./database

# Copiar módulos que precisam de arquivos de dados em runtime (fontes do pdfkit)
COPY --from=builder /app/node_modules/pdfkit ./node_modules/pdfkit
COPY --from=builder /app/node_modules/fontkit ./node_modules/fontkit
COPY --from=builder /app/node_modules/linebreak ./node_modules/linebreak
COPY --from=builder /app/node_modules/png-js ./node_modules/png-js
# oracledb (precisa do binário nativo + Instant Client em runtime)
COPY --from=builder /app/node_modules/oracledb ./node_modules/oracledb

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
