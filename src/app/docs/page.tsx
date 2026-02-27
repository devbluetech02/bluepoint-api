import Link from 'next/link';
import { API_CATEGORIES, getApiStats, API_VERSION } from '@/lib/api-spec';
import { getIcon, Icons } from './_components/Icons';

export default function DocsPage() {
  const stats = getApiStats();

  return (
    <div>
      <style>{`
        .intro { margin-bottom: 48px; }
        .intro h1 { font-size: 2.25rem; font-weight: bold; color: #0f172a; margin-bottom: 16px; }
        .intro p { font-size: 1.125rem; color: #64748b; margin-bottom: 24px; }
        .badges { display: flex; flex-wrap: wrap; gap: 12px; }
        .badge { padding: 6px 16px; border-radius: 9999px; font-size: 0.875rem; font-weight: 500; }
        .badge-blue { background: #dbeafe; color: #1e40af; }
        .badge-green { background: #dcfce7; color: #166534; }
        .badge-purple { background: #f3e8ff; color: #6b21a8; }
        
        .section { margin-bottom: 48px; }
        .section h2 { font-size: 1.5rem; font-weight: bold; color: #0f172a; margin-bottom: 16px; }
        
        .code-block { background: #1e293b; border-radius: 12px; padding: 24px; overflow-x: auto; margin-bottom: 24px; }
        .code-block pre { color: #4ade80; font-family: 'Monaco', 'Consolas', monospace; font-size: 0.875rem; margin: 0; white-space: pre-wrap; }
        .code-comment { color: #64748b; display: block; margin-bottom: 4px; }
        
        .auth-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; }
        @media (max-width: 768px) { .auth-grid { grid-template-columns: 1fr; } }
        .auth-card { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 24px; }
        .auth-header { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
        .auth-icon { color: #2563eb; }
        .auth-title { font-weight: 600; color: #0f172a; }
        .auth-desc { font-size: 0.875rem; color: #64748b; margin-bottom: 12px; }
        .auth-code { font-size: 0.75rem; background: #f1f5f9; padding: 8px 12px; border-radius: 6px; font-family: monospace; display: inline-block; }
        
        .cat-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
        @media (max-width: 1024px) { .cat-grid { grid-template-columns: repeat(2, 1fr); } }
        @media (max-width: 640px) { .cat-grid { grid-template-columns: 1fr; } }
        .cat-card { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 24px; transition: all 0.2s; display: block; }
        .cat-card:hover { border-color: #3b82f6; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.1); transform: translateY(-2px); }
        .cat-header { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
        .cat-icon { color: #2563eb; }
        .cat-info {}
        .cat-title { font-weight: 600; color: #0f172a; }
        .cat-count { font-size: 0.75rem; color: #64748b; }
        .cat-desc { font-size: 0.875rem; color: #64748b; }
        
        .resp-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; }
        @media (max-width: 768px) { .resp-grid { grid-template-columns: 1fr; } }
        .resp-title { font-weight: 600; margin-bottom: 8px; }
        .resp-title.success { color: #16a34a; }
        .resp-title.error { color: #dc2626; }
        .resp-code { background: #1e293b; border-radius: 8px; padding: 16px; }
        .resp-code pre { font-family: monospace; font-size: 0.875rem; margin: 0; }
        .resp-code.success pre { color: #4ade80; }
        .resp-code.error pre { color: #f87171; }
        
        .status-table { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; }
        .status-table table { width: 100%; border-collapse: collapse; }
        .status-table th { background: #f8fafc; padding: 12px 16px; text-align: left; font-weight: 600; }
        .status-table td { padding: 12px 16px; border-top: 1px solid #e2e8f0; }
        .status-code { font-family: monospace; font-weight: 600; }
        .status-code.green { color: #16a34a; }
        .status-code.yellow { color: #ca8a04; }
        .status-code.red { color: #dc2626; }
      `}</style>

      {/* Intro */}
      <div className="intro">
        <h1>Documentação da API BluePoint</h1>
        <p>API REST para gerenciamento de ponto eletrônico, biometria facial, colaboradores e mais.</p>
        <div className="badges">
          <span className="badge badge-blue">Versão {API_VERSION}</span>
          <span className="badge badge-green">{stats.totalEndpoints} Endpoints</span>
          <span className="badge badge-purple">{stats.totalCategories} Categorias</span>
        </div>
      </div>

      {/* Quick Start */}
      <div className="section">
        <h2>Início Rápido</h2>
        <div className="code-block">
          <pre>
            <span className="code-comment"># Autenticação</span>
{`curl -X POST /api/v1/autenticar \\
  -H "Content-Type: application/json" \\
  -d '{"email": "usuario@empresa.com", "senha": "senha123"}'`}
            {'\n\n'}
            <span className="code-comment"># Usando o token</span>
{`curl -X GET /api/v1/listar-colaboradores \\
  -H "Authorization: Bearer SEU_TOKEN_AQUI"`}
          </pre>
        </div>
      </div>

      {/* Auth */}
      <div className="section">
        <h2>Autenticação</h2>
        <p style={{ color: '#64748b', marginBottom: '16px' }}>
          Ambos os métodos usam o mesmo header <code>Authorization: Bearer</code>. O tipo de token é detectado automaticamente.
        </p>
        <div className="auth-grid">
          <div className="auth-card">
            <div className="auth-header">
              <span className="auth-icon"><Icons.Key /></span>
              <span className="auth-title">JWT Token</span>
            </div>
            <p className="auth-desc">Para usuários logados. Obtido via <code>/autenticar</code>. Expira conforme configuração.</p>
            <code className="auth-code">Authorization: Bearer eyJhbGciOi...</code>
          </div>
          <div className="auth-card">
            <div className="auth-header">
              <span className="auth-icon"><Icons.Link /></span>
              <span className="auth-title">API Key</span>
            </div>
            <p className="auth-desc">Para integrações e dispositivos. Não expira. Gerenciada via painel admin.</p>
            <code className="auth-code">Authorization: Bearer app_nome_chave...</code>
          </div>
        </div>
      </div>

      {/* Categories */}
      <div className="section">
        <h2>Categorias</h2>
        <div className="cat-grid">
          {API_CATEGORIES.map((category) => {
            const IconComponent = getIcon(category.icon);
            return (
              <Link key={category.id} href={`/docs/${category.id}`} className="cat-card">
                <div className="cat-header">
                  <span className="cat-icon"><IconComponent /></span>
                  <div className="cat-info">
                    <div className="cat-title">{category.name}</div>
                    <div className="cat-count">{category.endpoints.length} endpoints</div>
                  </div>
                </div>
                <p className="cat-desc">{category.description}</p>
              </Link>
            );
          })}
        </div>
      </div>

      {/* Response Format */}
      <div className="section">
        <h2>Formato de Resposta</h2>
        <div className="resp-grid">
          <div>
            <h3 className="resp-title success">Sucesso</h3>
            <div className="resp-code success">
              <pre>{`{
  "success": true,
  "data": {
    // dados da resposta
  }
}`}</pre>
            </div>
          </div>
          <div>
            <h3 className="resp-title error">Erro</h3>
            <div className="resp-code error">
              <pre>{`{
  "success": false,
  "error": "Mensagem de erro",
  "code": "ERROR_CODE"
}`}</pre>
            </div>
          </div>
        </div>
      </div>

      {/* HTTP Status */}
      <div className="section">
        <h2>Códigos HTTP</h2>
        <div className="status-table">
          <table>
            <thead>
              <tr>
                <th>Código</th>
                <th>Descrição</th>
              </tr>
            </thead>
            <tbody>
              <tr><td className="status-code green">200</td><td>OK - Requisição bem-sucedida</td></tr>
              <tr><td className="status-code green">201</td><td>Created - Recurso criado</td></tr>
              <tr><td className="status-code yellow">400</td><td>Bad Request - Erro de validação</td></tr>
              <tr><td className="status-code yellow">401</td><td>Unauthorized - Token inválido ou ausente</td></tr>
              <tr><td className="status-code yellow">403</td><td>Forbidden - Sem permissão</td></tr>
              <tr><td className="status-code yellow">404</td><td>Not Found - Recurso não encontrado</td></tr>
              <tr><td className="status-code red">500</td><td>Internal Server Error - Erro interno</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
