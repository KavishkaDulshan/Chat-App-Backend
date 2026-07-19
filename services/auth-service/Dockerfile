FROM node:18-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

EXPOSE 3010

CMD ["npx", "nodemon", "index.js"]
