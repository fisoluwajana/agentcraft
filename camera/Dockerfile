# AgentCraft camera image: the shared runtime code plus prismarine-viewer, node-canvas and Chromium.
# Kept separate from the agent image so agents don't carry ~500 MB of browser.
FROM public.ecr.aws/docker/library/node:22.21-bookworm-slim
ENV NODE_ENV=production NODE_NO_WARNINGS=1 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY camera/package.json camera/package-lock.json ./camera/
RUN cd camera && npm ci --omit=dev --no-audit --no-fund && npm cache clean --force \
 && node node_modules/playwright-core/cli.js install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/*
COPY config ./config
COPY agents ./agents
COPY discord ./discord
COPY ops ./ops
COPY camera/camera.js ./camera/
RUN rm -rf agents/personas/private
USER node
CMD ["node", "camera/camera.js"]
