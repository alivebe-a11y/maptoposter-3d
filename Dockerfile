FROM python:3.11-slim AS builder

RUN apt-get update && apt-get install -y \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Download Roboto fonts using Python (no extra tools needed, follows redirects)
RUN python -c "
import urllib.request, os
os.makedirs('/app/fonts', exist_ok=True)
base = 'https://raw.githubusercontent.com/google/fonts/main/apache/roboto/static/'
for f in ['Roboto-Bold.ttf', 'Roboto-Regular.ttf', 'Roboto-Light.ttf']:
    print('Downloading', f)
    urllib.request.urlretrieve(base + f, '/app/fonts/' + f)
print('Fonts ready')
"

FROM python:3.11-slim

WORKDIR /app

COPY --from=builder /opt/venv /opt/venv
COPY --from=builder /app/fonts /app/fonts
COPY . .

RUN mkdir -p /app/posters /app/overlays_cache /app/badges

ENV PATH="/opt/venv/bin:$PATH"

EXPOSE 5025

CMD ["python", "app.py"]
