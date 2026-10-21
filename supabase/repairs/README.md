# Google OAuth credential access hotfix and reconciliation checks

These are **local review artifacts only**. They have not been run against
Supabase. The hotfix is separate from migrations 007–011 and is intentionally
not assigned a migration number because the live migration history is
unreliable.

## Files

- `google_credentials_access_hotfix.sql` revokes browser-role access to
  `public.google_credentials`, removes its user-facing SELECT policy, and gives
  the server-only `service_role` the `SELECT`, `INSERT`, and `UPDATE` privileges
  used by `lib/google/auth.ts`.
- `../verification/security_reconciliation_preflight.sql` reports the current
  schema, exact routine signatures, effective ACLs, policies, triggers, and
  routine security metadata using read-only queries.
- `../verification/security_reconciliation_postflight.sql` returns explicit
  PASS/FAIL checks for the OAuth boundary and the broader application database
  requirements associated with migrations 007–011. A credential-only hotfix
  can pass the OAuth checks while broader checks correctly fail until the
  separately reviewed reconciliation is complete.

## Prerequisites before execution

1. Confirm the selected Supabase project/ref independently in the Dashboard.
2. Run the preflight script in a read-only SQL session and save its output.
   Confirm `public.google_credentials` has the expected columns and that
   `service_role` exists. Review all direct grants, effective privileges,
   role memberships, and policies; investigate any unexpected grant path.
3. Confirm the server helper still uses the server-only service-role client for
   credential reads, inserts, and updates. The current helper does so in
   `lib/google/auth.ts`; do not expose this client to browser bundles.
4. Confirm no other application path requires browser access to
   `google_credentials`. The proposed ACL is intentionally incompatible with
   browser reads and writes.
5. Establish a write freeze for Google OAuth credential mutations while the
   ACL change is being applied and verified. Coordinate any OAuth callback or
   token refresh traffic.
6. Confirm a recent backup or PITR restore point in Supabase Dashboard under
   **Database → Backups**. Record its timestamp and coverage. Supabase database
   backups do not include Storage API objects. For stronger recovery evidence,
   restore/clone to a separate project and verify the clone; do not infer
   restorability from a listed backup alone.
7. Obtain a reviewed recovery plan and explicit approval before executing the
   hotfix. This preparation task does not authorize execution.

The SQL is transactional and repeatable for the known table/policy. It fails
and rolls back if `anon` or `authenticated` retains effective table or column
privileges, or if required `service_role` privileges are absent. It does not
change credential rows. The policy removal is safe only if the application
continues to use the server helper; direct browser access will stop working.

## Proposed execution order

1. Capture and review preflight output. Independently reconcile actual migration
   history; do not infer application state from filenames or an empty ledger.
2. Verify the backup/PITR point and complete any desired isolated restore test.
3. During the agreed short write freeze, execute **only**
   `google_credentials_access_hotfix.sql` in the intended project. Do not run
   `supabase db push` and do not bundle this file with migrations 007–011.
4. Run `security_reconciliation_postflight.sql`; require PASS for the OAuth
   table/column checks, owner policy removal, and service-role helper rights.
5. Exercise Google OAuth callback and token refresh in a controlled test after
   the write freeze. This is a runtime check and is not performed by these SQL
   scripts.
6. Plan migrations 007–011 separately after reconciling their prerequisites,
   exact live definitions, and intermediate-state risks. Apply only reviewed,
   missing changes in a controlled order with a write freeze. These scripts do
   not claim that multiple migrations are atomic as a group.

Because the hotfix is standalone and not in `supabase/migrations`, record its
execution in the team's change log. Before adding a numbered migration later,
reconcile the actual live ACL state so the fix is not blindly replayed or
confused with migration history.

## Expected results and limits

- After the hotfix, `anon` and `authenticated` should have no effective table
  or column privileges on `google_credentials`; `service_role` should retain
  SELECT/INSERT/UPDATE required by the server helper.
- The postflight OAuth checks should all show PASS. A FAIL is a stop condition;
  investigate inherited memberships, extra column grants, or unexpected
  policies before proceeding.
- Broader checks may show FAIL until migrations 007–011 and any separately
  required grant corrections are reconciled. In particular, the exact live
  `match_syllabus_chunks` argument type/schema and its anonymous EXECUTE grant
  must be reviewed; this hotfix intentionally does not alter that RAG function.
- The SQL verifies catalog state, not a successful OAuth callback, token
  refresh, backup restoration, or full application workflow.
- The provenance postflight check assumes `source_chunk_ids` is a JSON array of
  UUID strings and `generation_config` stores `unit`/`topic` keys. Confirm the
  current application shape before relying on that check. Empty provenance is
  reported as acceptable legacy state; it is not upgraded or called grounded.
- The postflight function-owner check requires a trusted role with BYPASSRLS or
  superuser capability and status-column update permission. Verify the actual
  owner is the intended Supabase administrator role; do not change ownership
  blindly.

## Recovery

The hotfix changes grants and drops one policy, not data. If verification or
the server OAuth smoke test fails, keep browser access blocked and restore the
reviewed service-role grants only after identifying the exact missing server
operation. Do not recreate the broad `google_credentials_select_own` policy as
a quick rollback. If rollback is required, use a separately reviewed ACL/policy
recovery script based on captured preflight output and approved security
requirements. Test restoration on an isolated project first when possible.
