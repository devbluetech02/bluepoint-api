'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { getCategoryById } from '@/lib/api-spec';
import { EndpointCard } from '../_components/EndpointCard';
import { getIcon } from '../_components/Icons';

const styles = `
  .breadcrumb { display: flex; align-items: center; gap: 8px; font-size: 0.875rem; color: #64748b; margin-bottom: 16px; }
  .breadcrumb a { color: #64748b; text-decoration: none; }
  .breadcrumb a:hover { color: #2563eb; }
  .breadcrumb span { color: #0f172a; }
  
  .cat-header { display: flex; align-items: center; gap: 16px; margin-bottom: 16px; }
  .cat-icon { color: #2563eb; }
  .cat-info h1 { font-size: 1.875rem; font-weight: bold; color: #0f172a; margin: 0 0 4px 0; }
  .cat-info p { color: #64748b; margin: 0; }
  
  .cat-badge { display: inline-block; padding: 6px 12px; background: #f1f5f9; border-radius: 9999px; font-size: 0.875rem; color: #475569; margin-bottom: 32px; }
  
  .endpoints-list { display: flex; flex-direction: column; gap: 16px; }
  
  .not-found { text-align: center; padding: 48px; }
  .not-found h1 { font-size: 1.5rem; font-weight: bold; color: #0f172a; margin-bottom: 16px; }
  .not-found a { color: #2563eb; text-decoration: none; }
  .not-found a:hover { text-decoration: underline; }
`;

export default function CategoryPage() {
  const params = useParams();
  const categoryId = params.categoria as string;
  const category = getCategoryById(categoryId);

  if (!category) {
    return (
      <>
        <style>{styles}</style>
        <div className="not-found">
          <h1>Categoria não encontrada</h1>
          <Link href="/docs">Voltar para a documentação</Link>
        </div>
      </>
    );
  }

  const IconComponent = getIcon(category.icon);

  return (
    <>
      <style>{styles}</style>
      <div>
        <div className="breadcrumb">
          <Link href="/docs">Docs</Link>
          <span>/</span>
          <span>{category.name}</span>
        </div>

        <div className="cat-header">
          <span className="cat-icon"><IconComponent /></span>
          <div className="cat-info">
            <h1>{category.name}</h1>
            <p>{category.description}</p>
          </div>
        </div>

        <span className="cat-badge">{category.endpoints.length} endpoints</span>

        <div className="endpoints-list">
          {category.endpoints.map((endpoint) => (
            <EndpointCard key={endpoint.id} endpoint={endpoint} />
          ))}
        </div>
      </div>
    </>
  );
}
