# ---- BASE NODE IMAGE ----
FROM node:18-bullseye

# ---- INSTALL FFMPEG + YT-DLP ----
RUN apt-get update && \
    apt-get install -y ffmpeg python3 python3-pip && \
    pip3 install yt-dlp && \
    rm -rf /var/lib/apt/lists/*

# ---- WORKDIR ----
WORKDIR /app

# ---- INSTALL NODE DEPS ----
COPY package.json package-lock.json* ./
RUN npm install --production

# ---- COPY SOURCE ----
COPY . .

# ---- EXPOSE PORT ----
EXPOSE 3000

# ---- START SERVER ----
CMD ["node", "server.js"]
