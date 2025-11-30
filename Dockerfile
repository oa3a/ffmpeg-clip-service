FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# Install dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    curl \
    wget \
    ca-certificates \
    ffmpeg \
    yt-dlp \
    && rm -rf /var/lib/apt/lists/*

# Create workdir
WORKDIR /usr/src/app

# Copy package.json first
COPY package.json package-lock.json* ./

RUN npm install --production

# Copy the rest
COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
