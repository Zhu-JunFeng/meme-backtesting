#!/bin/sh
set -eu
install -d -m 750 /opt/meme-operations /run/meme-operations
install -m 640 deploy/operations-host.py /opt/meme-operations/operations-host.py
install -m 644 deploy/meme-operations.service deploy/meme-operations.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now meme-operations.timer
systemctl start meme-operations.service
