FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --production
COPY index.js ./
RUN mkdir -p /app/logs
VOLUME ["/app/logs"]
EXPOSE 9090 9091
ENTRYPOINT ["node", "index.js"]
