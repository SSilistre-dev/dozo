# Publish a self-hosted server through a Cloudflare Tunnel

Optional. Opens no inbound port and costs nothing (Cloudflare Tunnel is on every plan). You need a
Cloudflare account and a domain on it. The default install stays local-only.

Use a named tunnel, as below. Quick tunnels (`trycloudflare.com`) do not support Server-Sent
Events, which the app's live updates use, and cap in-flight requests at 200
([Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)).

## In the Cloudflare dashboard

1. Networking > Tunnels > Create Tunnel. Name it and create it.
2. Copy the tunnel token from the install command shown (the long value after `--token`). Do not
   run that command; the installer starts the connector for you.
3. Under Routes, Add route > Published application. Choose the hostname, for example
   `app.example.com`, and set the Service URL to `http://web:5173`. Never point it at `api` or
   port 3100.

## On the server

Next to `install-images.sh`, put `dozo-install-cloudflare.sh` and `dozo-docker-compose.cloudflare.yml`
(both in `infra/compose/`), then:

```bash
CLOUDFLARE_TUNNEL_TOKEN=<token> bash dozo-install-cloudflare.sh --hostname app.example.com
```

Without the variable the script asks for the token with a hidden prompt. Other flags
(`--prepare-only`, `--local`, `--pull-never`) go to `install-images.sh`.

It runs the normal installer, then writes to `.env` (mode 600) the token as `CLOUDFLARE_TUNNEL_TOKEN` and
the public origin: `RAKAZO_HOST`, `BETTER_AUTH_URL`, `WEB_ORIGIN` and `API_URL`. It installs the
overlay as `docker-compose.override.yml`, which the installer layers on its own, and starts the
stack. If you already have an override file, the script stops; add the `cloudflared` service from
the overlay to it instead.

When the tunnel shows Healthy, open `https://app.example.com`. Rerunning `install-images.sh` later
keeps the tunnel. Web still listens on `127.0.0.1:5173` for local use only.

Registration stays open to whoever reaches the address: set `SIGNUPS_ENABLED=false` or
`SIGNUP_ALLOWLIST` in `.env` before you publish if the server is private.
