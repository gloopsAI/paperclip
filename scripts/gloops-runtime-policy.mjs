const EXPECTED_HERMES_CAPABILITIES = [
  "CHOWN",
  "DAC_OVERRIDE",
  "SETGID",
  "SETUID",
  "KILL",
];

export function validateHermesRuntimePrivileges(service) {
  const errors = [];
  const capOptionCount = (service.match(/--cap-add\b/gi) ?? []).length;
  const capabilities = [
    ...service.matchAll(/--cap-add(?:=|\s+)([^\s\\]+)/gi),
  ].map((match) => match[1].toUpperCase());

  if (capabilities.length !== capOptionCount) {
    errors.push("Hermes execution service contains an unparsed capability option");
  }
  if (new Set(capabilities).size !== capabilities.length) {
    errors.push("Hermes execution service contains a duplicate capability option");
  }
  if (JSON.stringify(capabilities) !== JSON.stringify(EXPECTED_HERMES_CAPABILITIES)) {
    errors.push("Hermes execution service capability allowlist is not exact");
  }
  if (/--privileged(?:\b|=)/i.test(service)) {
    errors.push("Hermes execution service must not use privileged mode");
  }
  if (/--pid(?:=|\s+)/i.test(service)) {
    errors.push("Hermes execution service must not override the private PID namespace");
  }

  return errors;
}
