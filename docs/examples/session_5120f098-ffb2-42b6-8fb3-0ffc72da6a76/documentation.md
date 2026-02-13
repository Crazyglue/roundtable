# System Design

## Executive Summary
The proposed distributed batch workload platform is governed by a layered control plane comprising a tenant-facing API/auth+quota layer, a stateless scheduler, an execution controller, and a staging/telemetry mesh. We enforce tenant isolation and cost controls through quota-aware scheduling (refusing submissions once usage or projected cost hits ≥90%), per-tenant namespaces with signed URLs for data staging, and token-bucket throttles to prevent storage bursts. The execution controller orchestrates MPI/Ray/Julia runtimes, maintains checkpoints for idempotent retries, and enforces heartbeats to detect node churn. A log relay and telemetry bus deliver progress/log streams within 5 seconds, while retries rely on durable digests to eliminate duplicate outputs. Implementation will follow the council-approved phased rollout with accompanying verification suites.

## High-Level Plan
1. **Layered Control Plane:** Tenant API/Auth+Quota service → stateless scheduler with optimistic per-tenant queues and 30s etcd leases → execution controller (sole job-state mutator) → staging/telemetry mesh.
2. **Scheduler Guards:** Cache quotas/costs (5s TTL), reject jobs once current + estimate ≥90% quota or projected cost breaches the tenant’s budget, and issue leases describing node pool/resource bundle within 2 seconds. Provide /v1/nodepools capacity view for ETAs when resources are scarce.
3. **Controller Coordination:** Maintain job state machine (PENDING→STAGING→RUNNING→COMPLETED/FAILED), manage heartbeat (every 5s, trigger recovery/fail within <10s of two misses), enforce checkpoint-driven retries (default 3 attempts, exponential backoff), and prevent duplicate artifacts via digest verification.
4. **Data & Telemetry Mesh:** Agents stage inputs via signed URLs from per-tenant namespaces, throttle transfers against storage quotas with spill-to-disk fallback for bursts, stream logs/progress via gRPC relay (≤5s latency), and feed telemetry dashboards/alerts while writing to durable storage for replay.
5. **Multi-node Coordination:** Controller-held leases lock node lists; runtime adapters register nodes, and node loss triggers restart paths when checkpoints exist or a controlled retry/failure with audit logs when budgets are exhausted.

## Acceptance Criteria
1. Scheduler responds within 2 seconds with placement or quota rejection once tenant usage or projected cost reaches ≥90%.
2. Execution controller detects heartbeat loss within 10 seconds and resolves the retry/failure decision within the job’s expected duration, ensuring no duplicate outputs through checkpoint verification.
3. Telemetry streams (logs/progress) reach tenants within 5 seconds of agent emission via the relay.
4. Tenant staging throughput stays within quotas while collectively harnessing ≥70% of NIC capacity without oversubscription.
5. CI/chaos suites verify quota breaches, heartbeat loss, node failures, and checkpoint deduplication before progressing through rollout phases.

## Implementation Plan
- **Phase 1:** Release API/auth service, quota accounting, and the stateless scheduler backed by per-tenant optimistic queues and quota/cost cache (TTL=5s). Connect to a single node pool to validate placement latency, quota rejection (>90%), and /v1/nodepools ETA reporting.
- **Phase 2:** Deploy the execution controller, runtime agents, and staging/log mesh. Validate heartbeat handling, retry budgets, checkpoint idempotency, signed URLs, and ≤5s telemetry latency.
- **Phase 3:** Introduce telemetry dashboards, retry/idempotency validations, high-throughput staging quotas, and failure monitoring (quota drift alerts, node pool exhaustion/backpressure, staging circuit breakers, retry storm detection).
- **Phase 4:** Enable multi-node runtimes (MPI/Ray/Julia), auto-scale node pools, alerts for heartbeat/quota violations, and CI chaos tests covering quota breaches, heartbeat loss, and node failures.

Verification suites simulate quota breaches, heartbeat failures, node churn, and duplicate-output attempts to prove acceptance gates prior to each phase.

## Technology Decisions and Tradeoffs
- **Stateless Scheduler:** Enables horizontal scalability but requires strict caching controls (TTL=5s) and fallback requeue/backoff behavior when controller leases lapse. It uses 30s etcd leases (renewal required within 25s) to tie placements to node pools.
- **Quotas & Cost Controls:** Cache-driven quota and cost accounting enforce admission gates at 90% usage or projected monthly spend breaches, avoiding tenant overcommitment while keeping rejection latency low.
- **Execution Controller as Sole Mutator:** Guarantees consistent state transitions, retry budgeting (max 3 attempts with exponential backoff), checkpoint/digest verification for idempotency, and heartbeat-based failure detection without race conditions.
- **Data/Telemetry Mesh:** Per-tenant namespaces and signed URLs isolate inputs, token-bucket throttles plus spill-to-disk safeguard quotas, and log relays provide the required ≤5s progress visibility, accepting additional complexity for throughput assurances.
- **Multi-node Coordination via Controller Lease:** Ensures consistent node lists but requires tight heartbeat monitoring (<10s) and checkpoint-aware recovery to avoid duplicate artifacts or hung runs.

## API and Control Surface
- **REST + gRPC Endpoints:**
  - `POST /v1/jobs` – Submit jobs with `{tenantId, spec, inputRefs, priority, estimateCores, expectedRuntime, costEstimate}`.
  - `GET /v1/jobs/{id}` – Retrieve job metadata and status.
  - `DELETE /v1/jobs/{id}` – Cancel jobs.
  - `POST /v1/jobs/{id}/retry` – Trigger manual retries if retry budget remains.
  - `GET /v1/jobs/{id}/logs?tail=10s` – Stream logs tail.
  - `GET /v1/nodepools` – Inspect node pool capacity/ETA for scheduler stall transparency.
- **Streaming & Events:**
  - Tenant-specific WebSocket or gRPC event streams deliver progress/log events within 5 seconds.
- **Control Services:**
  - Tenant auth/quotas service manages compute/storage/egress budgets.
  - Scheduler publishes placements to controller topic; controllers acknowledge via leases and state store writes.

## Data and State Model
- **Persistent Job Store (Strongly Consistent):**
  - Schema: `{jobId, tenantId, status, placementLeaseId, checkpoints[{digest, uri, timestamp}], costEstimate, nodePoolId, retryCount, expectedRuntime}`.
  - Retry budget and checkpoint metadata stored atomically to avoid duplicate execution.
- **Quotas & Cost Cache:**
  - TTL=5s caching layer reflecting compute cores/GPUs/storage/egress usage plus projected costs.
  - Eviction/reconciliation triggers alerts when drift exceeds 10%.
- **Leases & Placements:**
  - Etcd-backed 30s leases record nodePoolId, resource vector, expected runtime, priority.
  - Controller must renew leases within 25s; missed renewals cause scheduler to requeue (exp backoff up to 3 attempts) and report ETA to tenants.

## Known Risks and Mitigations
- **Risk:** Quota cache drift causes incorrect admission decisions.
  - **Trigger:** Cache lag or reconciliation delay pushes drift above 10%.
  - **Impact:** Jobs may be over-admitted or incorrectly rejected.
  - **Mitigation:** Reconciliation alerts, forced cache refresh, and conservative admission fallback.
- **Risk:** Lease churn or lease-store instability creates placement flapping.
  - **Trigger:** Missed 25s renewal threshold or lease backend instability.
  - **Impact:** Jobs bounce between queues, increasing latency and cost.
  - **Mitigation:** Exponential backoff requeue, bounded retries, ETA surfacing, and control-plane SLO alerts.
- **Risk:** Retry storms under partial infra failure.
  - **Trigger:** Correlated node failures or transient staging outage.
  - **Impact:** Cluster saturation, delayed recovery, and budget burn.
  - **Mitigation:** Retry budgets (max 3), controller mutex, circuit breakers, and staged autoscale with backpressure.
- **Risk:** Duplicate artifact emission during recovery paths.
  - **Trigger:** Replayed retries after uncertain completion.
  - **Impact:** Data integrity issues and downstream confusion.
  - **Mitigation:** Checkpoint digest verification and atomic completion-state writes before success publication.
- **Risk:** Telemetry relay degradation breaks progress/log SLOs.
  - **Trigger:** Relay backlog under high fan-out or regional impairment.
  - **Impact:** Tenant visibility delays and weaker incident response.
  - **Mitigation:** Durable buffering, replay paths, saturation alerts, and load-shedding policies.

## Failure Handling and Operations
- **Heartbeat Monitoring:** Agents send heartbeats every 5s; two consecutive misses (<10s) trigger controller retries or failures within the expected job duration window while updating alerts.
- **Retry Control:** Execution controller enforces 3 attempts per job with exponential backoff; checkpoints verified (digest vs stored) before completion to prevent duplicate outputs. Manual retries increment retry budget via API.
- **Quota Drift Detection:** Periodic reconciliation detects >10% usage divergence, triggering alerts and cache refreshes.
- **Node Pool Exhaustion:** Auto-scale requests plus backpressure feedback to tenants via `/v1/nodepools` and scheduler ETA signaling.
- **Staging Saturation:** Token-bucket throttles tied to tenant quotas, with spill-to-disk fallback when bursts exceed 120%. Circuit breakers pause staging when saturation persists.
- **Retry Storms:** Controller mutex and retry budget prevent runaway retries; alerts fire when retries approach limits.
- **Telemetry:** Log relay buffers events to durable storage for retries/replays when saturation occurs while ensuring ≤5s delivery.

## Rollout Plan
1. **Phase 1:** Launch API/auth/tenant quotas and stateless scheduler with a single CPU-oriented node pool. Validate placement latencies (<2s), quota enforcement (reject ≥90%), and /v1/nodepools ETA communication.
2. **Phase 2:** Deploy execution controller, runtime agents, staging service, and log relay. Validate heartbeats, retries/checkpoints, signed URL staging, and ≤5s telemetry delivery.
3. **Phase 3:** Introduce telemetry dashboards, idempotency validation (checkpoint digests), high-throughput staging quotas, and monitoring/alerting for quota drift, node pool exhaustion, staging saturation, and retry storms.
4. **Phase 4:** Scale to multi-node runtimes (MPI/Ray/Julia), enable autoscaling for node pools, activate alerts for heartbeat/quota failures, and run CI/chaos tests covering quota breaches, heartbeat loss, node failure, and duplicate-output prevention.

Each phase requires CI verification that simulates quota breaches, heartbeat disruption, node failure, and checkpoint deduplication before advancing to the next.
