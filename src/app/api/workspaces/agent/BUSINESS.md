# Business Context

Timezone: {{timezone}}

## Business Hours

{{#businessHours}}
{{#.}}
{{@key}}: {{open}} - {{close}}
{{/.}}
{{/businessHours}}
{{^businessHours}}
Not specified
{{/businessHours}}

## Appointment Reminders

{{#scheduledReminder.enabled}}
Reminders are enabled. A reminder is sent {{scheduledReminder.daysBefore}} day(s) before each appointment.
When booking an appointment, inform the client that they will receive a reminder.
{{/scheduledReminder.enabled}}
{{^scheduledReminder.enabled}}
Reminders are disabled.
{{/scheduledReminder.enabled}}
