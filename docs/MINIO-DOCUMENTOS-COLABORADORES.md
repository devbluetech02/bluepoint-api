# Estrutura MinIO – Documentos de Colaboradores

Use o **mesmo bucket** já configurado (`MINIO_BUCKET`, padrão `people`).

No MinIO não é obrigatório criar pastas manualmente: o prefixo do objeto funciona como “pasta”. Ao fazer o primeiro upload em um caminho, o caminho passa a existir. Se quiser deixar a estrutura explícita, você pode criar um objeto placeholder (ex.: `.keep`) em cada prefixo abaixo.

---

## Prefixos (estrutura de “pastas”)

Base por colaborador:

```
colaboradores/{colaborador_id}/documentos/
```

Subpastas por **tipo de documento** (códigos):

| Tipo              | Código no sistema   | Pasta no MinIO        |
|-------------------|---------------------|------------------------|
| ASO               | `aso`               | `aso/`                 |
| EPI               | `epi`               | `epi/`                 |
| Direção Defensiva | `direcao_defensiva` | `direcao_defensiva/`   |
| CNH               | `cnh`               | `cnh/`                 |
| NR35              | `nr35`              | `nr35/`                |
| Outros            | `outros`            | `outros/`              |

Caminho do arquivo (sem ano/mês):

```
colaboradores/{colaborador_id}/documentos/{tipo}/{uuid}.{ext}
```

Exemplo completo:

```
colaboradores/123/documentos/aso/1773691955478-0o5jsyatx.pdf
colaboradores/123/documentos/cnh/1773691955479-abc123.pdf
colaboradores/456/documentos/epi/1773691955480-xyz789.pdf
```

---

## Resumo para criar no MinIO (se quiser criar “pastas” vazias)

- **Bucket:** o mesmo que você já usa (ex.: `people`).
- **Prefixos** (podem ser criados com um objeto vazio como `colaboradores/.keep` ou apenas usados no primeiro upload):

  - `colaboradores/`  
  - Dentro de cada colaborador: `colaboradores/{id}/documentos/`  
  - Por tipo:  
    - `colaboradores/{id}/documentos/aso/`  
    - `colaboradores/{id}/documentos/epi/`  
    - `colaboradores/{id}/documentos/direcao_defensiva/`  
    - `colaboradores/{id}/documentos/cnh/`  
    - `colaboradores/{id}/documentos/nr35/`  
    - `colaboradores/{id}/documentos/outros/`  

Não é necessário criar um prefixo por colaborador manualmente: a API gerará o caminho no primeiro upload: `colaboradores/{id}/documentos/{tipo}/{uuid}.{ext}`.
