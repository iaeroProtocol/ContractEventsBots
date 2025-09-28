FROM node:20-alpine

WORKDIR /app
COPY package.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY .env ./.env || true

CMD ["node", "src/index.mjs"]

