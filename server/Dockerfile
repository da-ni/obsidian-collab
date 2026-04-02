FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY server.ts ./
EXPOSE 1234
ENV HOST=0.0.0.0 PORT=1234 YPERSISTENCE=/data
VOLUME /data
CMD ["npx", "tsx", "server.ts"]
