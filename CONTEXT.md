# Fluent API

Domain language for the Fluent API service (single-context repo).

## Language

**Transactional email**:
Email sent to an individual user in response to an account action — password reset, 2FA OTP, magic-link invite, org invite. Distinguished from marketing/bulk email, which this service does not send.
_Avoid_: notification email (broader — includes in-app and push notifications), system email
