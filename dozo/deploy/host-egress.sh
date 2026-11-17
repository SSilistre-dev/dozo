#!/usr/bin/env bash
# Run once on the Docker host, as root, before bot computers are used (deploy.sh has to have copied
# the tree there first):
#   ssh <host> 'bash -s' < dozo/deploy/host-egress.sh
#   ssh <host> 'bash -s -- --remove' < dozo/deploy/host-egress.sh
# It installs upstream's restricted-egress rules for bot computers from the copied tree
# (docs/self-host-docker-computers.md) and adds the one case they do not cover: a host that is on a
# Tailscale network accepts forwarded traffic into it before Docker's DOCKER-USER chain is read, so
# a computer could reach that network's other devices. The extra rule sits in the mangle table,
# which is read before every filter chain, whatever their order. Without Tailscale it matches
# nothing. IPv4 only: computers with restricted egress have no IPv6.
set -euo pipefail

script=${DOZO_DEPLOY_DIR:-/opt/dozo}/src/infra/compose/restrict-computer-egress.sh
unit=dozo-computer-egress.service
rule='FORWARD -i rakazo-c+ -o tailscale0 -j DROP'

[ -r "$script" ] || {
  echo "missing $script: run dozo/deploy/deploy.sh first" >&2
  exit 2
}

if [ "${1:-}" = --remove ]; then
  bash "$script" --remove
  systemctl disable --now "$unit" 2>/dev/null || true
  rm -f "/etc/systemd/system/$unit"
  systemctl daemon-reload
  # shellcheck disable=SC2086
  while iptables -w 5 -t mangle -C $rule 2>/dev/null; do iptables -w 5 -t mangle -D $rule; done
  exit 0
fi

bash "$script"
cat >"/etc/systemd/system/$unit" <<EOF
[Unit]
Description=Keep Dozo bot computers off the host's Tailscale network
After=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'iptables -w 5 -t mangle -C $rule 2>/dev/null || iptables -w 5 -t mangle -I $rule'

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable "$unit"
systemctl restart "$unit"
echo "Computer egress: upstream rules and the Tailscale rule are in place."
