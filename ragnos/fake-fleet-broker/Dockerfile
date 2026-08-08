FROM node:22.23.2-alpine
WORKDIR /app
COPY ragnos/packages/ragnos-fleet/src/protocol.js /app/ragnos/packages/ragnos-fleet/src/protocol.js
COPY ragnos/fake-fleet-broker/src/server.js /app/ragnos/fake-fleet-broker/src/server.js
USER node
ENV HOST=0.0.0.0 PORT=8787
EXPOSE 8787
CMD ["node", "/app/ragnos/fake-fleet-broker/src/server.js"]
