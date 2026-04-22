# Contexto: Implementação de Push Notifications — BluePoint API

## Objetivo

Implementar notificações push para colaboradores via OneSignal na API `bluepoint_api` (Next.js + TypeScript). As notificações devem chegar mesmo com o app fechado (background push).

---

## Stack

- **API:** Next.js 16.1.5, TypeScript, rodando no ECS Fargate
- **Push:** OneSignal SDK v5.4.1 no Flutter
- **Deploy:** ECS cluster `valeris-people`, service `valeris-people-api`
- **URL produção:** `https://people-api.valerisapp.com.br`
- **ECR:** `873153257687.dkr.ecr.us-east-1.amazonaws.com/valeris-people-api`

---

## OneSignal — Credenciais Atuais (nova conta)

| Campo | Valor |
|---|---|
| **App ID** | `63ab3ecb-6061-41bd-85d9-5e781afc7270` |
| **REST API Key** | `os_v2_app_movt5s3amfa33bozlz4bv7dsoaxapcuks2iugnezgokjjeofgi3t2prane62mxnlhijqlmgo7mszekfuf4uti46sdb3e4c6mihwwrdq` |

**⚠️ Pendente:** Conectar Firebase (FCM v1) ao OneSignal:
1. Firebase Console → Projeto **People** → Configurações → **Contas de serviço** → **Gerar nova chave privada** → baixar `.json`
2. OneSignal → Settings → Platforms → **Google Android (FCM)** → selecionar **FCM v1** → upload do `.json`
3. Verificar se o app Flutter tem o `google-services.json` do projeto People incluído

---

## Como o Targeting Individual Funciona

O OneSignal identifica cada usuário pelo `external_id`. O app Flutter já faz:

```dart
// Login (login_screen.dart:69 e main.dart:238)
PushNotificationService.login(colaboradorId: ..., email: ..., nome: ...);
// → internamente chama OneSignal.login(colaboradorId.toString())

// Logout (home_screen.dart)
PushNotificationService.logout();
// → internamente chama OneSignal.logout()
```

A API envia push usando:
```typescript
payload.include_aliases = { external_id: [String(colaboradorId)] }
```

O `external_id` é sempre `String(colaboradorId)` — o ID numérico do colaborador na tabela `people.colaboradores`.

---

## Arquivos Criados/Modificados na API

### Novo: `src/lib/push-colaborador.ts`
Helper para enviar push para um ou múltiplos colaboradores:
```typescript
enviarPushParaColaborador(colaboradorId, { titulo, mensagem, severidade, data, url })
enviarPushParaColaboradores(colaboradorIds[], { ... })
```
Severidades: `'critico'` (vermelho) | `'atencao'` (laranja) | `'info'` (azul)

### Modificado: `src/lib/notificacoes.ts`
Adicionada `criarNotificacaoComPush()` — salva no banco + dispara push simultaneamente.
**Usar sempre esta função** ao invés de `criarNotificacao` quando quiser push.

```typescript
criarNotificacaoComPush({
  usuarioId: colaboradorId,
  tipo: 'solicitacao',
  titulo: '...',
  mensagem: '...',
  link: '/rota-no-app',
  metadados: { acao: 'identificador', ... },
  pushSeveridade: 'info', // 'critico' | 'atencao' | 'info'
})
```

---

## Notificações Implementadas

| Evento | Arquivo | Quem recebe | Severidade |
|---|---|---|---|
| Solicitação aprovada (todos os tipos) | `aprovar-solicitacao/[id]` | Solicitante | info |
| Solicitação rejeitada (todos os tipos) | `rejeitar-solicitacao/[id]` | Solicitante | atencao |
| Atraso registrado — justifique | `notificacoes.ts` | Colaborador | atencao |
| Banco de horas ajustado | `criar-ajuste-horas` | Colaborador | info/atencao |
| Ponto bloqueado (assiduidade) | `assiduidade/bloquear-colaborador` | Colaborador | critico |
| Ponto desbloqueado | `assiduidade/bloquear-colaborador` | Colaborador | info |
| Nova pendência (prioridade proporcional) | `criar-pendencia` | Destinatário | critico/atencao/info |
| Pendência resolvida/encerrada | `resolver-pendencia/[id]` | Quem criou | info |
| Reunião agendada | `agendar-reuniao` | Participantes convidados | info |
| Marcação manual criada pelo gestor | `criar-marcacao` | Colaborador | info |
| Férias designadas pelo gestor | `designar-ferias` | Colaborador | info |
| Relatório de ponto disponível para assinatura | `relatorio-mensal/[id]` | Colaborador | info |
| Novo documento adicionado | `colaboradores/[id]/documentos` | Colaborador | info |
| Futebol hoje (sessão do dia) | `alertas-periodicos.ts` | Inscritos na sessão | atencao |

---

## Notificação de Esportes (periódica)

Em `src/lib/alertas-periodicos.ts`, função `notificarEsportesHoje()`:
- Roda a cada 30 min junto com o ciclo de alertas
- Só dispara **entre 07h e 10h** (horário de São Paulo)
- Envia uma vez por dia (cache Redis por 24h)
- Notifica todos os inscritos na sessão do dia em lote

---

## Escalabilidade — Preferências por Usuário

Migration criada em `database/migrations/002_parametros_notificacoes.sql`:

```sql
CREATE TABLE people.parametros_notificacoes (
  colaborador_id INTEGER REFERENCES people.colaboradores(id),
  tipo VARCHAR(60),  -- ex: 'solicitacao_aprovada', 'esportes_hoje', etc.
  ativo BOOLEAN DEFAULT true,
  UNIQUE(colaborador_id, tipo)
);
```

**Tipos definidos:** `solicitacao_aprovada`, `solicitacao_rejeitada`, `atraso_registrado`, `esportes_hoje`, `relatorio_disponivel`

Default: sem linha na tabela = notificação **ativa**. Para desativar, inserir com `ativo = false`.

A migration **ainda não foi executada no banco de produção** — só criar quando for implementar a tela de preferências no app.

---

## Variáveis de Ambiente necessárias (ECS)

```
ONESIGNAL_APP_ID=63ab3ecb-6061-41bd-85d9-5e781afc7270
ONESIGNAL_REST_API_KEY=os_v2_app_movt5s3amfa33bozlz4bv7dsoaxapcuks2iugnezgokjjeofgi3t2prane62mxnlhijqlmgo7mszekfuf4uti46sdb3e4c6mihwwrdq
```

Já adicionadas na **task definition v7** (atual em produção).

---

## Como Fazer Deploy

```bash
# 1. Build
docker build -t valeris-people-api .

# 2. Login ECR
aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin 873153257687.dkr.ecr.us-east-1.amazonaws.com

# 3. Tag e push
docker tag valeris-people-api:latest \
  873153257687.dkr.ecr.us-east-1.amazonaws.com/valeris-people-api:latest
docker push 873153257687.dkr.ecr.us-east-1.amazonaws.com/valeris-people-api:latest

# 4. Redeploy
aws ecs update-service \
  --cluster valeris-people \
  --service valeris-people-api \
  --force-new-deployment \
  --region us-east-1
```

---

## Verificar Logs em Produção

```bash
# Tail em tempo real (filtrado para push/notificações)
aws logs tail /ecs/valeris-people-api --follow --region us-east-1 \
  --log-stream-name-prefix "api/" | grep -i "push\|notif"
```

Mensagens esperadas:
- `[Push] Enviado para 1 colaborador(es) [123]: Título` → sucesso
- `[Push] ONESIGNAL_APP_ID ou ONESIGNAL_REST_API_KEY não configurados` → vars faltando
- `[Push] Erro 400: ...` → problema na requisição ao OneSignal

---

## Histórico de Problemas

| Problema | Causa | Solução |
|---|---|---|
| Push não enviado | `ONESIGNAL_APP_ID` e `ONESIGNAL_REST_API_KEY` não estavam no ECS | Adicionadas na task def v6 |
| Conta OneSignal antiga com problemas | Configuração possivelmente errada da conta anterior | Criada nova conta e novo app (task def v7) |
| FCM não configurado no OneSignal | OneSignal precisa de Service Account JSON do Firebase (FCM v1) | **Pendente** — baixar JSON da conta de serviço Firebase e fazer upload no OneSignal |
