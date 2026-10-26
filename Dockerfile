# Same pinned Node.js as api.backx.trade. Bump this tag on every Node.js security release
# (https://nodejs.org/en/blog/vulnerability). 24.22.1 = October 2026 security release.
# Pulled from AWS ECR Public (official Docker Hub mirror): Docker Hub rate-limits anonymous pulls.
FROM public.ecr.aws/docker/library/node:24.22.1-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY src ./src

# Never run as root.
USER node
EXPOSE 8080
CMD ["node", "src/index.js"]
