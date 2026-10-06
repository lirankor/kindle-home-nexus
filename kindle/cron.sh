#!/bin/sh
# Runs from /etc/crontab/root every minute: keeps nexus running unless disabled.
DIR=/mnt/us/nexus
[ -f $DIR/DISABLED ] && exit 0
up=$(cut -d. -f1 /proc/uptime); [ "$up" -lt 90 ] && exit 0
[ -f $DIR/nexus.pid ] && kill -0 $(cat $DIR/nexus.pid) 2>/dev/null && exit 0
/mnt/us/usbnet/bin/busybox sh $DIR/nexus.sh start >/dev/null 2>&1
