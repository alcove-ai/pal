# Hosted Pulp Deployment Context

Hosted Pulp is a managed software package hosting service running on packages.redhat.com.
It serves RPM, Python, Maven, OSTree, and container content to Red Hat product teams
and external customers.

## Architecture

- Multi-cluster OpenShift deployment (primary + worker clusters)
- PostgreSQL (RDS) for metadata, S3 for artifact storage
- Redis for caching and task coordination
- Akamai CDN for content delivery
- CloudFront for select customer domains
- KEDA-based autoscaling for workers

## Upstream Components We Deploy

- **pulpcore** — Core framework (REST API, content app, tasking system)
- **pulp_rpm** — RPM content plugin (heavily used)
- **pulp_file** — File content plugin (heavily used)
- **pulp_container** — Container registry plugin
- **pulp_python** — Python package plugin
- **pulp_ostree** — OSTree content plugin
- **pulp_certguard** — Certificate-based access control
- **pulp-cli** — Command-line interface
- **pulp-openapi-generator** — Client bindings generator

## What Matters Most

1. **Security** — Any CVE, vulnerability, or auth bypass in upstream is critical
2. **Breaking API changes** — REST API surface changes affect all consumers
3. **Database migrations** — Schema changes require careful deployment coordination
4. **Content serving** — Bugs in content app or download paths affect 99.9% SLA
5. **Task system** — Worker/tasking bugs affect sync, publish, and repair operations
6. **Performance** — Regressions in sync speed, content serving, or DB queries

## What Is Less Relevant

- CI/CD pipeline changes in upstream repos
- Test-only changes (unless they reveal a bug)
- Documentation updates (unless API docs)
- Towncrier fragments and changelog management
- Cosmetic refactors with no behavioral change
- Changes to plugins we don't deploy (pulp_ansible, pulp_deb)
