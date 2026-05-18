FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install

COPY src/ ./src/

RUN mkdir -p /work

ENV PATH="/app/node_modules/.bin:${PATH}"
ENV PORT=4096
ENV WORK_DIR=/work

EXPOSE 4096

CMD ["node_modules/.bin/tsx", "src/server.ts"]
