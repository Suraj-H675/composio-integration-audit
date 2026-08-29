# Research rubric

Rubric version: `2026-08-28.full-run.v2`  
Status: **frozen for the repaired full-run dataset**. This is an authorized holdout-discovered schema correction. New edge cases are logged and kept `unknown` when necessary; meanings are not silently redefined during migration.

## Change log

`v2 — holdout-discovered access-distribution and MCP-capability distinction.` The fixed holdout showed that one production-access field was mixing customer credential setup with public multi-customer distribution, and that official MCP existence was mixing product actions with documentation surfaces. The repaired schema adds `customer_credential_access`, `distributed_integration_access`, and `vendor_mcp_type`. The historical `credential_access` and `production_access` claims remain for comparison/backward compatibility; v2 analysis does not use them as headline dimensions.

This rubric is the contract for the 100-app audit. Each final field is a claim, not a free-form impression. Claims must be regenerated from current evidence and must retain a URL, source type, check time, retrieval method, supporting statement, and confidence.

## Identity

Identity is resolved before API or access claims are accepted. The resolver compares the app name with the assignment website/hint, category/context, vendor branding, documentation ownership, and product description. It records accepted and rejected candidates and the reason for each decision.

`identity.status` is one of `confirmed`, `probable`, `ambiguous`, or `unresolved`. A name match that conflicts materially with the assignment hint is `identity_hint_conflict` and requires deeper research or human escalation. An unresolved identity must not be used to make confident API, access, or buildability claims.

## Access and friction

These are separate dimensions:

- `credential_access`: the general credential path, one of `self_serve_free`, `self_serve_trial`, `self_serve_paid`, `approval_required`, `admin_required`, `partner_gated`, `unavailable`, `not_applicable`, or `unknown`.
- `customer_credential_access`: how a normal customer or administrator obtains credentials for their own account: `self_serve_free`, `self_serve_trial`, `self_serve_paid`, `admin_required`, `vendor_approval_required`, `partner_gated`, `unavailable`, `not_applicable`, or `unknown`.
- `sandbox_access`: the same enum, but only for test/development credentials or environments.
- `production_access`: the same enum, but only for live production credentials or environments.
- `distributed_integration_access`: whether a public, multi-customer integration can be distributed: `open_self_serve`, `app_review_required`, `partner_program_required`, `vendor_approval_required`, `enterprise_contract_required`, `customer_managed_only`, `unsupported`, `not_applicable`, or `unknown`.
- `commercial_friction`: `none`, `free_tier_limited`, `paid_plan_required`, `enterprise_plan_required`, `usage_pricing`, or `unknown`.
- `setup_friction`: `none`, `oauth_configuration`, `admin_configuration`, `app_review`, `merchant_underwriting`, `other`, or `unknown`.

Sandbox self-service never implies production self-service. A free trial is not permanent free access. Public documentation of an API does not prove that production credentials are self-serve. Pricing, plan limits, admin setup, and review requirements are recorded as friction; they do not by themselves make a technically implementable interface unbuildable.

`customer_credential_access` and `distributed_integration_access` answer different questions. A customer may self-serve credentials while public OAuth distribution requires app review or a partner program. Conversely, an administrator may create an internal integration without evidence that a platform can distribute a centrally registered integration. Neither field is inferred from the other, and sandbox availability cannot establish either one.

## API and webhooks

- `public_api_available`: `yes`, `limited`, `no`, or `unknown`.
- `api_styles`: any documented combination of `rest`, `graphql`, `grpc`, `websocket`, `rpc`, `sdk_only`, `webhooks_only`, `other`, or `unknown`.
- `api_breadth`: `broad`, `moderate`, `narrow`, `read_only`, `action_specific`, or `unknown`.
- `webhooks`: `yes`, `limited`, `no`, or `unknown`.

`api_breadth=broad` is invalid when `public_api_available=no`. A local CLI or SDK can have a limited/action-specific interface without being forced into SaaS API categories; auth and access are `not_applicable` when the product itself has no account credential model.

## MCP

MCP ownership and lifecycle are independent:

- `vendor_official_mcp`: `true`, `false`, or `unknown`. `true` requires first-party evidence that the vendor or official organization publishes/maintains the server.
- `vendor_mcp_type`: `product_action`, `documentation`, `developer_tooling`, `mixed`, `unknown`, or `not_applicable`. This describes what the official MCP actually exposes. `product_action` requires evidence of meaningful access to or operations on customer/product/workspace data; `documentation` is primarily vendor documentation and examples; `developer_tooling` is primarily build/platform tooling; `mixed` combines meaningful product actions with documentation or developer assistance.
- `vendor_mcp_stage`: `ga`, `public_preview`, `beta`, `eap`, `announced`, `deprecated`, or `unknown`.

An official server with no lifecycle label is `true` plus stage `unknown`. An official MCP with no functional evidence is `true` plus type `unknown`. A documentation-only MCP is still official, but is not counted as a product-action MCP. If `vendor_official_mcp=false`, type is `not_applicable`; if ownership is `unknown`, type is generally `unknown`. A community MCP is tracked separately as `community_mcp`; neither a community MCP nor a Composio toolkit proves vendor ownership.

## Technical buildability

`technical_buildability` answers: “Can a useful agent toolkit technically be implemented today using an available interface?”

- `yes`: a documented API, SDK, local tool, or official MCP can support a useful toolkit today.
- `limited`: the interface exists but its surface is intrinsically narrow, action-specific, read-only, or otherwise prevents a reasonably broad toolkit.
- `no`: the available interface cannot support a useful toolkit today.
- `unknown`: evidence is insufficient or identity remains unresolved.

OAuth setup, administrator configuration, production approval, paid plans, free-tier limits, app review, and usage pricing do not automatically downgrade `yes`. Use `main_blocker` to record the primary actual blocker only when one exists: `none`, `interface_limited`, `credential_access`, `commercial_friction`, `setup_friction`, `identity_unresolved`, `other`, or `unknown`.

## Evidence and verification

Source priority is: first-party developer/API/auth documentation; first-party product/help/announcement pages; official vendor GitHub; the current Composio catalog for the Composio field; and secondary sources only when primary evidence genuinely does not exist. Search snippets are discovery aids, never final support.

Retrieval is `http` by default. A targeted Playwright browser fallback is allowed only when HTTP is blocked, incomplete, JavaScript-rendered, or suspicious. The record preserves the retrieval method and any failed browser attempt.

Each claim has `status`: `supported`, `partially_supported`, `contradicted`, `unknown`, or `not_found`; and `confidence`: `high`, `medium`, `low`, or `unknown`. The deterministic validator checks enum values, evidence completeness, domain alignment, access separation, MCP ownership, buildability consistency, identity conflicts, and Composio contradictions before verification.

Composio coverage is a current catalog observation. It is not ground truth for vendor API properties and cannot establish vendor-official MCP. A toolkit alongside `technical_buildability=no` or `public_api_available=no` creates a warning requiring an explicit explanation, not an automatic overwrite.
