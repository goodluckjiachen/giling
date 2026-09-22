FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    tigervnc-standalone-server \
    tigervnc-common \
    tigervnc-tools \
    openbox \
    firefox-esr \
    websockify \
    novnc \
    dbus-x11 \
    sudo \
    fonts-dejavu-core \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    xfonts-base \
    && rm -rf /var/lib/apt/lists/*

ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

RUN useradd -m -s /bin/bash appuser && \
    echo "appuser ALL=(ALL) NOPASSWD: ALL" >> /etc/sudoers

COPY startup.sh /startup.sh
COPY config/openbox/menu.xml /app/config/openbox/menu.xml

RUN chmod +x /startup.sh

EXPOSE 6080 5900

CMD ["/startup.sh"]
