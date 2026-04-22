'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { API_CATEGORIES, getApiStats } from '@/lib/api-spec';
import { Icons, getIcon } from './Icons';

export default function DocsShell({ children }: { children: React.ReactNode }) {
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
    <>
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
    </>
  );
}
