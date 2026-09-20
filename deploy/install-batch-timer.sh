#!/bin/sh
set -eu
install -d -m 755 /usr/local/lib/meme-backtesting
install -m 755 deploy/advance-batch.sh /usr/local/lib/meme-backtesting/advance-batch.sh
install -m 644 deploy/meme-backtest-batch.service deploy/meme-backtest-batch.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now meme-backtest-batch.timer
systemctl is-enabled meme-backtest-batch.timer
systemctl is-active meme-backtest-batch.timer
