FROM node:18-alpine

WORKDIR /app

# Copy package files first (better caching)
COPY package*.json ./

RUN npm install

# Copy the rest of the code
COPY . .

EXPOSE 3000

# Use nodemon for hot-reloading (auto-restart when you save files)
CMD ["npx", "nodemon", "index.js"]
