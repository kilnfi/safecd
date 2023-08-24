FROM node:18

COPY . /app
WORKDIR /app
RUN yarn

ENTRYPOINT [ "node", "/app/dist/index.js" ]