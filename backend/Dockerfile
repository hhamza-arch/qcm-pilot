FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HOST=0.0.0.0

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY main.py .

# Most hosts (Render, Railway, Fly, Cloud Run) inject PORT; default 8000.
EXPOSE 8000
CMD ["python", "main.py"]
