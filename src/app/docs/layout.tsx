'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { API_CATEGORIES, getApiStats } from '@/lib/api-spec';
import { Icons, getIcon } from './_components/Icons';

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const pathname = usePathname();
  const stats = getApiStats();

  const filteredCategories = API_CATEGORIES.filter(cat =>
    searchQuery === '' ||
    cat.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    cat.endpoints.some(e => 
      e.summary.toLowerCase().includes(searchQuery.toLowerCase()) ||
      e.path.toLowerCase().includes(searchQuery.toLowerCase())
    )
  );

  return (
    <html lang="pt-BR">
      <head>
        <title>API BluePoint - Documentação</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <style>{`
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8fafc; color: #1e293b; line-height: 1.5; }
          a { color: inherit; text-decoration: none; }
          code { font-family: 'Monaco', 'Consolas', monospace; background: #f1f5f9; padding: 2px 6px; border-radius: 4px; font-size: 0.875em; }
          pre { font-family: 'Monaco', 'Consolas', monospace; }
          
          .header { position: fixed; top: 0; left: 0; right: 0; z-index: 50; background: #fff; border-bottom: 1px solid #e2e8f0; height: 64px; display: flex; align-items: center; padding: 0 16px; }
          .header-content { display: flex; align-items: center; justify-content: space-between; width: 100%; }
          .header-left { display: flex; align-items: center; gap: 16px; }
          .menu-btn { padding: 8px; border: none; background: none; cursor: pointer; border-radius: 8px; display: flex; align-items: center; justify-content: center; }
          .menu-btn:hover { background: #f1f5f9; }
          .logo { display: flex; align-items: center; gap: 12px; font-weight: bold; font-size: 1.25rem; }
          .logo-icon { color: #2563eb; }
          .logo-badge { font-size: 0.75rem; color: #64748b; font-weight: normal; background: #f1f5f9; padding: 4px 8px; border-radius: 4px; }
          .search-box { position: relative; }
          .search-input { width: 256px; padding: 8px 16px 8px 40px; border: 1px solid #e2e8f0; border-radius: 8px; font-size: 0.875rem; background: #f8fafc; }
          .search-input:focus { outline: none; border-color: #3b82f6; box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1); }
          .search-icon { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: #94a3b8; }
          
          .container { display: flex; padding-top: 64px; }
          
          .sidebar { position: fixed; left: 0; top: 64px; bottom: 0; width: 280px; background: #fff; border-right: 1px solid #e2e8f0; overflow-y: auto; transition: transform 0.3s; padding: 16px; }
          .sidebar.closed { transform: translateX(-100%); }
          .sidebar-title { font-size: 0.75rem; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; padding: 8px 16px; margin-top: 16px; }
          .nav-link { display: flex; align-items: center; justify-content: space-between; padding: 10px 16px; border-radius: 8px; margin-bottom: 4px; transition: all 0.2s; }
          .nav-link:hover { background: #f1f5f9; }
          .nav-link.active { background: #eff6ff; color: #2563eb; }
          .nav-link-left { display: flex; align-items: center; gap: 12px; }
          .nav-link-icon { display: flex; align-items: center; justify-content: center; width: 20px; height: 20px; color: #64748b; }
          .nav-link.active .nav-link-icon { color: #2563eb; }
          .nav-link-text { font-size: 0.875rem; font-weight: 500; }
          .nav-link-badge { font-size: 0.75rem; background: #f1f5f9; padding: 2px 8px; border-radius: 9999px; color: #64748b; }
          
          .stats-box { padding: 16px; border-top: 1px solid #e2e8f0; margin-top: 16px; }
          .stats-title { font-size: 0.75rem; font-weight: 600; color: #64748b; text-transform: uppercase; margin-bottom: 8px; }
          .stats-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
          .stat-item { padding: 8px; border-radius: 6px; font-size: 0.75rem; }
          .stat-get { background: #dcfce7; color: #166534; }
          .stat-post { background: #dbeafe; color: #1e40af; }
          .stat-put { background: #fef9c3; color: #854d0e; }
          .stat-del { background: #fee2e2; color: #991b1b; }
          
          .main { flex: 1; margin-left: 280px; transition: margin 0.3s; }
          .main.full { margin-left: 0; }
          .main-content { max-width: 1024px; margin: 0 auto; padding: 32px; }
          
          h1 { font-size: 2.25rem; font-weight: bold; color: #0f172a; margin-bottom: 16px; }
          h2 { font-size: 1.5rem; font-weight: bold; color: #0f172a; margin-bottom: 16px; margin-top: 32px; }
          h3 { font-size: 1.125rem; font-weight: 600; color: #0f172a; margin-bottom: 8px; }
          p { color: #475569; margin-bottom: 16px; }
        `}</style>
      </head>
      <body>
        {/* Header */}
        <header className="header">
          <div className="header-content">
            <div className="header-left">
              <button className="menu-btn" onClick={() => setSidebarOpen(!sidebarOpen)}>
                <Icons.Menu />
              </button>
              <Link href="/docs" className="logo">
                <span className="logo-icon"><Icons.Book /></span>
                <span>API BluePoint</span>
                <span className="logo-badge">{stats.totalEndpoints} endpoints</span>
              </Link>
            </div>
            <div className="search-box">
              <span className="search-icon"><Icons.Search /></span>
              <input
                type="text"
                placeholder="Buscar endpoint..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="search-input"
              />
            </div>
          </div>
        </header>

        <div className="container">
          {/* Sidebar */}
          <aside className={`sidebar ${sidebarOpen ? '' : 'closed'}`}>
            <Link href="/docs" className={`nav-link ${pathname === '/docs' ? 'active' : ''}`}>
              <div className="nav-link-left">
                <span className="nav-link-icon"><Icons.Home /></span>
                <span className="nav-link-text">Visão Geral</span>
              </div>
            </Link>

            <div className="sidebar-title">Ferramentas</div>

            <Link href="/docs/cadastrar-biometria" className={`nav-link ${pathname === '/docs/cadastrar-biometria' ? 'active' : ''}`}>
              <div className="nav-link-left">
                <span className="nav-link-icon"><Icons.Scan /></span>
                <span className="nav-link-text">Cadastrar Biometria</span>
              </div>
            </Link>

            <div className="sidebar-title">Categorias</div>

            {filteredCategories.map((category) => {
              const IconComponent = getIcon(category.icon);
              return (
                <Link
                  key={category.id}
                  href={`/docs/${category.id}`}
                  className={`nav-link ${pathname === `/docs/${category.id}` ? 'active' : ''}`}
                >
                  <div className="nav-link-left">
                    <span className="nav-link-icon"><IconComponent /></span>
                    <span className="nav-link-text">{category.name}</span>
                  </div>
                  <span className="nav-link-badge">{category.endpoints.length}</span>
                </Link>
              );
            })}

            <div className="stats-box">
              <div className="stats-title">Estatísticas</div>
              <div className="stats-grid">
                <div className="stat-item stat-get"><strong>{stats.byMethod.GET}</strong> GET</div>
                <div className="stat-item stat-post"><strong>{stats.byMethod.POST}</strong> POST</div>
                <div className="stat-item stat-put"><strong>{stats.byMethod.PUT}</strong> PUT</div>
                <div className="stat-item stat-del"><strong>{stats.byMethod.DELETE}</strong> DEL</div>
              </div>
            </div>
          </aside>

          {/* Main */}
          <main className={`main ${sidebarOpen ? '' : 'full'}`}>
            <div className="main-content">
              {children}
            </div>
          </main>
        </div>
      </body>
    </html>
  );
}
