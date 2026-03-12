# MAC (your local machine) — use these for normal VM workflow

cd "/Users/johnnynohra/Documents/New project"

pnpm infra:down
pnpm env:pull
pnpm env:check

pnpm infra:vm:up

# ssh if on mobile 
ssh -N -g \
  -L 0.0.0.0:3001:127.0.0.1:3001 \
  -L 0.0.0.0:6432:127.0.0.1:5432 \
  -L 0.0.0.0:6379:127.0.0.1:6379 \
  jmn6554@192.168.2.24

# ssh if on simulator
pnpm infra:vm:tunnel

# new terminal
LOCAL_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:6432/messaging_mvp pnpm db:migrate:dev

# or mobile
pnpm --filter @mvp/mobile dev:lan
# new terminal
pnpm ui:host:simulator

# new terminal
pnpm infra:vm:logs

# optional DB access from Mac (through tunnel)
psql "postgresql://postgres:postgres@127.0.0.1:6432/messaging_mvp"

# through VM
psql "postgresql://postgres:postgres@127.0.0.1:5432/messaging_mvp"

# when done
pnpm infra:vm:down

# LINUX VM (after ssh) — use these only when inside the VM

ssh jmn6554@192.168.2.24
cd /home/jmn6554/projects/suivo

docker compose -f docker-compose.dev.yml ps
docker compose -f docker-compose.dev.yml logs -f postgres redis api worker

# DB access on VM (no tunnel here)
psql "postgresql://postgres:postgres@127.0.0.1:5432/messaging_mvp"

# migrations on VM (if running pnpm on VM directly)
LOCAL_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/messaging_mvp pnpm db:migrate:dev
