# RBAC Architecture & Authorization Plan

This document outlines the conceptual blueprint for our new User-Central (Grant-Based) RBAC system. It is designed to explain the logical structure, database relationships, and authorization flow without relying on code-level implementation details.

---

## 1. The Core Objective
We are transitioning from a rigid "Organization-Central" permission system to a flexible "User-Central" (Grant-Based) RBAC architecture.

**The Problem:** The old system restricted a user to having only a single role within a single organization. A user could not be a Project Manager on one project and a Translator on another.
**The Solution:** We decoupled roles from the core user profile. Instead, users receive specific "Grants" (e.g., "Role: Translator, Project: Alpha"). A user can hold unlimited grants across multiple projects and organizations simultaneously.

---

## 2. Logical Data Architecture

The system transitions away from storing a single role on the user profile. Instead, it uses a relational "Grants" structure.

### The Core Entities
1. **Roles:** A list of job titles (e.g., 'Project Manager', 'Project Translator').
2. **Permissions:** A list of specific granular actions a user can take (e.g., 'Update Project', 'View Content').
3. **Role-Permission Mapping:** A static configuration that defines exactly which specific permissions belong to which job titles.
4. **The Grants Ledger:** This is the core engine. A single entry here represents one "Grant". It links a User to a specific Role, and explicitly scopes that role to either a specific Organization or a specific Project.

**How they connect:** 
When a user logs in, the system checks the Grants Ledger to find all the roles assigned to them. It then gathers the exact set of permission capabilities the user possesses for every specific organization or project they are involved in.

### The Principle of Cascading Authorization
A critical concept in this new architecture is **hierarchical scope**. 
* **Top-Down Power:** If a user receives a Grant at the **Organization Level** (e.g., Org Manager), the permissions in that grant automatically cascade down to *every single project* within that organization. The system inherently trusts them across the entire org.
* **Bottom-Up Restriction:** If a user receives a Grant at the **Project Level** (e.g., Project Manager on Project A), their power is strictly contained within the walls of Project A. They cannot see or manage Project B, even though both projects belong to the same organization.

---

## 3. Standard Roles & Capabilities

Based on our organizational requirements, we have established 6 distinct roles. 

### SuperAdmin & Org Owner
Has unrestricted access to the entire system (or their specific Organization).
* **Projects:** Can View, Create, Update, and Delete.
* **Content:** Can View, Assign, and Update.
* **Team:** Can View, Create, Update, and Delete users. Can assign any roles (including other managers).

### Org Manager
Can manage projects, content, and users within their organization, but cannot delete users or assign top-level Owner/Manager roles.
* **Projects:** Can View, Create, Update, and Delete.
* **Content:** Can View, Assign, and Update.
* **Team:** Can View, Create, and Update users. Can assign project-level roles.

### Project Manager
Has full control, but it is strictly limited to the specific project(s) they are assigned to manage.
* **Projects:** Can View, Create, Update, and Delete.
* **Content:** Can View, Assign, and Update.
* **Team:** Can View, Create, Update, and Delete users. Can assign project-level roles.

### Translator
Can view their assigned project and draft/edit the specific chapters assigned to them.
* **Projects:** Can View.
* **Content:** Can View, and can Update (only if specifically assigned to the content).
*(Note: Translators can inherently view and update their own personal profiles, but cannot view or edit other users).*

### Observer (Reporting)
Read-only access to view a project, its content, and its users.
* **Projects:** Can View.
* **Content:** Can View.
* **Team:** Can View.

---

## 4. The 4-Layer Authorization Flow

When a user attempts to perform an action (like editing a project), the system verifies their access through four conceptual security layers:

### Layer 1: Authentication & Grant Loading
When a request arrives, the system validates the user's identity. During this step, it looks up the user in the Grants Ledger and securely attaches all of their associated grants (keys) to their current session. 

### Layer 2: The Coarse Gatekeeper
Before allowing the request to proceed, the system checks if the user possesses the baseline permission required for the action *anywhere* in their grants. 
* *Example:* If a user is trying to "Update Content", the system checks if they have the "Content Update" permission. If they don't have this permission in *any* capacity, they are instantly rejected. This saves processing power.

### Layer 3: Domain-Specific Guards
While Layer 2 ensures the user has the right permission *somewhere*, it doesn't know *which* specific project the user is trying to edit. 
The Domain Guards step in to:
1. Extract the specific resource the user is asking for (e.g., Project Alpha).
2. Fetch that resource's details from the database (e.g., to find out that Project Alpha belongs to Organization X).
3. Securely pass the user and the resource details to the final policy layer.

### Layer 4: Granular Policy Execution
This is where the final decision is made. The system compares the user's grants against the specific resource they are trying to modify.

1. It searches the user's grants for the required permission (e.g., "Update Project").
2. It checks the *scope* of that grant:
   - Does the grant give them permission explicitly for **Project Alpha**?
   - Or, does the grant give them sweeping Org-wide permission for **Organization X** (which Project Alpha belongs to)?
3. If a matching scope is found, the action is approved.

### Unique Edge Cases Handled
* **Self-Service:** A user is always allowed to view or update their *own* personal profile, bypassing the need for explicit organizational permissions. This allows users to manage their own settings without needing administrative rights.
* **Strict Assignment Checking (The "Double Lock"):** For Translators, simply having the "Update Content" permission in their Project Grant isn't enough to let them edit any chapter they want. The final policy layer acts as a "double lock." It explicitly checks the database to ensure the specific chapter they are trying to edit is assigned directly to their name. If they are assigned to Chapter 1, they cannot edit Chapter 2, even though they are a Translator on the project.

---

## 5. The Transition & Migration Strategy

Moving from the legacy system to this new granular architecture requires a careful transition to prevent users from losing their access. 

**Phase 1: Automated Data Porting**
When the new system goes live, an automated script will read the old legacy database and translate the rigid data into the new Grants Ledger.
* **Administrators & Managers:** Users with high-level legacy roles (Org Owners, Org Managers, Project Managers) will automatically receive **Organization-Level Grants**, ensuring they retain their sweeping control over their respective orgs.
* **Translators & Observers:** Users with restricted legacy roles will have their database history analyzed. The script will look at which specific projects they were working on and issue them precise **Project-Level Grants** for those specific projects only. 

**Phase 2: Legacy Decommissioning**
Once the new Grants Ledger is fully populated and the system is verified to be operating securely, a final cleanup phase will permanently delete the old, rigid role columns from the database, finalizing the transition to a purely User-Central architecture.
