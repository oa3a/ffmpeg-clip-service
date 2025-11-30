# Use Node 18 as base image
FROM node:18-bullseye

# Install system dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
 && rm -rf /var/lib/apt/lists/*

# Install yt-dlp using pip
RUN pip3 install --upgrade yt-dlp

# Set working directory
WORKDIR /app

# Copy package.json first (caching)
COPY package*.json ./

# Install Node dependencies
RUN npm install --omit=dev

# Copy all project files
COPY . .

# Expose port
EXPOSE 3000

# Start server
CMD ["node", "server.js"]
