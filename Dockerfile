FROM node:18-bullseye

RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app
COPY package.json ./
RUN npm install --production

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
