FROM node:22-slim
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY agent/    ./agent/
COPY pipeline/ ./pipeline/
COPY config/   ./config/
COPY utils/    ./utils/

# SQLite file lives here — mount a volume so data survives restarts:
#   docker run -v bumiwatch-data:/data -p 3001:3001 --env-file .env bumiwatch
ENV DB_PATH=/data/bumiwatch.db
ENV PORT=3001
VOLUME /data
EXPOSE 3001

# Runs the API and the data pipeline in one process (shared SQLite file)
CMD ["node", "agent/index.js"]
