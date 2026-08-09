import { execute, testEnvironment } from "./adapter.js";

export const type = "ragnos_fleet";
export const label = "RAGnos Fleet Broker";
export const models = [];

export const agentConfigurationDoc = `# RAGnos Fleet Broker

This external adapter sends bounded Paperclip work to the RAGnos Fleet Broker.

- Configure one employee with operation \`propose\` and a separate employee with
  operation \`apply\`.
- The apply employee requires an approved Paperclip approval and a structured
  \`proposal_id\` in a \`ragnos-fleet\` JSON block on the issue.
- Repository, runner, tenant, workspace, right-size, and credential authority
  remain exclusively in Fleet policy.
- The HMAC key must be supplied through a Paperclip secret reference. Never put
  it in an issue, comment, log, prompt, or result.
`;

export function getConfigSchema() {
  return {
    fields: [
      {
        key: "gatewayBaseUrl",
        label: "Fleet gateway URL",
        type: "text",
        required: true,
      },
      {
        key: "keyId",
        label: "Fleet key ID",
        type: "text",
        required: true,
      },
      {
        key: "hmacKeyB64",
        label: "Fleet HMAC key",
        type: "text",
        required: true,
        meta: { secret: true },
      },
      {
        key: "operation",
        label: "Employee operation",
        type: "select",
        required: true,
        options: [
          { value: "propose", label: "Propose" },
          { value: "apply", label: "Apply" },
        ],
      },
      {
        key: "paperclipApiUrl",
        label: "Paperclip API URL",
        type: "text",
        required: true,
        hint: "Loopback Paperclip URL used for cancellation and bounded issue disposition.",
      },
      {
        key: "pollAfterMs",
        label: "Minimum polling interval milliseconds",
        type: "number",
        default: 4000,
        hint: "Use a value compatible with the Fleet service request quota.",
      },
      {
        key: "timeoutMs",
        label: "Job timeout milliseconds",
        type: "number",
        default: 600000,
      },
      {
        key: "allowPrivateHttp",
        label: "Allow private HTTP",
        type: "toggle",
        default: false,
        hint: "Use only on a private Docker or Tailscale network. Public endpoints require HTTPS.",
      },
    ],
  };
}

export function createServerAdapter() {
  return {
    type,
    execute,
    testEnvironment,
    models,
    supportsLocalAgentJwt: true,
    supportsInstructionsBundle: false,
    requiresMaterializedRuntimeSkills: false,
    agentConfigurationDoc,
    getConfigSchema,
  };
}
