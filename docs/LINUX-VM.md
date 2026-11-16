# A Linux VM as a bot's computer: Hermes's native path

For a Linux VM you don't need any kit plugin. Point the bot's terminal at the VM over SSH and Hermes
runs its own Bot Screen there: Xvnc + Xfce, `cua-driver` and a headed Chromium on the VM, streamed to
Hermes Desktop's Screen pane with Take over / Hand back. (For a Mac use
[remote-cua](../remote-cua/README.md).)

## Configure the bot's profile

```yaml
# <profile home>/config.yaml
terminal:
  backend: ssh
# bot_desktop.placement stays at its default (auto): with an ssh terminal the screen lives on the VM
```

```bash
# <profile home>/.env
TERMINAL_SSH_HOST=100.64.0.20
TERMINAL_SSH_USER=you
# optional: TERMINAL_SSH_PORT=22, TERMINAL_SSH_KEY=/path/to/key
```

Hermes connects with `BatchMode=yes`, so key auth must already work from the gateway host
(`ssh -o BatchMode=yes you@100.64.0.20 true`).

## Put the desktop stack on the VM

The packages from Hermes's Bot Screen doc (deliberately not the `xfce4` metapackage, whose screensaver,
power manager and polkit agent lock or prompt a headless desktop):

| Distro | Packages |
|---|---|
| Debian / Ubuntu | `tigervnc-standalone-server xfce4-panel xfwm4 xfdesktop4 xfce4-settings xfce4-terminal dbus-x11 x11-xserver-utils x11-utils xauth fonts-dejavu-core` |
| Fedora | `tigervnc-x11-server xfce4-panel xfwm4 xfdesktop xfce4-settings xfce4-terminal dbus-daemon xsetroot xset xdpyinfo xprop xorg-x11-xauth setxkbmap dejavu-sans-fonts` |
| Arch | `tigervnc xfce4-panel xfwm4 xfdesktop xfce4-settings xfce4-terminal xorg-xsetroot xorg-xset xorg-xdpyinfo xorg-xprop xorg-xauth xorg-setxkbmap ttf-dejavu` |

Also on the VM: `cua-driver` (Hermes's pinned version) and a headed Chromium, plus `bash`, `python3`,
`setsid`, `pgrep`. All of it must be reachable from a **non-interactive** SSH login: environment set
only in `.bashrc` or a Dockerfile `ENV` does not reach it, so put e.g. `PLAYWRIGHT_BROWSERS_PATH` in
`/etc/environment`. `hermes computer-use screen status` prints the exact install line Hermes wants.

Plan on roughly 1.1-1.5 GB of RAM per open screen with a browser.

## What you get

- The bot's `computer_use`, browser and shell all act on the VM, nothing on the gateway.
- Hermes Desktop's **Screen** pane, the Scheduled Jobs hero and the sidebar Screen box show the VM's
  bot desktop, with **Take over** / **Hand back** and the native `human_has_control` fence.
- **Open Screen when the bot uses it** (right-click the bot) works as documented.

What to know:

- The bot gets a **new** Xvnc desktop on the VM, not the VM's console display.
- The whole profile's terminal moves to the VM.
- Start the screen from the pane (**Start screen**) or `hermes computer-use screen start`; with an ssh
  terminal the first `computer_use` call brings it up on demand.

Details: Hermes's own docs, `website/docs/user-guide/features/bot-screen.md` ("Where the screen runs",
"The sandbox image") and `user-guide/configuration.md` ("SSH Backend").
