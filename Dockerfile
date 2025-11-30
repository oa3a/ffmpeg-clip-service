# Dockerfile
FROM node:18-bullseye

# Install system deps: ffmpeg, python and pip
RUN apt-get update && \
    apt-get install -y ffmpeg python3 python3-pip ca-certificates && \
    pip3 install --no-cache-dir yt-dlp && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

# Copy package.json then install (so Docker layer caching works)
COPY package.json package-lock.json* ./
RUN npm ci --only=production

# Copy app
COPY . .

# Ensure the server file uses CommonJS (server.cjs)
EXPOSE 3000

CMD ["node", "server.cjs"]
