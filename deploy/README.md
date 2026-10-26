# Deploying Cattery on Kubernetes

Two kustomize bundles:

| Path               | What it installs                                                                 | When                                      |
| ------------------ | -------------------------------------------------------------------------------- | ----------------------------------------- |
| `deploy/cluster/`  | The Agent Sandbox controller (version-pinned), the `cattery` namespace, and the backend's ServiceAccount and RBAC | Once per cluster, local development included |
| `deploy/`          | Cattery itself: one StatefulSet Pod with the backend and web containers, its Service, a Traefik Ingress, the skill library PVC and the config Secrets | To run Cattery in the cluster              |

`deploy/` does not include `deploy/cluster/`: it puts everything it applies in
the `cattery` namespace, which would move the controller out of its own.

```
deploy/
  cluster/
    kustomization.yaml    Agent Sandbox controller + namespace.yaml + rbac.yaml
    namespace.yaml
    rbac.yaml
  kustomization.yaml      namespace, Secrets, image names
  cattery.yaml            skills PVC, Service, StatefulSet (backend + web)
  ingress.yaml            Traefik Ingress for the app and preview hosts
  cattery.env.example     template for cattery.env (JWT_SECRET, DATABASE_URL)
```

## What you need

- A Kubernetes cluster with a default StorageClass. The manifests assume
  single-node volumes (`ReadWriteOnce`, e.g. local-path).
- Traefik as the ingress controller, with a certificate resolver named
  `cloudflare` (DNS-01, which can issue the wildcard certificate for previews).
- PostgreSQL 14+ outside the cluster, with an empty database for Cattery.
- A registry the cluster can pull from.
- DNS for two names pointing at the ingress: the app host (e.g.
  `cattery.example.com`) and a wildcard for app previews (e.g.
  `*.preview.example.com`).

## Install

**1. Cluster prerequisites.**

```bash
kubectl apply -k deploy/cluster/
```

```bash
kubectl get pods -n agent-sandbox-system
```

**2. Build and push the images.** The backend starts `cattery-pi` for every
project; the web image needs no build args, since it calls `/api` on its own
host.

```bash
docker build -t registry.example.com/cattery-backend:latest backend
docker build -t registry.example.com/cattery-web:latest web
docker build -t registry.example.com/cattery-pi:latest harnesses/pi
```

Push all three. Add `--platform linux/amd64` when building on an arm64 Mac for
an amd64 cluster.

**3. Replace the placeholders.**

| File                 | Change                                                                      |
| -------------------- | --------------------------------------------------------------------------- |
| `kustomization.yaml` | `images:`, the backend and web image names and tags                          |
| `cattery.yaml`       | `PI_IMAGE`, the pi image (kustomize's `images:` does not rewrite env vars)   |
| `cattery.yaml`       | `PREVIEW_URL`, the preview wildcard as a URL, e.g. `https://*.preview.example.com` |
| `ingress.yaml`       | Both hosts and both `tls.domains` annotations                               |

**4. Create the two config files** (both gitignored, turned into Secrets):

```bash
cp deploy/cattery.env.example deploy/cattery.env
```

```bash
cp backend/models.example.toml deploy/models.toml
```

In `cattery.env`, set `JWT_SECRET` (`openssl rand -hex 32`) and `DATABASE_URL`.
In `models.toml`, set each provider's endpoint, key and models.

**5. Apply.**

```bash
kubectl apply -k deploy/
```

On first start the backend creates an `admin` account and prints its password
once:

```bash
kubectl logs -n cattery sts/cattery -c backend | grep -i password
```

## Storage

- `cattery-skills-work` (10Gi) holds the global skill library, mounted into the
  backend at `/var/lib/cattery/skills` (`SKILLS_DIR`). It is declared in
  `cattery.yaml`; clusters that ran the retired skillmgr Pod already have it and
  keep their skills.
- Each project gets a `cattery-project-<id>-work` PVC, created by the backend
  and mounted as the agent's home. Deleting the project deletes it.

The backend runs as a single replica on purpose: it keeps per-project state in
memory, such as sandbox start-up and usage sync. The StatefulSet replaces its
Pod only after the old one is gone, so a `ReadWriteOnce` volume is never
claimed twice.

## Updating

- **Config:** edit `cattery.env` or `models.toml` and apply again. The Secret
  names carry a content hash, so the Pod restarts with the new values.
- **Backend and web:** push new images and run
  `kubectl rollout restart -n cattery sts/cattery`, or apply new tags.
- **pi:** push a new image. Running project Pods keep their image until they
  are recreated, so delete a project's `cattery-sandbox-<id>` Sandbox (its PVC
  stays) to move it to the new one; opening the project brings it back.

Changes that need a migration (old Pod layouts, the retired filemgr and skillmgr
Pods) are described in the main [README](../README.md).
