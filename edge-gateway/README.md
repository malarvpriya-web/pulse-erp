# Pulse Edge Gateway

The on-site agent for the IoT / Device Telemetry module. It runs at the customer
site (a small PC, industrial gateway, or Raspberry Pi), reads a deployed unit —
AHF / SVG / STATCOM — over **Modbus TCP**, and forwards the readings to Pulse's
device-token ingest endpoint over HTTPS. Pulse stays cloud-only; only this agent
speaks the field protocol.

It is **store-and-forward**: readings queue in memory and spool to disk, so a
network outage or a restart never drops data — the backlog replays on the next
successful connection.

## 1. Provision the device in Pulse

In Pulse, open **IoT Fleet → Fleet Monitor**, select the equipment, and click
**Provision device**. Copy the `device_uid` and the token shown — **the token is
displayed once and cannot be retrieved again.** (Lost it? Use **Rotate token**.)

## 2. Configure

```bash
cp config.example.json config.json
```

Edit `config.json`:

| field       | what to set |
|-------------|-------------|
| `ingestUrl` | your Pulse ingest URL, e.g. `https://pulse.<company>.com/api/v1/iot/ingest` |
| `deviceUid` | the `device_uid` from step 1 |
| `token`     | the token from step 1 |
| `pollSecs`  | how often to read the device (default 60) |
| `source`    | `sim` for a dry run, or `modbus` for real hardware (see below) |

**Simulator (no hardware)** — the default in `config.example.json`. Emits
realistic values so you can prove the whole pipeline before wiring a device.

**Modbus TCP (real hardware)** — set `source` to the `_modbus_source_example`
shape: `host`, `port`, `unitId`, and a `registers[]` map of Modbus address →
metric. Metric names should match what the dashboards chart (`thd_i`, `thd_v`,
`pf`, `kvar`, `temp`, …). Then install the optional driver:

```bash
npm install                 # sim mode needs nothing beyond Node ≥ 18
npm install modbus-serial   # only on sites with a real Modbus device
```

## 3. Run

```bash
node gateway.mjs                 # uses ./config.json
node gateway.mjs /etc/pulse/gw.json   # or an explicit path
```

You should see lines like:

```
2026-07-18T… pulse-edge-gateway starting · device PULSE-42-AB12CD · source sim · poll 60s
2026-07-18T… sent 5 sample(s) · accepted 5 · alerts 0 · 0 queued
```

Confirm the device flips to **online** with live readings in Fleet Monitor.

## 4. Run as a service

**systemd** (`/etc/systemd/system/pulse-edge.service`):

```ini
[Unit]
Description=Pulse Edge Gateway
After=network-online.target

[Service]
WorkingDirectory=/opt/pulse-edge-gateway
ExecStart=/usr/bin/node gateway.mjs /etc/pulse/gw.json
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now pulse-edge
journalctl -u pulse-edge -f
```

On Windows, wrap it with [nssm](https://nssm.cc/) or Task Scheduler (run at
startup, restart on failure).

## Notes

- The spool file `.spool-<deviceUid>.jsonl` holds unsent readings; it is safe to
  delete only when the gateway is stopped and you accept losing that backlog.
- `maxQueue` (default 50 000 samples) caps the spool so a long outage can't fill
  the disk — the oldest readings are dropped past the cap.
- A `401` means the token/`device_uid` is wrong; the agent holds data and keeps
  retrying, so fix `config.json` and it catches up automatically.
