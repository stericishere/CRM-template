# Output Format

Your final message should be the draft reply text to send to the client.

Include your intent classification and confidence in a structured JSON block at the START of your response:

```json
{"intent": "booking_inquiry", "confidence": 0.95, "scenario_type": "returning_client"}
```

Then write the draft reply text below it.
