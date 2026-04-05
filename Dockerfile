FROM python:3.11-slim AS builder

RUN apt-get update && apt-get install -y \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

FROM python:3.11-slim

WORKDIR /app

COPY --from=builder /opt/venv /opt/venv
COPY . .

RUN mkdir -p /app/posters /app/overlays_cache /app/badges /app/fonts

ENV PATH="/opt/venv/bin:$PATH"
ENV MPLBACKEND=Agg

EXPOSE 5025

CMD ["python", "app.py"]
