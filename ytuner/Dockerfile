# YTuner: self-hosted replacement for the discontinued vTuner service the Yamaha R-N500 uses for NET RADIO.
# https://github.com/coffeegreg/YTuner  (release pinned + checksum verified)
FROM alpine:3.19

ARG YTUNER_VERSION=1.2.6
ARG YTUNER_SHA256=df3785b55e043a06386bb30b7b01137c6e093db9922ee1edc8b4c1209e78c428

# libc6-compat: FPC-built binary; sqlite-libs: Radio Browser cache (catPermMemDB)
RUN apk --no-cache add libc6-compat sqlite-libs ca-certificates curl unzip

WORKDIR /app
RUN curl -fsSL -o /tmp/ytuner.zip "https://github.com/coffeegreg/YTuner/releases/download/${YTUNER_VERSION}/ytuner-${YTUNER_VERSION}-x86_64-linux.zip" \
 && echo "${YTUNER_SHA256}  /tmp/ytuner.zip" | sha256sum -c - \
 && unzip -q /tmp/ytuner.zip -d /tmp/ytuner \
 && cp /tmp/ytuner/ytuner-${YTUNER_VERSION}-x86_64-linux/ytuner /app/ytuner \
 && chmod +x /app/ytuner \
 && rm -rf /tmp/ytuner /tmp/ytuner.zip \
 && mkdir -p /app/cache /app/db /app/config

# Our configuration (versioned in the repo). Cache and DB live in volumes (/app/cache, /app/db).
COPY ytuner.ini /app/ytuner.ini
COPY config/ /app/config/

VOLUME ["/app/cache", "/app/db"]
EXPOSE 80/tcp
CMD ["./ytuner"]
