# Dockerfile
FROM node:18-bullseye

# keep noninteractive
ARG DEBIAN_FRONTEND=noninteractive

# Install system packages including ffmpeg, python & pip
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ffmpeg \
      python3 \
      python3-pip \
      ca-certificates \
      git \
      curl && \
    pip3 install --no-cache-dir yt-dlp && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

# copy package manifest first for caching
COPY package.json package-lock.json* ./

# Use npm install (safe if package-lock missing). Use --production in prod images.
RUN npm install --no-audit --no-fund --production

# Copy rest of the app
COPY . .

# Expose port
EXPOSE 3000

# Ensure logs printed immediately
ENV NODE_ENV=production
ENV TZ=UTC

# Start
CMD ["node", "server.js"]
