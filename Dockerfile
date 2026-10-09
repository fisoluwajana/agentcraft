# AgentCraft runtime image (agents + ops). Built natively on the arm64 host.
FROM public.ecr.aws/docker/library/node:22.21-bookworm-slim
ENV NODE_ENV=production NODE_NO_WARNINGS=1
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY config ./config
COPY agents ./agents
COPY discord ./discord
COPY ops ./ops
# Private agendas are never baked in; they come from Secrets Manager at runtime.
RUN rm -rf agents/personas/private
USER node
CMD ["node", "agents/src/agent.js"]
