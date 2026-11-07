FROM node:24.22.2-bookworm-slim AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24.22.2-bookworm-slim
ENV NODE_ENV=production
WORKDIR /opt/homebridge-runtime
COPY ha-app/runtime/package.json ha-app/runtime/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

WORKDIR /opt/homebridge-aupu
COPY package.json ./
COPY --from=build /build/dist ./dist
COPY ha-app/run.mjs ha-app/aupu-mapping.json ./ha-app/
CMD ["node", "ha-app/run.mjs"]
