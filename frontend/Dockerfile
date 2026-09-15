FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
# Rendered by the nginx image's envsubst entrypoint at start. The filter keeps
# substitution to our own variable so nginx's own $vars are left alone.
COPY default.conf.template /etc/nginx/templates/default.conf.template
ENV BACKEND_ORIGIN=backend:8000 \
    NGINX_ENVSUBST_FILTER=BACKEND_ORIGIN
EXPOSE 80
