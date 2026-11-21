FROM python:3.11-slim

WORKDIR /app

# Instalar dependencias del sistema
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copiar requirements e instalar dependencias Python
COPY backend/requirements.txt .
RUN pip install --no-cache-dir --timeout=300 -r requirements.txt

# Copiar código
COPY backend/ ./backend/
COPY data/ ./data/
COPY index.html ./
COPY styles.css ./
COPY app.js ./

# Establecer PYTHONPATH
ENV PYTHONPATH=/app/backend

# Crear usuario no-root
RUN useradd -m -u 1000 appuser && chown -R appuser:appuser /app
USER appuser

# Exponer puerto
EXPOSE 8080

# Comando de inicio
CMD ["python", "-m", "uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8080"]