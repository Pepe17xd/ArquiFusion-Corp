FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PORT=8080 PYTHONPATH=/app/src
WORKDIR /app
RUN pip install --no-cache-dir "google-genai>=1.0"
COPY packages/contracts/events.schema.json /app/packages/contracts/events.schema.json
COPY cloud/gcp/intelligence/src /app/src
RUN useradd --system --no-create-home app
USER app
EXPOSE 8080
CMD ["python", "-m", "arquifusion_intelligence"]