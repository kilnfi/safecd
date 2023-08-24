FROM node:18

COPY . /app
WORKDIR /app
RUN yarn
RUN curl -L https://foundry.paradigm.xyz | bash
RUN bash -c "source /root/.bashrc && foundryup"
ENV PATH="/root/.foundry/bin:${PATH}"

ENTRYPOINT [ "node", "/app/dist/index.js", "sync" ]