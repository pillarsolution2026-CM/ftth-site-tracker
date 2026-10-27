FROM python:3.12-slim
RUN pip install --no-cache-dir uv==0.11.32
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy PYTHONUNBUFFERED=1 PATH="/app/.venv/bin:$PATH"
WORKDIR /app
COPY pyproject.toml uv.lock README.md ./
RUN uv sync --frozen --no-dev --no-install-project
COPY cad_worker ./cad_worker
RUN uv sync --frozen --no-dev
RUN useradd --system --uid 10001 worker
USER worker
CMD ["python", "-m", "cad_worker"]
