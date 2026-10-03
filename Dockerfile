FROM python:3.12-slim

# ffmpeg: áudio em MP3 · pango/harfbuzz: PDF (WeasyPrint) · fontes para o PDF
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz-subset0 fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY historinhas ./historinhas

ENV PYTHONUNBUFFERED=1 DATA_DIR=/app/data
VOLUME /app/data
EXPOSE 8000

CMD ["uvicorn", "historinhas.web:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
