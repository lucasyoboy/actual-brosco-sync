FROM node:20-alpine
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json .
RUN npm install
COPY src/ src/
COPY public/ public/
RUN mkdir -p data
CMD ["node", "src/index.js"]
