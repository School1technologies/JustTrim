FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev
COPY schema.sql ./
COPY src ./src
COPY public ./public
EXPOSE 3000
# Run migrations (safe to repeat) and then start the API
CMD ["sh", "-c", "node src/migrate.js && node src/server.js"]
