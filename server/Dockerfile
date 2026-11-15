# Solway optional heavy-job server (see server/README.md).
# Build from the repository root:  docker build -f server/Dockerfile -t solway-server .
# Run:                             docker run --rm -p 7860:7860 solway-server
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    NUMBA_CACHE_DIR=/app/.numba_cache \
    PORT=7860

# Hugging Face Spaces runs the container as user 1000: everything the server writes must belong to it.
RUN useradd -m -u 1000 user
WORKDIR /app

RUN pip install --no-cache-dir \
    "numpy>=2.1" "numba>=0.61" "pillow>=11.0" "fastapi>=0.115" "uvicorn>=0.32"

# Runtime files only: the engine, the two rl/ modules it reuses, the bundled site and scenario,
# and the one Unreal import value the site loader reads (z_ref_m).
COPY --chown=user engine/ engine/
COPY --chown=user rl/planner.py rl/terrain.py rl/
COPY --chown=user data/site/meta.json data/site/core_h.bin.gz data/site/core_layers.bin.gz data/site/reg_h.bin.gz data/site/
COPY --chown=user data/scenario/ data/scenario/
COPY --chown=user unreal_import/import_values.json unreal_import/
COPY --chown=user server/ server/
RUN mkdir -p runtime .numba_cache && chown -R user:user /app

USER user

# Compile the numba kernels into the image so a cold start only loads them.
RUN python -c "from server.app import _load, STATE; _load(); assert STATE['ready'], STATE['error']; print('warm', STATE['warm_s'], 's')"

EXPOSE 7860
CMD ["sh", "-c", "uvicorn server.app:app --host 0.0.0.0 --port ${PORT:-7860}"]
