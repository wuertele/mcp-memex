FROM denoland/deno:alpine-2.1.4

WORKDIR /app

COPY deno.json ./
COPY main.ts ./
COPY fixtures ./fixtures

RUN deno cache main.ts

EXPOSE 8000

CMD ["run", "--allow-net", "--allow-read", "--allow-env", "main.ts"]
