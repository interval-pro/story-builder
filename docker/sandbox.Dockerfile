# Image used for task sandboxes. It holds the toolchains an implementation
# agent may need; the workspace itself is mounted at /workspace.
FROM node:22-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     git ca-certificates curl jq ripgrep build-essential \
     python3 python3-pip python3-venv postgresql-client \
  && rm -rf /var/lib/apt/lists/*

RUN git config --global --add safe.directory '*' \
  && git config --global user.email "ai-engine@localhost" \
  && git config --global user.name "AI Engineering System"

WORKDIR /workspace

CMD ["sleep", "infinity"]
