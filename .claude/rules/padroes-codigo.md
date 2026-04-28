# Padrões de código — People API

## Respostas HTTP
- Use os helpers em `src/lib/api-response.ts`: `successResponse`, `errorResponse`, `forbiddenResponse`, `serverErrorResponse`, `validationErrorResponse`, `createdResponse`.

## Autenticação / Autorização
- Middleware base: `src/lib/middleware.ts`
- `withAuth(req, handler)` — só valida JWT/API Key
- `withAdmin(req, handler)` — exige `tipo='admin'`
- `withGestor(req, handler)` — exige tipo em `TIPOS_GESTAO` (gestor, gerente, supervisor, coordenador, admin)
- `withAdmissao(req, handler)` — gestores + admin + tokens provisórios
- `withPermission(req, codigo, handler)` — checa código granular em `tipo_usuario_permissoes`
- `withApiAuth(req, handler, options?)` — variante com contexto completo (JWT vs API Key)

## Validação
- Schemas Zod em `src/lib/validation.ts` — usar `validateBody(schema, body)`.

## Banco
- Helper em `src/lib/db.ts` — `query(sql, params)` e `getClient()` (para transações).
- Schema do Postgres é `people` — sempre prefixar tabelas com `people.<tabela>`.

## Cache
- `src/lib/cache.ts` — `cacheAside`, `cacheDelPattern`, `CACHE_KEYS`, `CACHE_TTL`.

## Auditoria
- `registrarAuditoria` em `src/lib/audit.ts` — não passar `colaboradorId` para usuários provisórios (não existem na tabela `colaboradores`).
- Usar `getClientIp(request)` e `getUserAgent(request)` para metadados.

## Push notifications
- `src/lib/push-colaborador.ts` (para `colaboradores`)
- `src/lib/push-provisorio.ts` (para `usuarios_provisorios`)

## Embeddings (pgvector)
- Após inserir registro em tabela com coluna `embedding`, chamar `embedTableRowAfterInsert('<tabela>', id)` de `src/lib/embeddings.ts`.

## Usuários provisórios
- JWT com `tipo: 'provisorio'`, expiração de 8h, sem refresh token.
- Não interagem com hierarquia/permissões — fluxo separado para admissão.
