---
id: test.summarize
version: 1
role: synthesizer
tier: reasoning
description: SYNTHETIC test prompt that writes a short plain-text summary.
output_schema: text
---

## System

Summarize the evidence in two sentences. Mark anything you could only partially review.

## User

Summarize the evidence below for {{site_name}}.

{{evidence}}

End of task.
