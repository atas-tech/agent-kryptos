FROM node:22-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/browser-ui/package.json packages/browser-ui/package.json
COPY packages/sps-server/package.json packages/sps-server/package.json
COPY packages/agent-skill/package.json packages/agent-skill/package.json
COPY packages/gateway/package.json packages/gateway/package.json
COPY packages/openclaw-plugin/package.json packages/openclaw-plugin/package.json

RUN npm ci

FROM deps AS build
WORKDIR /app

ARG VITE_SPS_API_URL
ENV VITE_SPS_API_URL=${VITE_SPS_API_URL}

COPY packages/browser-ui packages/browser-ui

RUN npm run build --workspace=packages/browser-ui

FROM nginx:1.29-alpine AS runtime

COPY packages/browser-ui/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/packages/browser-ui/dist /usr/share/nginx/html

EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
