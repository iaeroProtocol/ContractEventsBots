# PermalockVault Event Alert Bot

Watches the PermalockVault contract on Base and posts **all events** to **Telegram** and **Discord**.

## Features
- WebSocket live subscription + startup backfill
- Decodes all events present in ABI (fallback prints topic/data)
- Explorer links, timestamp, pretty args
- Telegram bot + Discord webhook support
- Docker-ready

## Setup

1) Copy env and fill:
```bash
cp .env.example .env
# edit .env with your RPC, vault address, bot/webhook config

