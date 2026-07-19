# Pulse ERP — frontend
#
# Vite builds to static assets, so the runtime image is nginx with no Node.
#
# NOTE: VITE_* variables are baked in at BUILD time, not read at runtime. The API
# URL therefore has to be a build arg — setting it as a container env var at
# `docker run` does nothing, which is a common and confusing failure.

# ── build ─────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .

ARG VITE_API_URL=/api
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build

# ── runtime ───────────────────────────────────────────────────────────────────
FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1

CMD ["nginx", "-g", "daemon off;"]
