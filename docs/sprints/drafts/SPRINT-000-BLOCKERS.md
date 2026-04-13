# Sprint 000 Blockers

## 2026-04-12

- `docker info` failed with `Cannot connect to the Docker daemon at unix:///Users/dave/.docker/run/docker.sock`, so the required Compose-based dynamic verification steps cannot currently run.
- `deno --version` failed with `deno: command not found`, so the Deno-based local verification steps cannot currently run.
- `git commit` is blocked by the sandbox because Git cannot create `.git/index.lock` in this environment, so the per-phase commit tasks in the sprint cannot be executed here even though file edits are still possible.
- The sandbox also rejects binding a local TCP listener (`listen EPERM` on `127.0.0.1`), which blocks transport-level local verification of the mock service outside Docker.
- Until Docker and Deno are installed and reachable, Sprint 000 execution is limited to static verification, file-shape validation, and non-Deno/non-Compose checks available in the local workspace.
