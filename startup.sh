#!/bin/bash
set -e

echo "[startup] Starting lightweight desktop..."

APPUSER="appuser"
APPUSER_HOME="/home/$APPUSER"

# 环境变量
export DISPLAY=:0
export QT_QPA_PLATFORM=xcb
export QT_X11_NO_MITSHM=1
export LIBGL_ALWAYS_SOFTWARE=1

# 修复共享内存权限
echo "[startup] Fixing shared memory permissions..."
chmod 1777 /dev/shm /tmp
mkdir -p /tmp/.X11-unix
chmod 777 /tmp/.X11-unix
mkdir -p /var/log /var/run/dbus /run/dbus /var/lib/dbus
rm -f /run/dbus/pid /var/run/dbus/pid /tmp/.X0-lock /tmp/.X11-unix/X0 2>/dev/null || true

# 生成 dbus machine-id（容器内可能缺失）
if [ ! -f /var/lib/dbus/machine-id ] && command -v dbus-uuidgen >/dev/null 2>&1; then
    dbus-uuidgen > /var/lib/dbus/machine-id 2>/dev/null || true
    echo "[startup] Generated dbus machine-id"
fi
if [ ! -f /etc/machine-id ]; then
    cp /var/lib/dbus/machine-id /etc/machine-id 2>/dev/null || true
fi

# 检查 noVNC
NOVNC_DIR="/usr/share/novnc"
if [ ! -d "$NOVNC_DIR" ]; then
    echo "[startup] ERROR: noVNC not found"
    exit 1
fi
if [ -f "$NOVNC_DIR/vnc.html" ] && [ ! -f "$NOVNC_DIR/index.html" ]; then
    ln -s "$NOVNC_DIR/vnc.html" "$NOVNC_DIR/index.html"
    echo "[startup] Created index.html symlink"
fi

# XDG runtime
export XDG_RUNTIME_DIR=/tmp/runtime-appuser
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
chown $APPUSER:$APPUSER "$XDG_RUNTIME_DIR"

# 启动 dbus
echo "[startup] Starting dbus..."
dbus-daemon --system --fork 2>/dev/null || echo "[startup] WARNING: dbus system daemon failed, continuing"
sudo -u $APPUSER dbus-launch --sh-syntax > /tmp/dbus-env.sh 2>/dev/null || true
if [ -s /tmp/dbus-env.sh ]; then
    . /tmp/dbus-env.sh
    export DBUS_SESSION_BUS_ADDRESS
fi
echo "[startup] dbus started"

# VNC 密码（设置 VNC_PASSWORD 则启用 VncAuth，否则 None）
VNC_SECURITY="-SecurityTypes None"
if [ -n "$VNC_PASSWORD" ]; then
    mkdir -p "$APPUSER_HOME/.vnc"
    printf '%s\n' "$VNC_PASSWORD" | vncpasswd -f > "$APPUSER_HOME/.vnc/passwd"
    chmod 600 "$APPUSER_HOME/.vnc/passwd"
    chown $APPUSER:$APPUSER "$APPUSER_HOME/.vnc/passwd"
    VNC_SECURITY="-SecurityTypes VncAuth -PasswordFile $APPUSER_HOME/.vnc/passwd"
    echo "[startup] VNC auth: VncAuth"
else
    echo "[startup] VNC auth: None"
fi

# 启动 Xvnc（以 appuser 身份运行，无需 xhost）
echo "[startup] Starting Xvnc on display :0..."
sudo -u $APPUSER \
    DISPLAY=:0 \
    XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR \
    DBUS_SESSION_BUS_ADDRESS=$DBUS_SESSION_BUS_ADDRESS \
    Xvnc :0 \
        -geometry 1024x768 \
        -depth 16 \
        $VNC_SECURITY \
        -localhost yes \
        -rfbport 5900 &
XVNC_PID=$!
sleep 2
if ! kill -0 $XVNC_PID 2>/dev/null; then
    echo "[startup] ERROR: Xvnc failed to start"
    exit 1
fi
echo "[startup] Xvnc is running"

# 链接自定义菜单
CUSTOM_MENU="/app/config/openbox/menu.xml"
if [ -f "$CUSTOM_MENU" ]; then
    mkdir -p /var/lib/openbox
    ln -sf "$CUSTOM_MENU" /var/lib/openbox/debian-menu.xml
    echo "[startup] Custom menu linked to /var/lib/openbox/debian-menu.xml"
else
    echo "[startup] WARNING: Custom menu not found"
fi

# 启动 Openbox
echo "[startup] Starting Openbox as $APPUSER..."
sudo -u $APPUSER \
    DISPLAY=:0 \
    XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR \
    DBUS_SESSION_BUS_ADDRESS=$DBUS_SESSION_BUS_ADDRESS \
    QT_QPA_PLATFORM=xcb \
    QT_X11_NO_MITSHM=1 \
    LIBGL_ALWAYS_SOFTWARE=1 \
    openbox &
WM_PID=$!
echo "[startup] Openbox started with PID $WM_PID"

sleep 1
sudo -u $APPUSER openbox --reconfigure 2>/dev/null || echo "[startup] Openbox reconfigure skipped"

# 启动 noVNC
echo "[startup] Starting noVNC websockify on 0.0.0.0:6080..."
websockify --web "$NOVNC_DIR" 0.0.0.0:6080 localhost:5900 &
NOVNC_PID=$!

sleep 1
echo "[startup] ===== Desktop ready! ====="
echo "[startup] Connect via: http://host:6080/vnc.html"
echo "[startup] User: $APPUSER"

# 保持前台
wait
