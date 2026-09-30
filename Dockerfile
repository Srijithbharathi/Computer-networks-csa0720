FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
RUN npx prisma generate
EXPOSE 8080
CMD ["sh","-c","node prisma/seed.js && node src/server.js"]
