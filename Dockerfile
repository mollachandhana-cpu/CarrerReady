FROM node:20-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=6000
ENV DATA_DIR=/data
EXPOSE 6000
VOLUME ["/data"]
CMD ["npm", "start"]
