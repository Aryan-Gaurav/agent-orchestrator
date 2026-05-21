# Design Doc

Some intro text.

## Auth Flow

Users log in with email + password. We never store passwords; we use a
one-way bcrypt cost factor 12 hash. Sessions expire after 24 hours.

## Data Retention

User records are retained for 90 days after account deletion. Audit logs
are retained for 7 years per compliance requirements.

## Overview Notes

Additional context about the system overview.
