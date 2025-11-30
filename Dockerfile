# Use official Node image
FROM node:18-slim

# Install dependencies including ffmpeg
RUN apt-get update && \
    apt-get install -y ffmpeg python3 python3-pip && \
    rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /usr/src/app

# Copy package files first for layer caching
COPY package*.json ./

# Install npm deps
RUN npm install --production

# Copy app source
COPY . .

# Expose service port
EXPOSE 3000

# Run server
CMD ["node", "server.js"]
