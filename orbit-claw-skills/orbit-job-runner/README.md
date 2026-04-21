# orbit-job-runner

Claw-side cron tick for Phase 5 — Living Orbit. Polls Orbit's `/api/v1/jobs/claim`
every 15 minutes via a systemd timer, dispatches claimed jobs to the
matching SKILL wrapper, and reports back via `/api/v1/jobs/report`.

## What gets installed on claw

```
/home/sanchay/orbit-job-runner/
  run-once.sh                       — one-tick entry
  dispatchers/
    observer.sh
    enricher.sh
    meeting_sync.sh
    topic_resonance.sh
  orbit-job-runner.service          — systemd unit (oneshot)
  orbit-job-runner.timer            — fires run-once.sh every 15 min
```

systemd units go in `/etc/systemd/system/` (or `~/.config/systemd/user/`
for user-level scheduling). Enable + start:

```sh
# As sanchay user (not root) — user-level systemd:
mkdir -p ~/.config/systemd/user
cp orbit-job-runner.service orbit-job-runner.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now orbit-job-runner.timer
systemctl --user status orbit-job-runner.timer
```

## Env contract

`run-once.sh` reads `/home/sanchay/.orbit/env` (referenced by the
service unit). That file must export:

```
ORBIT_API_URL=https://orbit.example.com/api/v1
ORBIT_API_KEY=orb_live_...
ANTHROPIC_API_KEY=sk-ant-...        # for enricher / topic dispatchers
ORBIT_AGENT_ID=wazowski             # optional, default wazowski
```

## Control flow

1. `run-once.sh` POSTs `{agent, kinds}` → `/jobs/claim`.
2. Server atomically picks the oldest unclaimed job matching `kinds[]`.
3. If `{job: null}` — queue empty, exit 0.
4. Otherwise shell out to `dispatchers/<job.kind>.sh`, piping the
   payload in via stdin.
5. Dispatcher emits `{status: "succeeded"|"failed"|"retry", data: {...}}`.
6. POST `{job_id, status, result}` → `/jobs/report`.

## Why this shape

- **Plumbing only on claw.** Dispatchers do not contain business
  logic — they shell out to openclaw / the Haiku enricher / orbit-cli.
  All LLM calls happen inside the SKILL or script the dispatcher
  invokes, so the Anthropic budget stays on claw.
- **Never direct DB.** Every write is via Orbit HTTP (the `orbit-cli`
  tools the SKILLs use).
- **Fail open.** A missing dispatcher, missing `openclaw` binary, or
  failed LLM run is reported as `status:"failed"` — the job is done,
  the next tick picks the next work. No in-script retry loops.

## Deployment

```sh
# From the repo root on Mac:
rsync -avz --delete \
  orbit-claw-skills/orbit-job-runner/ \
  claw:/home/sanchay/orbit-job-runner/
ssh claw "chmod +x /home/sanchay/orbit-job-runner/run-once.sh \
                    /home/sanchay/orbit-job-runner/dispatchers/*.sh"
# Install + start the timer as above.
```
