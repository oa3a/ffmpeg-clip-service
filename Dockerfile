FROM node:18-bullseye

# Install ffmpeg + python + pip (required for yt-dlp)
RUN apt-get update && \
    apt-get install -y ffmpeg python3 python3-pip && \
    pip3 install yt-dlp && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

COPY package.json ./
RUN npm install --production

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
