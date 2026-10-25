# --- build stage ---
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install
COPY src ./src
RUN npm run build

# --- runtime stage ---
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# /data — volume под кэш introspection-клиента. Каталог заводим ДО `USER node` и
# отдаём node: иначе docker создаёт volume от root:root, запись из-под uid 1000
# падает, и контейнер регистрирует нового OAuth-клиента при каждом старте.
RUN mkdir -p /data && chown node:node /data
EXPOSE 8080
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
