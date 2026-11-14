FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PORT=8080 PYTHONPATH=/app/src
WORKDIR /app
COPY packages/contracts/events.schema.json /app/packages/contracts/events.schema.json
COPY cloud/gcp/intelligence/src /app/src
EXPOSE 8080
CMD ["python", "-m", "arquifusion_intelligence"]
