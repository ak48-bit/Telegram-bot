# WFHDPbot — Railway/Linux deployment
FROM python:3.13-slim

# Chinese font support for image rendering
RUN apt-get update && apt-get install -y --no-install-recommends \
    fonts-noto-cjk \
    fontconfig \
    && rm -rf /var/lib/apt/lists/* \
    && fc-cache -f

WORKDIR /app

# Dependencies first (cached layer)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Application code
COPY bot_listener.py _platform_config.py _runtime.py _bot_data.py \
     push_update.py push_update_en.py comparison_push.py \
     hijack_comparison_push.py hijack_summary_renderer.py \
     config.json active_month.json requirements.txt ./

# Data directories (mounted as Railway Volume at /data)
RUN mkdir -p /data/excel /data/comparison_archive /data/generated /data/backups /data/uploads \
    && chmod -R 777 /data

# Run as non-root
RUN useradd --create-home --shell /bin/bash botuser \
    && chown -R botuser:botuser /app /data
USER botuser

# Start: preflight smoke test if RAILWAY_SMOKE_TEST=1, else polling bot
CMD ["python", "-u", "bot_listener.py"]
