# Stage 1: Node 22 supplies the runtime binary and the pinned LibreDWG WASM package (no apt needed).
FROM node:22-slim AS converter
WORKDIR /converter
COPY converter/package.json converter/package-lock.json ./
RUN npm ci --omit=dev
COPY converter/dwg2dxf.mjs ./

# Stage 2: the worker image.
FROM python:3.12-slim
RUN pip install --no-cache-dir uv==0.11.32
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy PYTHONUNBUFFERED=1 PATH="/app/.venv/bin:$PATH"
WORKDIR /app
COPY pyproject.toml uv.lock README.md ./
RUN uv sync --frozen --no-dev --no-install-project
COPY cad_worker ./cad_worker
RUN uv sync --frozen --no-dev
COPY --from=converter /usr/local/bin/node /usr/local/bin/node
COPY --from=converter /converter /app/converter
RUN useradd --system --create-home --uid 10001 worker
USER worker
CMD ["python", "-m", "cad_worker"]
