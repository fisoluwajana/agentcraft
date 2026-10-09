# AgentCraft radio image: shared runtime code plus discord.js voice and the Polly client.
FROM public.ecr.aws/docker/library/node:22.21-bookworm-slim
ENV NODE_ENV=production NODE_NO_WARNINGS=1
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY radio/package.json radio/package-lock.json ./radio/
RUN cd radio && npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY config ./config
COPY agents ./agents
COPY discord ./discord
COPY ops ./ops
COPY radio/radio.js ./radio/
RUN rm -rf agents/personas/private
USER node
CMD ["node", "radio/radio.js"]
