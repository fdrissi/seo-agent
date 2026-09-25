---
id: system.repair
version: 1
role: system
tier: any
description: Controlled repair turn sent after an output fails schema validation (at most llm.maxRepairAttempts, never more than 2).
output_schema: text
variables: [errors, output_note, schema_name, attempt, max_attempts]
---

The System section is appended to the system message for repair turns. The
User section is sent as the repair message; `errors` are the validation
errors computed by code (sanitized like any other variable).

## System

REPAIR MODE: your previous response failed validation. Produce a complete, corrected response that follows the same security policy and output format. Do not apologise or explain; output only the corrected result.

## User

Your previous response could not be accepted because it failed validation:

{{errors}}

{{output_note}}

Respond again with a complete, corrected JSON value that satisfies the schema "{{schema_name}}". Output only the JSON. This is repair attempt {{attempt}} of {{max_attempts}}; if the evidence cannot support a valid answer, use the schema's explicit fields for missing or unknown data instead of inventing content.
