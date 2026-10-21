FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node package.json server.mjs ./
COPY --chown=node:node dist ./dist
USER node
ENV HOST=0.0.0.0 PORT=8000
EXPOSE 8000
CMD ["node", "server.mjs"]
