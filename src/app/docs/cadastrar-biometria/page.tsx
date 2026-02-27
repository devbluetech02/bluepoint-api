'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { Icons } from '../_components/Icons';

// Prefixos disponíveis para escolha
const PREFIXOS_DISPONIVEIS = [
  { value: 'portal', label: 'Portal' },
  { value: 'vendas', label: 'Vendas' },
  { value: 'rh', label: 'RH' },
  { value: 'app', label: 'App' },
  { value: 'totem', label: 'Totem' },
  { value: 'custom', label: 'Personalizado...' },
];

type CaptureMode = 'camera' | 'upload';
type Status = 'idle' | 'capturing' | 'processing' | 'success' | 'error';

interface QualidadeDetalhada {
  scoreDeteccao: number;
  tamanhoFace: number;
  proporcaoFace: number;
  centralizacao: number;
}

interface CadastroResponse {
  success: boolean;
  data?: {
    colaboradorId: number | null;
    externalIds: Record<string, string>;
    qualidade: number;
    qualidadeDetalhada?: QualidadeDetalhada;
    fotoReferencia: string | null;
    operacao: 'insert' | 'update' | 'merge';
    mensagem: string;
    processedIn: number;
  };
  error?: string;
  code?: string;
  dicas?: string[];
  qualidade?: number;
  qualidadeDetalhada?: QualidadeDetalhada;
}

export default function CadastrarBiometriaPage() {
  // Estado do formulário
  const [prefixo, setPrefixo] = useState<string>('portal');
  const [prefixoCustom, setPrefixoCustom] = useState<string>('');
  const [idExterno, setIdExterno] = useState<string>('');
  const [captureMode, setCaptureMode] = useState<CaptureMode>('camera');
  
  // Estado da câmera
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraLoading, setCameraLoading] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  
  // Estado da imagem capturada
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const [uploadedImage, setUploadedImage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  // Estado do processamento
  const [status, setStatus] = useState<Status>('idle');
  const [response, setResponse] = useState<CadastroResponse | null>(null);
  const [apiKey, setApiKey] = useState<string>('');

  // Limpar câmera ao desmontar
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
    };
  }, []);

  // Iniciar câmera
  const startCamera = useCallback(async () => {
    setCameraError(null);
    setCameraLoading(true);
    setCameraReady(false);
    setCameraActive(true); // Ativa primeiro para mostrar o elemento video
    
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'user',
          width: { ideal: 640 },
          height: { ideal: 480 },
        },
      });
      
      streamRef.current = stream;
      
      // Aguardar um tick para o elemento video ser renderizado
      setTimeout(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.onloadedmetadata = () => {
            videoRef.current?.play()
              .then(() => {
                setCameraLoading(false);
                setCameraReady(true);
              })
              .catch(err => {
                console.error('Erro ao iniciar vídeo:', err);
                setCameraLoading(false);
              });
          };
        }
      }, 100);
    } catch (err) {
      console.error('Erro ao acessar câmera:', err);
      setCameraActive(false);
      setCameraLoading(false);
      setCameraError('Não foi possível acessar a câmera. Verifique as permissões do navegador.');
    }
  }, []);

  // Parar câmera
  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setCameraActive(false);
    setCameraLoading(false);
    setCameraReady(false);
  }, []);

  // Capturar foto da câmera
  const capturePhoto = useCallback(() => {
    if (!videoRef.current || !canvasRef.current) return;
    
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    
    if (!ctx) return;
    
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0);
    
    const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
    setCapturedImage(dataUrl);
    setUploadedImage(null);
    stopCamera();
  }, [stopCamera]);

  // Upload de arquivo
  const handleFileUpload = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    
    if (!file.type.startsWith('image/')) {
      setResponse({ success: false, error: 'Por favor, selecione um arquivo de imagem.' });
      return;
    }
    
    const reader = new FileReader();
    reader.onload = (e) => {
      const result = e.target?.result as string;
      setUploadedImage(result);
      setCapturedImage(null);
      stopCamera();
    };
    reader.readAsDataURL(file);
  }, [stopCamera]);

  // Limpar imagem
  const clearImage = useCallback(() => {
    setCapturedImage(null);
    setUploadedImage(null);
    setResponse(null);
    setStatus('idle');
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, []);

  // Obter prefixo final
  const getPrefixoFinal = () => {
    if (prefixo === 'custom') {
      return prefixoCustom.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    }
    return prefixo;
  };

  // Validar formulário
  const isFormValid = () => {
    const prefixoFinal = getPrefixoFinal();
    const hasImage = capturedImage || uploadedImage;
    const hasId = idExterno.trim().length > 0;
    const hasPrefixo = prefixoFinal.length > 0;
    const hasApiKey = apiKey.trim().length > 0;
    
    return hasImage && hasId && hasPrefixo && hasApiKey;
  };

  // Enviar cadastro
  const handleSubmit = async () => {
    if (!isFormValid()) return;
    
    const prefixoFinal = getPrefixoFinal();
    const imagem = capturedImage || uploadedImage;
    const externalId = `${prefixoFinal}_${idExterno.trim()}`;
    
    setStatus('processing');
    setResponse(null);
    
    try {
      const res = await fetch('/api/v1/biometria/cadastrar-face', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey.trim()}`,
        },
        body: JSON.stringify({
          externalId,
          imagem,
        }),
      });
      
      const data: CadastroResponse = await res.json();
      setResponse(data);
      setStatus(data.success ? 'success' : 'error');
    } catch (err) {
      console.error('Erro ao cadastrar:', err);
      setResponse({
        success: false,
        error: 'Erro de conexão. Verifique sua internet e tente novamente.',
      });
      setStatus('error');
    }
  };

  // Obter cor da qualidade
  const getQualidadeColor = (qualidade: number) => {
    if (qualidade >= 0.85) return '#16a34a';
    if (qualidade >= 0.70) return '#65a30d';
    if (qualidade >= 0.50) return '#ca8a04';
    return '#dc2626';
  };

  // Obter texto da qualidade
  const getQualidadeTexto = (qualidade: number) => {
    if (qualidade >= 0.85) return 'Excelente';
    if (qualidade >= 0.70) return 'Boa';
    if (qualidade >= 0.50) return 'Aceitável';
    return 'Baixa';
  };

  const currentImage = capturedImage || uploadedImage;

  return (
    <div>
      <style>{`
        .page-header { margin-bottom: 32px; }
        .page-title { font-size: 2rem; font-weight: bold; color: #0f172a; margin-bottom: 8px; }
        .page-desc { color: #64748b; font-size: 1rem; }
        
        .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 24px; margin-bottom: 24px; }
        .card-title { font-size: 1.125rem; font-weight: 600; color: #0f172a; margin-bottom: 16px; display: flex; align-items: center; gap: 8px; }
        .card-icon { color: #2563eb; }
        
        .form-group { margin-bottom: 20px; }
        .form-label { display: block; font-size: 0.875rem; font-weight: 500; color: #374151; margin-bottom: 8px; }
        .form-hint { font-size: 0.75rem; color: #64748b; margin-top: 4px; }
        
        .form-input { width: 100%; padding: 10px 14px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 0.875rem; transition: all 0.2s; }
        .form-input:focus { outline: none; border-color: #3b82f6; box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1); }
        .form-input::placeholder { color: #9ca3af; }
        
        .form-select { width: 100%; padding: 10px 14px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 0.875rem; background: #fff; cursor: pointer; }
        .form-select:focus { outline: none; border-color: #3b82f6; box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1); }
        
        .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
        @media (max-width: 640px) { .form-row { grid-template-columns: 1fr; } }
        
        .mode-tabs { display: flex; gap: 8px; margin-bottom: 20px; }
        .mode-tab { flex: 1; padding: 12px 16px; border: 1px solid #e2e8f0; border-radius: 8px; background: #fff; cursor: pointer; font-size: 0.875rem; font-weight: 500; display: flex; align-items: center; justify-content: center; gap: 8px; transition: all 0.2s; }
        .mode-tab:hover { background: #f8fafc; }
        .mode-tab.active { background: #eff6ff; border-color: #3b82f6; color: #2563eb; }
        
        .camera-container { position: relative; background: #1e293b; border-radius: 12px; overflow: hidden; aspect-ratio: 4/3; display: flex; align-items: center; justify-content: center; min-height: 300px; }
        .camera-video { width: 100%; height: 100%; object-fit: cover; transform: scaleX(-1); position: absolute; top: 0; left: 0; }
        .camera-placeholder { color: #94a3b8; text-align: center; padding: 24px; display: flex; flex-direction: column; align-items: center; justify-content: center; }
        .camera-placeholder-icon { font-size: 48px; margin-bottom: 12px; color: #64748b; }
        
        .camera-error { background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 12px; color: #dc2626; font-size: 0.875rem; margin-bottom: 16px; }
        
        .preview-container { position: relative; border-radius: 12px; overflow: hidden; aspect-ratio: 4/3; background: #f1f5f9; }
        .preview-image { width: 100%; height: 100%; object-fit: cover; }
        .preview-overlay { position: absolute; top: 8px; right: 8px; }
        .preview-clear { padding: 8px; background: rgba(0,0,0,0.5); border: none; border-radius: 8px; cursor: pointer; color: #fff; display: flex; align-items: center; justify-content: center; }
        .preview-clear:hover { background: rgba(0,0,0,0.7); }
        
        .upload-zone { border: 2px dashed #d1d5db; border-radius: 12px; padding: 40px 24px; text-align: center; cursor: pointer; transition: all 0.2s; }
        .upload-zone:hover { border-color: #3b82f6; background: #f8fafc; }
        .upload-zone-icon { color: #64748b; margin-bottom: 12px; }
        .upload-zone-text { color: #64748b; font-size: 0.875rem; }
        .upload-zone-text strong { color: #2563eb; }
        
        .btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 12px 24px; border-radius: 8px; font-size: 0.875rem; font-weight: 500; cursor: pointer; transition: all 0.2s; border: none; }
        .btn:disabled { opacity: 0.5; cursor: not-allowed; }
        
        .btn-primary { background: #2563eb; color: #fff; }
        .btn-primary:hover:not(:disabled) { background: #1d4ed8; }
        
        .btn-secondary { background: #f1f5f9; color: #475569; border: 1px solid #e2e8f0; }
        .btn-secondary:hover:not(:disabled) { background: #e2e8f0; }
        
        .btn-danger { background: #ef4444; color: #fff; }
        .btn-danger:hover:not(:disabled) { background: #dc2626; }
        
        .btn-success { background: #16a34a; color: #fff; }
        .btn-success:hover:not(:disabled) { background: #15803d; }
        
        .btn-group { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 20px; }
        
        .result-card { border-radius: 12px; padding: 20px; margin-top: 24px; }
        .result-success { background: #f0fdf4; border: 1px solid #bbf7d0; }
        .result-error { background: #fef2f2; border: 1px solid #fecaca; }
        
        .result-header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
        .result-icon { font-size: 24px; }
        .result-title { font-weight: 600; font-size: 1rem; }
        .result-success .result-icon { color: #16a34a; }
        .result-success .result-title { color: #166534; }
        .result-error .result-icon { color: #dc2626; }
        .result-error .result-title { color: #991b1b; }
        
        .result-body { font-size: 0.875rem; }
        .result-success .result-body { color: #166534; }
        .result-error .result-body { color: #991b1b; }
        
        .result-details { margin-top: 16px; padding-top: 16px; border-top: 1px solid rgba(0,0,0,0.1); }
        .result-detail { display: flex; justify-content: space-between; padding: 6px 0; font-size: 0.875rem; }
        .result-detail-label { color: #64748b; }
        .result-detail-value { font-weight: 500; }
        
        .quality-bar { height: 8px; background: #e2e8f0; border-radius: 4px; overflow: hidden; margin-top: 4px; }
        .quality-fill { height: 100%; border-radius: 4px; transition: width 0.3s; }
        
        .external-ids { display: flex; flex-wrap: wrap; gap: 8px; }
        .external-id-tag { background: #eff6ff; color: #2563eb; padding: 4px 12px; border-radius: 9999px; font-size: 0.75rem; font-weight: 500; }
        
        .tips-list { list-style: none; padding: 0; margin: 12px 0 0 0; }
        .tips-list li { padding: 4px 0; padding-left: 20px; position: relative; font-size: 0.875rem; }
        .tips-list li::before { content: '💡'; position: absolute; left: 0; }
        
        .info-box { background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px; padding: 16px; margin-bottom: 24px; }
        .info-box-title { font-weight: 600; color: #1e40af; margin-bottom: 8px; display: flex; align-items: center; gap: 8px; }
        .info-box-text { font-size: 0.875rem; color: #1e40af; }
        
        .api-key-input { font-family: monospace; }
        
        canvas { display: none; }
        
        .loading-spinner { display: inline-block; width: 20px; height: 20px; border: 2px solid #fff; border-radius: 50%; border-top-color: transparent; animation: spin 0.8s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>

      <div className="page-header">
        <h1 className="page-title">Cadastrar Biometria Facial</h1>
        <p className="page-desc">
          Cadastre a biometria facial de um usuário externo. Escolha o prefixo do sistema, 
          informe o ID e capture ou faça upload de uma foto.
        </p>
      </div>

      {/* Info Box */}
      <div className="info-box">
        <div className="info-box-title">
          <Icons.AlertCircle />
          Como funciona
        </div>
        <div className="info-box-text">
          O <strong>ID Externo</strong> é formado por <code>prefixo_id</code>. Por exemplo: 
          se você escolher o prefixo "portal" e informar o ID "918", o externalId será <code>portal_918</code>. 
          Uma mesma face pode ter múltiplos IDs externos de sistemas diferentes.
        </div>
      </div>

      {/* Formulário de Configuração */}
      <div className="card">
        <h2 className="card-title">
          <span className="card-icon"><Icons.Settings /></span>
          Configuração
        </h2>

        {/* API Key */}
        <div className="form-group">
          <label className="form-label">API Key / Token de Autenticação *</label>
          <input
            type="password"
            className="form-input api-key-input"
            placeholder="bp_bio_xxxxxxxxxxxxxxxxxxxxxxxx"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <p className="form-hint">Token de autenticação para a API de biometria</p>
        </div>

        <div className="form-row">
          {/* Prefixo */}
          <div className="form-group">
            <label className="form-label">Prefixo do Sistema *</label>
            <select
              className="form-select"
              value={prefixo}
              onChange={(e) => setPrefixo(e.target.value)}
            >
              {PREFIXOS_DISPONIVEIS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
            <p className="form-hint">Sistema de origem do usuário</p>
          </div>

          {/* ID */}
          <div className="form-group">
            <label className="form-label">ID do Usuário *</label>
            <input
              type="text"
              className="form-input"
              placeholder="Ex: 918"
              value={idExterno}
              onChange={(e) => setIdExterno(e.target.value)}
            />
            <p className="form-hint">Identificador único no sistema</p>
          </div>
        </div>

        {/* Prefixo Personalizado */}
        {prefixo === 'custom' && (
          <div className="form-group">
            <label className="form-label">Prefixo Personalizado *</label>
            <input
              type="text"
              className="form-input"
              placeholder="Ex: meusistema"
              value={prefixoCustom}
              onChange={(e) => setPrefixoCustom(e.target.value)}
            />
            <p className="form-hint">Apenas letras minúsculas e números</p>
          </div>
        )}

        {/* Preview do External ID */}
        {idExterno && getPrefixoFinal() && (
          <div className="form-group">
            <label className="form-label">External ID Resultante</label>
            <div style={{ 
              background: '#f1f5f9', 
              padding: '12px 16px', 
              borderRadius: '8px', 
              fontFamily: 'monospace',
              fontSize: '1rem',
              color: '#0f172a'
            }}>
              {getPrefixoFinal()}_{idExterno.trim()}
            </div>
          </div>
        )}
      </div>

      {/* Captura de Foto */}
      <div className="card">
        <h2 className="card-title">
          <span className="card-icon"><Icons.Scan /></span>
          Captura da Face
        </h2>

        {/* Tabs de modo */}
        <div className="mode-tabs">
          <button
            className={`mode-tab ${captureMode === 'camera' ? 'active' : ''}`}
            onClick={() => setCaptureMode('camera')}
          >
            <Icons.Camera />
            Câmera
          </button>
          <button
            className={`mode-tab ${captureMode === 'upload' ? 'active' : ''}`}
            onClick={() => setCaptureMode('upload')}
          >
            <Icons.Upload />
            Upload
          </button>
        </div>

        {/* Erro da câmera */}
        {cameraError && (
          <div className="camera-error">
            {cameraError}
          </div>
        )}

        {/* Área de captura */}
        {currentImage ? (
          // Preview da imagem capturada/uploaded
          <div className="preview-container">
            <img src={currentImage} alt="Preview" className="preview-image" />
            <div className="preview-overlay">
              <button className="preview-clear" onClick={clearImage} title="Remover imagem">
                <Icons.X />
              </button>
            </div>
          </div>
        ) : captureMode === 'camera' ? (
          // Modo câmera
          <div>
            <div className="camera-container">
              {cameraActive ? (
                <>
                  <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    muted
                    className="camera-video"
                    style={{ display: cameraReady ? 'block' : 'none' }}
                  />
                  {cameraLoading && (
                    <div className="camera-placeholder">
                      <div className="loading-spinner" style={{ width: '40px', height: '40px', borderWidth: '3px', borderColor: '#3b82f6', borderTopColor: 'transparent' }} />
                      <p style={{ marginTop: '16px' }}>Iniciando câmera...</p>
                    </div>
                  )}
                </>
              ) : (
                <div className="camera-placeholder">
                  <div className="camera-placeholder-icon">📷</div>
                  <p>Clique em "Iniciar Câmera" para começar</p>
                </div>
              )}
            </div>
            <canvas ref={canvasRef} />
            <div className="btn-group">
              {!cameraActive ? (
                <button className="btn btn-primary" onClick={startCamera}>
                  <Icons.Camera />
                  Iniciar Câmera
                </button>
              ) : (
                <>
                  <button className="btn btn-success" onClick={capturePhoto} disabled={!cameraReady}>
                    <Icons.Scan />
                    Capturar Foto
                  </button>
                  <button className="btn btn-secondary" onClick={stopCamera}>
                    Cancelar
                  </button>
                </>
              )}
            </div>
          </div>
        ) : (
          // Modo upload
          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleFileUpload}
              style={{ display: 'none' }}
              id="file-upload"
            />
            <label htmlFor="file-upload" className="upload-zone">
              <div className="upload-zone-icon">
                <Icons.Upload />
              </div>
              <p className="upload-zone-text">
                Clique para selecionar ou <strong>arraste uma imagem</strong>
              </p>
              <p className="upload-zone-text" style={{ marginTop: '8px', fontSize: '0.75rem' }}>
                Formatos aceitos: JPEG, PNG, WebP
              </p>
            </label>
          </div>
        )}

        {/* Botão de Cadastrar */}
        <div className="btn-group" style={{ marginTop: '24px' }}>
          <button
            className="btn btn-primary"
            onClick={handleSubmit}
            disabled={!isFormValid() || status === 'processing'}
            style={{ flex: 1, maxWidth: '300px' }}
          >
            {status === 'processing' ? (
              <>
                <span className="loading-spinner" />
                Processando...
              </>
            ) : (
              <>
                <Icons.CheckCircle />
                Cadastrar Biometria
              </>
            )}
          </button>
          
          {currentImage && (
            <button className="btn btn-secondary" onClick={clearImage}>
              Nova Foto
            </button>
          )}
        </div>
      </div>

      {/* Resultado */}
      {response && (
        <div className={`result-card ${response.success ? 'result-success' : 'result-error'}`}>
          <div className="result-header">
            <span className="result-icon">
              {response.success ? '✅' : '❌'}
            </span>
            <span className="result-title">
              {response.success ? response.data?.mensagem || 'Cadastro realizado com sucesso!' : 'Erro no cadastro'}
            </span>
          </div>
          
          <div className="result-body">
            {response.success && response.data ? (
              <>
                <div className="result-details">
                  {/* Qualidade */}
                  <div className="result-detail">
                    <span className="result-detail-label">Qualidade da Face</span>
                    <span 
                      className="result-detail-value"
                      style={{ color: getQualidadeColor(response.data.qualidade) }}
                    >
                      {(response.data.qualidade * 100).toFixed(0)}% - {getQualidadeTexto(response.data.qualidade)}
                    </span>
                  </div>
                  <div className="quality-bar">
                    <div 
                      className="quality-fill" 
                      style={{ 
                        width: `${response.data.qualidade * 100}%`,
                        background: getQualidadeColor(response.data.qualidade)
                      }}
                    />
                  </div>
                  
                  {/* Operação */}
                  <div className="result-detail" style={{ marginTop: '12px' }}>
                    <span className="result-detail-label">Operação</span>
                    <span className="result-detail-value">
                      {response.data.operacao === 'insert' && '➕ Novo cadastro'}
                      {response.data.operacao === 'update' && '🔄 Atualização'}
                      {response.data.operacao === 'merge' && '🔗 Vinculação (merge)'}
                    </span>
                  </div>
                  
                  {/* External IDs */}
                  {response.data.externalIds && Object.keys(response.data.externalIds).length > 0 && (
                    <div className="result-detail" style={{ marginTop: '12px', flexDirection: 'column', alignItems: 'flex-start', gap: '8px' }}>
                      <span className="result-detail-label">IDs Externos Vinculados</span>
                      <div className="external-ids">
                        {Object.entries(response.data.externalIds).map(([prefix, id]) => (
                          <span key={prefix} className="external-id-tag">
                            {prefix}_{id}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  
                  {/* Tempo de processamento */}
                  <div className="result-detail" style={{ marginTop: '12px' }}>
                    <span className="result-detail-label">Tempo de Processamento</span>
                    <span className="result-detail-value">{response.data.processedIn}ms</span>
                  </div>
                </div>
              </>
            ) : (
              <>
                <p>{response.error}</p>
                {response.code && (
                  <p style={{ fontFamily: 'monospace', marginTop: '8px' }}>
                    Código: {response.code}
                  </p>
                )}
                {response.dicas && response.dicas.length > 0 && (
                  <ul className="tips-list">
                    {response.dicas.map((dica, i) => (
                      <li key={i}>{dica}</li>
                    ))}
                  </ul>
                )}
                {response.qualidade !== undefined && (
                  <p style={{ marginTop: '12px' }}>
                    Qualidade detectada: {(response.qualidade * 100).toFixed(0)}%
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Dicas */}
      <div className="card" style={{ marginTop: '24px' }}>
        <h2 className="card-title">
          <span className="card-icon"><Icons.AlertCircle /></span>
          Dicas para um bom cadastro
        </h2>
        <ul style={{ paddingLeft: '20px', color: '#475569', lineHeight: '1.8' }}>
          <li>Posicione o rosto <strong>centralizado e de frente</strong> para a câmera</li>
          <li>Certifique-se de ter <strong>boa iluminação</strong> no ambiente</li>
          <li>Evite fotos com <strong>óculos escuros</strong> ou objetos cobrindo o rosto</li>
          <li>A qualidade mínima aceita é <strong>40%</strong></li>
          <li>Imagens muito escuras ou desfocadas serão rejeitadas</li>
        </ul>
      </div>
    </div>
  );
}
