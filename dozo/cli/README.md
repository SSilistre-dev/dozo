# dozo command

Talk to your own bots from a terminal, through the bot API (`dozo/api/openapi.yaml`). One file,
`dozo.mjs`, Node 20 or later, no dependencies.

```
node dozo/cli/dozo.mjs login --server https://app.dozo.bot   # paste a token from Settings > Security > Access tokens
node dozo/cli/dozo.mjs bots
node dozo/cli/dozo.mjs send Chef "Plan dinner for four"
echo "Summarise today" | node dozo/cli/dozo.mjs send Chef
node dozo/cli/dozo.mjs export Chef --since 2026-11-01 > chef.md
```

- The server is `--server`, else `DOZO_SERVER`, else the last one logged in to, else the hosted one.
  Your own computer's server works over plain HTTP (`http://127.0.0.1:<port>`); anything else
  needs HTTPS, so a token never crosses a network unencrypted.
- The token is `DOZO_TOKEN`, else the one `login` saved in the system keychain (macOS Keychain, or
  libsecret's `secret-tool` on Linux; elsewhere use `DOZO_TOKEN`). `login` reads it without showing
  it and never passes it as a command argument. `~/.config/dozo/cli.json` keeps only the server.
- `send` prints the reply as it streams. When the bot stops to ask you (an approval, a question),
  it exits with 3 and prints the `dozo follow` command that picks the run up after you answer in
  the app. A dropped connection is followed again from the last event, never sent twice.
- Exit codes: 0 done, 1 error or the run failed or was stopped, 3 waiting for you, 130 stopped.

Tests: `node --test dozo/cli/dozo.test.mjs` (part of `make olc`).
