# High Level Design

## Service Boundaries

<!-- ref: design.md#auth-flow claim="bcrypt cost factor 12" -->

The AuthService owns password hashing (bcrypt cost 12, per design) and
session token issuance.

## Other Boundaries

No upstream citations here.
