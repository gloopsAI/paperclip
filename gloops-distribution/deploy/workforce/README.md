# Durable Buzz-linked Paperclip roster

Buzz owns each enrolled agent's public identity and conversation. Paperclip owns
the durable work route behind that identity. The manifest in
`durable-buzz-roster.json` pins the eight work agents to the Luna/Terra bench;
it does not create replacement Buzz identities and it does not establish a
standing Codex or Grok burst route.
Each route is bound to the exact Paperclip agent UUID and enrolled Buzz public
key; a display-name match alone is never authority to repin an agent.

The migration fails closed if an identity is missing or running. It first emits
a network-free plan from an operator-supplied Paperclip agent snapshot:

```sh
python3 durable_buzz_roster.py --agents-json /safe/path/agents.json
```

Apply mode accepts the Paperclip bearer token only through an already-open file
descriptor. Never put the token in argv or an environment variable:

```sh
python3 durable_buzz_roster.py --apply \
  --api-base https://paperclip.gloops.ai \
  --company-id COMPANY_ID \
  --token-fd TOKEN_FD \
  --receipt /var/lib/paperclip-gloops/receipts/durable-buzz-roster/TRANSACTION.json
```

The exclusive, fsynced receipt captures the exact prior adapter type/config
without inline credentials, applies each route, and re-reads the complete
roster before completing. An interrupted or failed transaction is recovered
from live state and the prior snapshot:

```sh
python3 durable_buzz_roster.py --recover \
  --api-base https://paperclip.gloops.ai \
  --company-id COMPANY_ID \
  --token-fd TOKEN_FD \
  --receipt /var/lib/paperclip-gloops/receipts/durable-buzz-roster/TRANSACTION.json
```

Do not apply while a target is running. Do not delete or re-enroll Buzz agents:
their public keys remain the stable cross-product identity. Hermes/Ollama may
remain available as a supplemental route. Grok and Codex are not standing
defaults in this roster, but another governed assignment may select either
subscription directly without first invoking this bench. Grok failure never
silently falls through to Codex.
