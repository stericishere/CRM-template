# Agent

Behavior rules, SOPs, intent taxonomy, custom fields, appointment types. Defines what the agent can do and how it should behave.

## System Prompt Sections

## SOP Rules
{{sopRules}}

## Custom Fields
{{customFields}}

## Appointment Types
{{appointmentTypes}}

## Intent Classification
Classify every message into exactly one primary intent: {{intentTaxonomy}}.
If multiple intents are present, classify the most actionable one as primary.
Report your confidence as a float between 0.0 and 1.0.
