#!/usr/bin/env python3
"""
Sincroniza o campo telefone (TELEND) da tabela PCEMPR (Oracle)
para a tabela bluepoint.bt_colaboradores (PostgreSQL), apenas onde o telefone
no Postgres ainda não está preenchido.
No Oracle apenas consulta (SELECT) WINDOW.PCEMPR; não altera nada no Oracle.

Configuração via variáveis de ambiente:
  ORACLE_ENABLED, ORACLE_HOST, ORACLE_PORT, ORACLE_DB, ORACLE_USER, ORACLE_PASSWORD
  (Postgres: use as constantes abaixo ou env DB_* se existir)

Uso:
  pip install -r scripts/requirements-sync-telefone.txt
  python scripts/sincronizar_telefone_pcempr.py
"""

import os
import re
import oracledb
import psycopg2

# =====================================================
# ORACLE (origem - PCEMPR) - lido do ambiente
# =====================================================
def get_oracle_config():
    if os.environ.get("ORACLE_ENABLED", "").lower() != "true":
        return None
    return {
        "host": os.environ.get("ORACLE_HOST", "cloud-7445.reposit.com.br"),
        "port": int(os.environ.get("ORACLE_PORT", "30492")),
        "database": os.environ.get("ORACLE_DB", "prodwblue"),
        "user": os.environ.get("ORACLE_USER", "CHRISTOFER"),
        "password": os.environ.get("ORACLE_PASSWORD", ""),
    }

# =====================================================
# POSTGRES (destino - bt_colaboradores)
# =====================================================
POSTGRES_HOST = os.environ.get("DB_HOST", "localhost")
POSTGRES_PORT = int(os.environ.get("DB_PORT", "5432"))
POSTGRES_USER = os.environ.get("DB_USERNAME", "bluepoint")
POSTGRES_PASSWORD = os.environ.get("DB_PASSWORD", "")
POSTGRES_DATABASE = os.environ.get("DB_DATABASE", "bluepoint")

# =====================================================
# QUERY PCEMPR (somente leitura; nenhuma alteração na tabela Oracle)
# Schema: WINDOW.PCEMPR (override com ORACLE_SCHEMA se necessário)
# =====================================================
def _ora_table(name: str) -> str:
    schema = os.environ.get("ORACLE_SCHEMA", "WINDOW").strip()
    return f"{schema}.{name}" if schema else name

# WINDOW.PCEMPR: colunas de telefone = CELULAR (preferido) e FONE; identificador = CPF
# Sem WHERE: buscamos tudo e filtramos em Python (evita Oracle tratar '' como NULL)
def build_query_pcempr():
    t_emp = _ora_table("PCEMPR")
    return f"""
    SELECT MATRICULA, CPF, CELULAR, FONE FROM {t_emp}
    """


def limpar_cpf(val):
    if val is None:
        return None
    s = re.sub(r"[^\d]", "", str(val).strip())
    if len(s) == 11:
        return s
    if len(s) == 10:  # CPF sem zero à esquerda
        return "0" + s
    return None


def normalizar_telefone(val):
    if val is None:
        return None
    s = str(val).strip()
    if not s:
        return None
    return s[:20] if len(s) > 20 else s


def main():
    print("=" * 60)
    print("  SINCRONIZAÇÃO TELEFONE: PCEMPR (Oracle) -> bt_colaboradores (PostgreSQL)")
    print("=" * 60)

    cfg = get_oracle_config()
    if not cfg or not cfg.get("password"):
        print("\nOracle desabilitado ou sem senha. Defina ORACLE_ENABLED=true e ORACLE_PASSWORD.")
        return 1

    # Modo thick (Oracle Instant Client) suporta mais tipos de senha (evita DPY-3015)
    lib_dir = os.environ.get("ORACLE_CLIENT_LIB")
    try:
        if lib_dir:
            oracledb.init_oracle_client(lib_dir=lib_dir)
        else:
            oracledb.init_oracle_client()
        print("Oracle: usando modo thick (Instant Client).")
    except Exception:
        pass  # continua em modo thin

    dsn = f"{cfg['host']}:{cfg['port']}/{cfg['database']}"
    print(f"\nConectando ao Oracle {dsn}...")
    try:
        conn_ora = oracledb.connect(
            user=cfg["user"],
            password=cfg["password"],
            dsn=dsn,
        )
    except oracledb.NotSupportedError as e:
        if "3015" in str(e) or "0x939" in str(e).lower():
            print(
                "Erro DPY-3015: o servidor Oracle usa tipo de senha não suportado no modo thin.\n"
                "Instale o Oracle Instant Client e coloque no PATH (ou lib_dir), ou use o modo thick."
            )
        print(f"Erro ao conectar no Oracle: {e}")
        return 1
    except Exception as e:
        print(f"Erro ao conectar no Oracle: {e}")
        return 1

    telefones_por_cpf = {}
    query_pcempr = build_query_pcempr()
    try:
        cur = conn_ora.cursor()
        cur.execute(query_pcempr)
        columns = [c[0] for c in cur.description]
    except oracledb.DatabaseError as e:
        err, = e.args
        print(f"Erro Oracle ao executar query: {err.message}")
        if err.code == 942:  # table or view does not exist
            print("Dica: defina ORACLE_SCHEMA (ex: export ORACLE_SCHEMA=SEU_SCHEMA) se a tabela estiver em outro schema.")
            print("Query usada:", query_pcempr.strip()[:500])
        return 1
    rows = cur.fetchall()
    cur.close()
    # Acesso às colunas insensível a maiúsculas (Oracle pode retornar CELULAR ou Celular)
    def get_col(d, name):
        for k, v in d.items():
            if (k or "").upper() == name.upper():
                return v
        return d.get(name)

    for row in rows:
        row_dict = dict(zip(columns, row))
        cel = normalizar_telefone(get_col(row_dict, "CELULAR"))
        fone = normalizar_telefone(get_col(row_dict, "FONE"))
        tel = cel or fone  # preferir celular, senão fone
        cpf = limpar_cpf(get_col(row_dict, "CPF"))
        if not tel:
            continue
        if cpf:
            telefones_por_cpf[cpf] = tel
            if len(cpf) == 11 and cpf.startswith("0"):
                telefones_por_cpf[cpf[1:]] = tel  # também por 10 dígitos (match sem zero)
    conn_ora.close()

    print(f"Registros lidos do Oracle: {len(rows)}")
    print(f"Registros com CPF válido para sincronizar: {len(telefones_por_cpf)}")

    if not telefones_por_cpf:
        print("Nenhum registro com telefone e CPF encontrado. Verifique a query QUERY_PCEMPR.")
        return 0

    # Postgres
    print(f"\nConectando ao PostgreSQL {POSTGRES_HOST}:{POSTGRES_PORT}...")
    try:
        conn_pg = psycopg2.connect(
            host=POSTGRES_HOST,
            port=POSTGRES_PORT,
            user=POSTGRES_USER,
            password=POSTGRES_PASSWORD,
            database=POSTGRES_DATABASE,
        )
        conn_pg.autocommit = False
    except Exception as e:
        print(f"Erro ao conectar no PostgreSQL: {e}")
        return 1

    cur = conn_pg.cursor()
    cur.execute("SET search_path TO bluepoint, public")

    cur.execute(
        """
        SELECT id, cpf, nome
        FROM bluepoint.bt_colaboradores
        WHERE (telefone IS NULL OR TRIM(telefone) = '')
        AND status = 'ativo'
        """
    )
    sem_telefone = cur.fetchall()

    print(f"\nColaboradores no Postgres sem telefone (ativos): {len(sem_telefone)}")
    cpfs_sem_match = []

    atualizados = 0
    sem_match = 0
    for id_colab, cpf_colab, nome in sem_telefone:
        cpf_limpo = limpar_cpf(cpf_colab)
        nome_display = ((nome or "").strip())[:40]
        if not cpf_limpo:
            print(f"  [SKIP] id={id_colab} nome={nome_display!r} cpf_postgres={cpf_colab!r} (CPF inválido ou vazio)")
            sem_match += 1
            cpfs_sem_match.append((id_colab, cpf_colab, nome_display))
            continue
        tel = telefones_por_cpf.get(cpf_limpo) or (
            telefones_por_cpf.get(cpf_limpo[1:]) if len(cpf_limpo) == 11 and cpf_limpo.startswith("0") else None
        )
        if not tel:
            sem_match += 1
            cpfs_sem_match.append((id_colab, cpf_colab, nome_display))
            print(f"  [SEM MATCH] id={id_colab} nome={nome_display!r} cpf_postgres={cpf_colab!r} cpf_limpo={cpf_limpo}")
            continue
        try:
            cur.execute(
                "UPDATE bluepoint.bt_colaboradores SET telefone = %s, atualizado_em = CURRENT_TIMESTAMP WHERE id = %s",
                (tel, id_colab),
            )
            if cur.rowcount:
                atualizados += 1
                print(f"  [OK] id={id_colab} nome={nome_display!r} cpf={cpf_limpo} -> telefone={tel}")
            else:
                print(f"  [WARN] id={id_colab} UPDATE não alterou nenhuma linha (cpf={cpf_limpo}, tel={tel})")
        except Exception as e:
            print(f"  [ERRO] id={id_colab} cpf={cpf_limpo}: {e}")

    conn_pg.commit()
    cur.close()
    conn_pg.close()

    print("\n" + "=" * 60)
    print("  RESULTADO")
    print("=" * 60)
    print(f"  Colaboradores no Postgres sem telefone (ativos): {len(sem_telefone)}")
    print(f"  Atualizados com telefone da PCEMPR:             {atualizados}")
    print(f"  Sem correspondência por CPF na PCEMPR:           {sem_match}")
    if cpfs_sem_match:
        print("\n  CPFs sem correspondência (id, cpf_postgres, nome):")
        for id_c, cpf_c, nm in cpfs_sem_match:
            print(f"    id={id_c} cpf={cpf_c!r} nome={nm!r}")
    print("=" * 60)
    return 0


if __name__ == "__main__":
    exit(main())
