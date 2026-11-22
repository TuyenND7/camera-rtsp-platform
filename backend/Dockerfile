FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
# ffmpeg để kết nối RTSP + tạo HLS/recording
RUN apk add --no-cache ffmpeg
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# schema.sql cần cho runtime (initDb đọc từ dist path)
COPY --from=build /app/src/schema.sql ./dist/schema.sql
COPY --from=build /app/src/system/schema.sql ./dist/system/schema.sql
COPY --from=build /app/src/operations/schema.sql ./dist/operations/schema.sql
COPY --from=build /app/src/evidence/schema.sql ./dist/evidence/schema.sql
EXPOSE 4000
CMD ["node", "dist/index.js"]
