# Placeholder — Account Self-Management & Deletion

**Date:** 2026-06-02
**Status:** Placeholder / future ticket (not scheduled)
**Related:** `2026-06-02-user-central-tenant-rbac-design.md`

## Why this exists

The User-Central RBAC change draws a deliberate line between two operations that
the old model conflated under a single `user:delete` permission:

1. **Disassociation** — removing a user's role(s) within an org or project.
   This *is* in scope of the RBAC change, via the `membership:revoke` permission.
   Any org (Owner/Manager) or project (Project Manager) actor can disassociate a
   user from the scope they control. It deletes `user_roles` rows, never the
   account.

2. **Account deletion / self-management** — the account ultimately belongs to
   the **user**, and the user should control it. This is **not** implemented now.

## Scope of the future ticket

- A user can manage and delete **their own** account (self-service).
- Define the permission model for self-ownership (e.g. `account:delete` /
  `account:update`, self-only), distinct from org/project RBAC.
- Decide what happens to a deleted user's `user_roles` grants (cascade is already
  configured), authored content, and audit history.
- Surface the UI/endpoints for self-service account management.

## Not in scope of the future ticket

- Org/project disassociation (already delivered by `membership:revoke`).

This document is a placeholder so the deferred work is not lost. It carries no
implementation commitment.
