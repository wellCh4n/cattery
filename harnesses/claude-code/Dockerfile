FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install

COPY src/ ./src/

# claude CLI refuses to run --dangerously-skip-permissions as root; use the
# node user that ships with the base image and own /app + /work.
RUN mkdir -p /work && chown -R node:node /app /work

USER node

ENV PATH="/app/node_modules/.bin:${PATH}"
ENV PORT=4096
ENV WORK_DIR=/work
ENV HOME=/home/node

EXPOSE 4096

CMD ["node_modules/.bin/tsx", "src/server.ts"]
