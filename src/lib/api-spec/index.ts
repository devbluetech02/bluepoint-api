export * from './types';

import { CategorySpec, EndpointSpec } from './types';
import { autenticacaoCategory } from './autenticacao';
import { colaboradoresCategory } from './colaboradores';
import { biometriaCategory } from './biometria';
import { marcacoesCategory } from './marcacoes';
import {
  jornadasCategory,
  departamentosCategory,
  cargosCategory,
  empresasCategory,
  feriadosCategory,
  localizacoesCategory,
  solicitacoesCategory,
  notificacoesCategory,
  anexosCategory,
  dispositivosCategory,
  relatoriosCategory,
  configuracoesCategory,
  appsCategory,
  healthCategory,
} from './outros';

// Todas as categorias da API
export const API_CATEGORIES: CategorySpec[] = [
  autenticacaoCategory,
  colaboradoresCategory,
  biometriaCategory,
  marcacoesCategory,
  jornadasCategory,
  departamentosCategory,
  cargosCategory,
  empresasCategory,
  feriadosCategory,
  localizacoesCategory,
  solicitacoesCategory,
  notificacoesCategory,
  anexosCategory,
  dispositivosCategory,
  relatoriosCategory,
  configuracoesCategory,
  appsCategory,
  healthCategory,
];

// Helpers
export function getAllEndpoints(): EndpointSpec[] {
  return API_CATEGORIES.flatMap(cat => cat.endpoints);
}

export function getEndpointById(id: string): EndpointSpec | undefined {
  return getAllEndpoints().find(e => e.id === id);
}

export function getCategoryById(id: string): CategorySpec | undefined {
  return API_CATEGORIES.find(c => c.id === id);
}

export function searchEndpoints(query: string): EndpointSpec[] {
  const q = query.toLowerCase();
  return getAllEndpoints().filter(e =>
    e.summary.toLowerCase().includes(q) ||
    e.path.toLowerCase().includes(q) ||
    e.description?.toLowerCase().includes(q) ||
    e.tags.some(t => t.toLowerCase().includes(q))
  );
}

export const API_BASE_URL = '/api/v1';
export const API_VERSION = '1.3.0';

// Estatísticas
export function getApiStats() {
  const endpoints = getAllEndpoints();
  return {
    totalCategories: API_CATEGORIES.length,
    totalEndpoints: endpoints.length,
    byMethod: {
      GET: endpoints.filter(e => e.method === 'GET').length,
      POST: endpoints.filter(e => e.method === 'POST').length,
      PUT: endpoints.filter(e => e.method === 'PUT').length,
      PATCH: endpoints.filter(e => e.method === 'PATCH').length,
      DELETE: endpoints.filter(e => e.method === 'DELETE').length,
    },
    byAuth: {
      jwt: endpoints.filter(e => e.auth === 'jwt').length,
      api_key: endpoints.filter(e => e.auth === 'api_key').length,
      both: endpoints.filter(e => e.auth === 'both').length,
      none: endpoints.filter(e => e.auth === 'none').length,
    },
  };
}
