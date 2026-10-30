FROM node:22-alpine

ENV NODE_ENV=production

RUN addgroup -S sandbox \
    && adduser -S sandbox -G sandbox

WORKDIR /workspace

USER sandbox

CMD ["node", "--version"]
