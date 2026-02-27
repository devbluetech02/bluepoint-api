import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  
  // Configuração vazia do Turbopack para silenciar o aviso
  turbopack: {},

  // Pacotes que não devem ser empacotados pelo bundler (usam fs, binários nativos, etc.)
  serverExternalPackages: ['pdfkit'],

  // Aumentar limite de body para uploads grandes
  experimental: {
    serverActions: {
      bodySizeLimit: '200mb',
    },
  },
};

export default nextConfig;
