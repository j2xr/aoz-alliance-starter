FROM python:3.12-slim

# System deps:
#   - Tesseract runtime + language packs (rus/jpn/chi_sim/vie/kor for the
#     multilingual name OCR; eng comes with the base package).
#   - libtesseract-dev + libleptonica-dev + build tooling: required to compile
#     the tesserocr Cython bindings against the local Tesseract install.
#     tesserocr is our default OCR backend (in-process C API, ~5ms overhead vs
#     ~100ms subprocess spawn for pytesseract).
#   - OpenCV headless runtime libs (opencv-python-headless still pulls these).
RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    tesseract-ocr-rus \
    tesseract-ocr-jpn \
    tesseract-ocr-chi-sim \
    tesseract-ocr-vie \
    tesseract-ocr-kor \
    libtesseract-dev \
    libleptonica-dev \
    pkg-config \
    gcc \
    g++ \
    libglib2.0-0 \
    libsm6 \
    libxrender1 \
    libxext6 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PYTHONUNBUFFERED=1 \
    # tesserocr needs TESSDATA_PREFIX to locate language files; the Debian
    # tesseract package installs them under /usr/share/tesseract-ocr/<ver>/.
    TESSDATA_PREFIX=/usr/share/tesseract-ocr/5/tessdata/

WORKDIR /app

# Install runtime deps before copying source for better layer caching
COPY pyproject.toml ./
RUN uv sync --no-dev --no-install-project

COPY app/ app/

# Activate the venv and expose app/ to the import path
ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONPATH="/app"

RUN useradd -r -u 1001 -s /sbin/nologin ocr && chown -R ocr /app
USER ocr

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
