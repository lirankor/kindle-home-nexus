# Kindle 4 client

Runs on a jailbroken Kindle 4 NT (firmware 4.1.4) with NiLuJe's USBNetwork installed
(provides SSH and a modern busybox at `/mnt/us/usbnet/bin/busybox`).

Install: copy this folder to `/mnt/us/nexus/` on the Kindle, set `BRIDGE_URL` in `config`,
then add to `/etc/crontab/root` (rootfs must be remounted rw):

    * * * * * /bin/sh /mnt/us/nexus/cron.sh

`nexus.sh start|stop|restart|status` (run with `/mnt/us/usbnet/bin/busybox sh`).
While running it stops the Kindle reader framework, reads the hardware buttons from
`/dev/input/event0` (keypad) and `event1` (5-way), sends each press to the bridge as
`GET /key/<name>` and draws the returned PNG with `eips -g`. Idle refresh every
`POLL_SECONDS`. Create `/mnt/us/nexus/DISABLED` to keep it from autostarting.

Button map: 5-way = up/down/left/right/select, upper side buttons = prev tab,
lower side buttons = next tab, Back = escape, Menu = menu, Home = home, keyboard = keyboard.
