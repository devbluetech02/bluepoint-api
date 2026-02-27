"""
Face Recognition Microservice - InsightFace/ArcFace
Endpoints para extração de embeddings faciais e comparação.
Usa modelo buffalo_l (ArcFace) com ONNX Runtime em CPU.
"""

import base64
import io
import time
from contextlib import asynccontextmanager
from typing import Optional

import cv2
import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from insightface.app import FaceAnalysis
from PIL import Image
from pydantic import BaseModel

# ==========================================
# Estado global do modelo
# ==========================================
face_app: Optional[FaceAnalysis] = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Carrega modelo na inicialização."""
    global face_app
    print("[InsightFace] Carregando modelo buffalo_l...")
    start = time.time()

    face_app = FaceAnalysis(
        name="buffalo_l",
        providers=["CPUExecutionProvider"],
    )
    # det_size controla resolução da detecção - 640x640 é o padrão otimizado
    face_app.prepare(ctx_id=-1, det_size=(640, 640))

    elapsed = time.time() - start
    print(f"[InsightFace] Modelo carregado em {elapsed:.1f}s")
    yield
    print("[InsightFace] Encerrando...")


app = FastAPI(title="BluePoint Face Service", lifespan=lifespan)


# ==========================================
# Schemas
# ==========================================
class ExtractRequest(BaseModel):
    """Request para extrair embedding de uma imagem."""
    imagem: str  # Base64 da imagem (com ou sem prefixo data:image/...)


class CompareRequest(BaseModel):
    """Request para comparar dois embeddings."""
    embedding1: list[float]
    embedding2: list[float]


# ==========================================
# Funções auxiliares
# ==========================================
def decode_base64_image(base64_str: str) -> np.ndarray:
    """Decodifica imagem base64 para numpy array (BGR, formato OpenCV)."""
    # Remover prefixo data:image/... se existir
    if "," in base64_str:
        base64_str = base64_str.split(",", 1)[1]

    try:
        img_bytes = base64.b64decode(base64_str)
    except Exception:
        raise HTTPException(status_code=400, detail="Base64 inválido")

    # Converter bytes para imagem via PIL (mais robusto que OpenCV para formatos variados)
    try:
        pil_image = Image.open(io.BytesIO(img_bytes))
        # Converter para RGB se necessário
        if pil_image.mode != "RGB":
            pil_image = pil_image.convert("RGB")
        # Converter para numpy array BGR (formato OpenCV/InsightFace)
        img_array = np.array(pil_image)
        img_bgr = cv2.cvtColor(img_array, cv2.COLOR_RGB2BGR)
        return img_bgr
    except Exception:
        raise HTTPException(status_code=400, detail="Imagem inválida ou corrompida")


def cosine_distance(emb1: np.ndarray, emb2: np.ndarray) -> float:
    """Calcula distância coseno entre dois embeddings (0 = idêntico, 2 = oposto)."""
    emb1_norm = emb1 / np.linalg.norm(emb1)
    emb2_norm = emb2 / np.linalg.norm(emb2)
    similarity = np.dot(emb1_norm, emb2_norm)
    return float(1.0 - similarity)


def cosine_similarity(emb1: np.ndarray, emb2: np.ndarray) -> float:
    """Calcula similaridade coseno entre dois embeddings (1 = idêntico, -1 = oposto)."""
    emb1_norm = emb1 / np.linalg.norm(emb1)
    emb2_norm = emb2 / np.linalg.norm(emb2)
    return float(np.dot(emb1_norm, emb2_norm))


# ==========================================
# Endpoints
# ==========================================
@app.get("/health")
async def health():
    """Health check."""
    return {
        "status": "healthy",
        "model": "buffalo_l" if face_app else None,
        "ready": face_app is not None,
    }


@app.post("/extract")
async def extract_embedding(request: ExtractRequest):
    """
    Extrai embedding facial de uma imagem.
    Retorna embedding 512-dim, qualidade da detecção e bounding box.
    """
    if not face_app:
        raise HTTPException(status_code=503, detail="Modelo não carregado")

    start = time.time()

    # Decodificar imagem
    img = decode_base64_image(request.imagem)
    h, w = img.shape[:2]

    # Detectar faces
    faces = face_app.get(img)

    if not faces:
        return JSONResponse(content={
            "success": False,
            "error": "Nenhuma face detectada na imagem",
            "code": "NO_FACE_DETECTED",
            "processedIn": int((time.time() - start) * 1000),
        })

    # Pegar a face mais próxima da câmera (maior área de bounding box),
    # usando det_score como desempate. Isso garante que em cenários com
    # múltiplas pessoas, o sistema priorize quem está na frente da câmera.
    def face_selection_score(f):
        fb = f.bbox
        face_area = (fb[2] - fb[0]) * (fb[3] - fb[1])
        img_area = w * h
        area_ratio = face_area / img_area if img_area > 0 else 0
        # Peso principal: tamanho da face (70%), desempate: det_score (30%)
        return area_ratio * 0.7 + float(f.det_score) * 0.3

    best_face = max(faces, key=face_selection_score)

    # Extrair dados
    embedding = best_face.normed_embedding  # Já normalizado L2 (512-dim)
    det_score = float(best_face.det_score)
    bbox = best_face.bbox.tolist()  # [x1, y1, x2, y2]

    # Calcular qualidade composta
    # - Score de detecção (peso 0.5)
    # - Tamanho da face relativo à imagem (peso 0.3)
    # - Centralização (peso 0.2)
    face_w = bbox[2] - bbox[0]
    face_h = bbox[3] - bbox[1]
    face_area = face_w * face_h
    img_area = w * h
    size_ratio = face_area / img_area

    # Score de tamanho (ideal: 10-50% da imagem)
    if size_ratio < 0.03:
        size_score = size_ratio / 0.03 * 0.5
    elif size_ratio < 0.1:
        size_score = 0.5 + (size_ratio - 0.03) / 0.07 * 0.3
    elif size_ratio < 0.5:
        size_score = 0.8 + (size_ratio - 0.1) / 0.4 * 0.2
    else:
        size_score = max(0.5, 1.0 - (size_ratio - 0.5) * 0.5)

    # Score de centralização
    face_cx = (bbox[0] + bbox[2]) / 2
    face_cy = (bbox[1] + bbox[3]) / 2
    center_dist = ((face_cx - w / 2) ** 2 + (face_cy - h / 2) ** 2) ** 0.5
    max_dist = ((w / 2) ** 2 + (h / 2) ** 2) ** 0.5
    center_score = max(0, 1 - (center_dist / max_dist) * 1.5)

    quality = det_score * 0.5 + size_score * 0.3 + center_score * 0.2
    quality = round(min(1.0, max(0.0, quality)), 3)

    elapsed = int((time.time() - start) * 1000)

    return {
        "success": True,
        "embedding": embedding.tolist(),
        "dimensions": len(embedding),
        "quality": quality,
        "qualityDetails": {
            "detScore": round(det_score, 3),
            "sizeScore": round(size_score, 3),
            "centerScore": round(center_score, 3),
        },
        "bbox": [round(v, 1) for v in bbox],
        "imageSize": {"width": w, "height": h},
        "totalFaces": len(faces),
        "processedIn": elapsed,
    }


@app.post("/compare")
async def compare_embeddings(request: CompareRequest):
    """
    Compara dois embeddings e retorna distância coseno + similaridade.
    """
    try:
        emb1 = np.array(request.embedding1, dtype=np.float32)
        emb2 = np.array(request.embedding2, dtype=np.float32)
    except Exception:
        raise HTTPException(status_code=400, detail="Embeddings inválidos")

    if len(emb1) != 512 or len(emb2) != 512:
        raise HTTPException(
            status_code=400,
            detail=f"Embeddings devem ter 512 dimensões (recebido: {len(emb1)}, {len(emb2)})",
        )

    distance = cosine_distance(emb1, emb2)
    similarity = cosine_similarity(emb1, emb2)

    return {
        "distance": round(distance, 6),
        "similarity": round(similarity, 6),
        "isMatch": distance < 0.4,  # Threshold padrão
    }
