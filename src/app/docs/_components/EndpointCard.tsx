'use client';

import { useState } from 'react';
import { EndpointSpec, FieldSpec } from '@/lib/api-spec';

const styles = `
  .endpoint-card { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; margin-bottom: 16px; }
  .endpoint-header { width: 100%; padding: 16px 24px; display: flex; align-items: center; justify-content: space-between; cursor: pointer; border: none; background: none; text-align: left; transition: background 0.2s; }
  .endpoint-header:hover { background: #f8fafc; }
  .endpoint-left { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
  .endpoint-right { display: flex; align-items: center; gap: 16px; }
  .endpoint-summary { font-size: 0.875rem; color: #64748b; }
  .endpoint-chevron { width: 20px; height: 20px; color: #94a3b8; transition: transform 0.2s; }
  .endpoint-chevron.open { transform: rotate(180deg); }
  
  .method-badge { padding: 6px 12px; border-radius: 6px; font-size: 0.75rem; font-weight: 700; font-family: monospace; }
  .method-get { background: #dcfce7; color: #166534; }
  .method-post { background: #dbeafe; color: #1e40af; }
  .method-put { background: #fef9c3; color: #854d0e; }
  .method-patch { background: #ffedd5; color: #c2410c; }
  .method-delete { background: #fee2e2; color: #991b1b; }
  
  .auth-badge { padding: 4px 10px; border-radius: 6px; font-size: 0.75rem; font-weight: 500; }
  .auth-jwt { background: #f3e8ff; color: #7c3aed; }
  .auth-api_key { background: #cffafe; color: #0891b2; }
  .auth-both { background: #e0e7ff; color: #4f46e5; }
  .auth-none { background: #f1f5f9; color: #64748b; }
  
  .endpoint-path { font-family: monospace; font-size: 0.875rem; color: #334155; }
  
  .endpoint-body { border-top: 1px solid #e2e8f0; }
  .endpoint-desc { padding: 16px 24px; background: #f8fafc; font-size: 0.875rem; color: #64748b; }
  
  .tabs { display: flex; border-bottom: 1px solid #e2e8f0; padding: 0 24px; }
  .tab { padding: 12px 16px; font-size: 0.875rem; font-weight: 500; color: #64748b; border: none; background: none; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px; transition: all 0.2s; }
  .tab:hover { color: #334155; }
  .tab.active { color: #2563eb; border-bottom-color: #2563eb; }
  
  .tab-content { padding: 24px; }
  
  .section-title { font-size: 0.875rem; font-weight: 600; color: #0f172a; margin-bottom: 12px; }
  .section-title.success { color: #16a34a; }
  .section-title.error { color: #dc2626; }
  
  .params-table { background: #f8fafc; border-radius: 8px; overflow: hidden; margin-bottom: 24px; }
  .params-table table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
  .params-table th { padding: 10px 16px; text-align: left; font-weight: 500; color: #64748b; border-bottom: 1px solid #e2e8f0; }
  .params-table td { padding: 10px 16px; border-bottom: 1px solid #e2e8f0; }
  .params-table tr:last-child td { border-bottom: none; }
  .param-name { font-family: monospace; color: #0f172a; }
  .param-required { color: #dc2626; margin-left: 4px; }
  .param-type { display: inline-block; background: #e2e8f0; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; }
  .param-enum { font-size: 0.75rem; color: #64748b; margin-top: 4px; }
  .param-desc { color: #64748b; }
  
  .code-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
  .code-label { font-size: 0.75rem; font-weight: 500; color: #64748b; }
  .copy-btn { font-size: 0.75rem; color: #2563eb; background: none; border: none; cursor: pointer; padding: 4px 8px; border-radius: 4px; }
  .copy-btn:hover { background: #eff6ff; }
  
  .code-block { background: #1e293b; border-radius: 8px; padding: 16px; overflow-x: auto; margin-bottom: 24px; }
  .code-block pre { margin: 0; font-family: monospace; font-size: 0.875rem; white-space: pre-wrap; word-break: break-word; }
  .code-block.success pre { color: #4ade80; }
  .code-block.curl pre { color: #cbd5e1; }
  
  .error-list { display: flex; flex-direction: column; gap: 8px; }
  .error-item { display: flex; align-items: flex-start; gap: 12px; padding: 12px; background: #fef2f2; border-radius: 8px; }
  .error-status { padding: 4px 8px; background: #fee2e2; color: #991b1b; font-size: 0.75rem; font-family: monospace; border-radius: 4px; }
  .error-code { font-family: monospace; color: #dc2626; font-size: 0.875rem; }
  .error-msg { font-size: 0.875rem; color: #64748b; }
  
  .tutorial-content { font-size: 0.875rem; color: #334155; white-space: pre-wrap; font-family: inherit; line-height: 1.6; }
`;

const methodClasses: Record<string, string> = {
  GET: 'method-get', POST: 'method-post', PUT: 'method-put',
  PATCH: 'method-patch', DELETE: 'method-delete',
};

const authLabels: Record<string, { label: string; className: string }> = {
  jwt: { label: 'JWT', className: 'auth-jwt' },
  api_key: { label: 'API Key', className: 'auth-api_key' },
  both: { label: 'JWT / API Key', className: 'auth-both' },
  none: { label: 'Público', className: 'auth-none' },
};

export function EndpointCard({ endpoint }: { endpoint: EndpointSpec }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState<'request' | 'response' | 'tutorial'>('request');
  const [copied, setCopied] = useState(false);

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const generateCurl = () => {
    let curl = `curl -X ${endpoint.method} "${endpoint.path}"`;
    if (endpoint.auth === 'jwt') {
      curl += ` \\\n  -H "Authorization: Bearer SEU_TOKEN_JWT"`;
    } else if (endpoint.auth === 'api_key') {
      curl += ` \\\n  -H "Authorization: Bearer SUA_API_KEY"`;
    } else if (endpoint.auth === 'both') {
      curl += ` \\\n  -H "Authorization: Bearer SEU_TOKEN_JWT_OU_API_KEY"`;
    }
    if (endpoint.requestBody) {
      curl += ` \\\n  -H "Content-Type: application/json"`;
      curl += ` \\\n  -d '${JSON.stringify(endpoint.requestBody.example, null, 2)}'`;
    }
    return curl;
  };

  return (
    <>
      <style>{styles}</style>
      <div className="endpoint-card">
        <button className="endpoint-header" onClick={() => setIsExpanded(!isExpanded)}>
          <div className="endpoint-left">
            <span className={`method-badge ${methodClasses[endpoint.method]}`}>{endpoint.method}</span>
            <code className="endpoint-path">{endpoint.path}</code>
            <span className={`auth-badge ${authLabels[endpoint.auth].className}`}>{authLabels[endpoint.auth].label}</span>
          </div>
          <div className="endpoint-right">
            <span className="endpoint-summary">{endpoint.summary}</span>
            <svg className={`endpoint-chevron ${isExpanded ? 'open' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </div>
        </button>

        {isExpanded && (
          <div className="endpoint-body">
            {endpoint.description && (
              <div className="endpoint-desc">{endpoint.description}</div>
            )}

            <div className="tabs">
              <button className={`tab ${activeTab === 'request' ? 'active' : ''}`} onClick={() => setActiveTab('request')}>Request</button>
              <button className={`tab ${activeTab === 'response' ? 'active' : ''}`} onClick={() => setActiveTab('response')}>Response</button>
              {endpoint.tutorial && (
                <button className={`tab ${activeTab === 'tutorial' ? 'active' : ''}`} onClick={() => setActiveTab('tutorial')}>Tutorial</button>
              )}
            </div>

            <div className="tab-content">
              {activeTab === 'request' && (
                <div>
                  {endpoint.pathParams && Object.keys(endpoint.pathParams).length > 0 && (
                    <div>
                      <h4 className="section-title">Path Parameters</h4>
                      <ParamsTable params={endpoint.pathParams} />
                    </div>
                  )}

                  {endpoint.queryParams && Object.keys(endpoint.queryParams).length > 0 && (
                    <div>
                      <h4 className="section-title">Query Parameters</h4>
                      <ParamsTable params={endpoint.queryParams} />
                    </div>
                  )}

                  {endpoint.requestBody && (
                    <div>
                      <h4 className="section-title">
                        Request Body {endpoint.requestBody.required && <span style={{ color: '#dc2626' }}>*</span>}
                      </h4>
                      <ParamsTable params={endpoint.requestBody.schema} />
                      
                      <div className="code-header">
                        <span className="code-label">Exemplo</span>
                        <button className="copy-btn" onClick={() => copyToClipboard(JSON.stringify(endpoint.requestBody?.example, null, 2))}>
                          {copied ? 'Copiado!' : 'Copiar'}
                        </button>
                      </div>
                      <div className="code-block success">
                        <pre>{JSON.stringify(endpoint.requestBody.example, null, 2)}</pre>
                      </div>
                    </div>
                  )}

                  <div className="code-header">
                    <span className="code-label">cURL</span>
                    <button className="copy-btn" onClick={() => copyToClipboard(generateCurl())}>Copiar</button>
                  </div>
                  <div className="code-block curl">
                    <pre>{generateCurl()}</pre>
                  </div>
                </div>
              )}

              {activeTab === 'response' && (
                <div>
                  <h4 className="section-title success">
                    {endpoint.responses.success.status} - {endpoint.responses.success.description}
                  </h4>
                  <div className="code-block success">
                    <pre>{JSON.stringify(endpoint.responses.success.example, null, 2)}</pre>
                  </div>

                  {endpoint.responses.errors.length > 0 && (
                    <div>
                      <h4 className="section-title error">Possíveis Erros</h4>
                      <div className="error-list">
                        {endpoint.responses.errors.map((error, i) => (
                          <div key={i} className="error-item">
                            <span className="error-status">{error.status}</span>
                            <div>
                              <div className="error-code">{error.code}</div>
                              <div className="error-msg">{error.message}</div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'tutorial' && endpoint.tutorial && (
                <pre className="tutorial-content">{endpoint.tutorial}</pre>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function ParamsTable({ params }: { params: Record<string, FieldSpec> }) {
  return (
    <div className="params-table">
      <table>
        <thead>
          <tr>
            <th>Nome</th>
            <th>Tipo</th>
            <th>Descrição</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(params).map(([name, spec]) => (
            <tr key={name}>
              <td>
                <span className="param-name">{name}</span>
                {spec.required && <span className="param-required">*</span>}
              </td>
              <td>
                <span className="param-type">{spec.type}</span>
                {spec.enum && <div className="param-enum">{spec.enum.join(' | ')}</div>}
              </td>
              <td className="param-desc">{spec.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
