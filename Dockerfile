# Use official Node 18 base image
FROM node:18-bullseye

# Update base system
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    yt-dlp \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package.json first (for caching)
COPY package*.json ./

# Install node deps (production only)
RUN npm install --omit=dev

# Copy rest of project
COPY . .

# Expose port
EXPOSE 3000

# Run the server
CMD ["node", "server.js"]
