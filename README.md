# OpenClaw Feishu/Lark

Official OpenClaw channel plugin for Feishu and Lark workplace chats. Community maintained by @LucienShui.

This plugin is not published to the `@openclaw/feishu` registry. Build the local checkout, then link it into OpenClaw:

```bash
cd /path/to/openclaw-feishu-plugin
npm ci
npm run build
openclaw plugins install --link "$PWD"
```

`openclaw plugins install --link` only links the checkout; it does not build it. After changing source files, run `npm run build` before restarting the OpenClaw Gateway.

Configure the Feishu/Lark app credentials in OpenClaw, then connect the plugin to the chats where agents should receive and send messages.
