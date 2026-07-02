# Reporting Service POC — Mike Cote's proposal

> Part of the multi-tenant reporting service POC. See also:
> [Architecture & behavior](./architecture.md) · [Options, decisions & open questions](./decisions.md) ·
> [Runbook](../README.md).
>
> **Status:** Proof of concept on a private branch. **Not for merge to `main`.** The goal is to
> prove the core idea works locally so the team can see it run, ask questions, and make decisions.
> It is intentionally incomplete — see [Options, decisions & open questions](./decisions.md).

> **Source:** Mike Cote's Google Doc, [*"Multi-Tenant Reporting Service"*](https://docs.google.com/document/d/19TjvWwLG4Wtq_xJQmzpGyjdqpKkHaGTx-_15DHaAmVw)
> status "Under review". Tracking epic: `elastic/kibana-team#1847` (Scheduled reporting in
> Serverless). A local, annotated copy lives outside this branch (kept local, not pushed).

Kibana relies on Chromium to render PNG/PDF reports. Running a browser server-side is the only
reliable way to capture complex dashboard layouts, inject styling, and render every vis type —
but it is expensive and risky. Mike's proposal is to extract that into a standalone,
multi-tenanted **Reporting Service**.

**Problems it solves**

1. **Reporting is disabled in Serverless.** Chromium's CPU/memory cost, multiplied across every
   single-tenant project, hurts margins too much to enable it everywhere.
2. **Poor security posture.** Chromium is a large, frequently-CVE'd attack surface. Hosted/ECH
   customers run old Kibana versions with outdated Chromium, and the current RCE-patch process is
   "non-standard, arduous, and fragile."
3. **Maintenance burden.** Keeping Kibana + Puppeteer/Playwright compatible with a specific
   Chromium DevTools Protocol version is brittle.

**The proposal**

Build a multi-tenanted Reporting Service that encapsulates Chromium + its automation layer,
fully decouples rendering from Kibana, and exposes a **stable, versioned HTTP API**. When a
reporting task runs, Kibana sends an HTTP request containing everything needed to navigate and
capture; the service manages Chromium and returns the artifact.

```
Kibana (reporting task)
  └─ HTTP request → Multi-Tenant Reporting Service
                       ├─ spawns / manages Chromium
                       ├─ renders the page
                       └─ returns artifact bytes (or a reference)
```

**Key benefits Mike calls out**

- **Operational efficiency** — background task pods no longer carry Chromium's CPU/RAM.
- **Improved security** — Chromium isolated in a hardened, containerized runtime (sandbox on,
  root dropped, seccomp, no shared mounts, strict egress network policy).
- **Patch velocity** — CVE fixes ship by updating one service image, *without* redeploying every
  Kibana. This is the big win for Hosted/ECH.
- **Future-proofing** — the DevTools automation is decoupled from Kibana versions.

**Shape of the service (Mike's sizing)**

- Lightweight API server routes each request to a free worker, returns `429` if none are free,
  and exposes a **status endpoint** so callers don't hold a connection open.
- ~200 reports/hour today (ECH + on-prem), ~30s each; ~800/hour at 4× spike. A 2GB worker does
  ~2 reports/min → ~**8×2GB workers** + 2×1GB API nodes. Est. **~\$200/month**.
- Deploy as a **K8s Deployment per cloud provider** with an **HPA**.

**Alternatives Mike considered and set aside**

| Alternative | Why set aside |
|---|---|
| Bump Serverless background nodes to 2GB | Fastest, but raises COGS and doesn't fix security |
| Dedicated reporting nodes in Serverless | Scales independently, but same CVE/patch problem |
| Reuse Synthetics | Unlikely to speed time-to-market; misaligned with purpose-built direction |
