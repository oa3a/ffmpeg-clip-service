# Dockerfile - installs ffmpeg + yt-dlp and runs Node server
FROM node:18-bullseye

# Install system deps and yt-dlp (via pip)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ffmpeg \
      python3 \
      python3-pip \
      ca-certificates \
      curl && \
    pip3 install --no-cache-dir yt-dlp && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

# copy and install dependencies
COPY package.json package-lock.json* ./
RUN npm ci --production

# copy app
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
