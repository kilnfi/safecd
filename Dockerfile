FROM node:18

COPY . /app
WORKDIR /app
RUN yarn
RUN curl -L https://foundry.paradigm.xyz | bash


ENTRYPOINT [ "node", "/app/dist/index.js", "sync" ]