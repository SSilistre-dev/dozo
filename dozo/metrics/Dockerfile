# Image for `make olcum`: the gate's Node image plus the pinned analysis tools (tools/package-lock.json)
# and what upstream's unit tests call outside Node (git, jq, python3). Built by olcum.sh.
FROM koalaman/shellcheck:v0.11.0 AS shellcheck
FROM node:24.22-slim
RUN apt-get update && apt-get install -y --no-install-recommends age ca-certificates git jq python3 \
  && rm -rf /var/lib/apt/lists/*
COPY --from=shellcheck /bin/shellcheck /usr/local/bin/shellcheck
COPY tools/package.json tools/package-lock.json /opt/tools/
RUN cd /opt/tools && npm ci --no-audit --no-fund --loglevel=warn && npm cache clean --force
