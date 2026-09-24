# @kyrn/channels

mu's built-in chat channels. Each conversation in a chat app becomes its own mu session, with mu's judgment layer loaded as in the terminal; what a session wants to ask (a permission, a choice) is asked in the chat.

- `src/host/`: the generic part. It opens a mu session per conversation through pi's public SDK (`createAgentSessionServices`, `createAgentSessionFromServices`), keeps them in a pool (idle reclaim, a cap, least recently used first), and bridges `ctx.ui.select` / `confirm` / `input` to the chat. It also covers the `mu.json` store, a redacting logger, pairing and one-off isolated prompts. Nothing in pi is changed for it.
- `src/qqbot/`: the QQ Bot channel, `mu qqbot`, ported from [tencent-connect/openclaw-qqbot](https://github.com/tencent-connect/openclaw-qqbot) (MIT, see [LICENSE.openclaw-qqbot](LICENSE.openclaw-qqbot)). The QQ side is the original's code with its comments; `mu 适配` and `mu 修正` mark what was changed and why.
- `skills/`: skills loaded into QQ sessions only.

Using it: [docs/qqbot.md](../../docs/qqbot.md). What is verified and how: [docs/qqbot-acceptance.md](../../docs/qqbot-acceptance.md).

```bash
npx vitest --run     # in this folder: unit and end-to-end tests against a local fake QQ Open Platform and a fake model
```

The npm package carries it as `channels/dist/qqbot.js` (built by `kyrn/npm/build.mjs`).
