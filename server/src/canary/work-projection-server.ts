import { createServer } from "node:http";
import {
  createCompanyWorkProjectionCanaryApp,
  type CompanyWorkProjectionCanaryFixture,
} from "./company-work-projection-app.js";

const ACKNOWLEDGEMENT = "NON_PRODUCTION_GET_ONLY";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

if (process.env.PAPERCLIP_WORK_PROJECTION_CANARY_ACK !== ACKNOWLEDGEMENT) {
  throw new Error(`PAPERCLIP_WORK_PROJECTION_CANARY_ACK must equal ${ACKNOWLEDGEMENT}`);
}

const companyId = required("PAPERCLIP_WORK_PROJECTION_CANARY_COMPANY_ID");
const fixture = required("PAPERCLIP_WORK_PROJECTION_CANARY_FIXTURE") as CompanyWorkProjectionCanaryFixture;
const token = required("PAPERCLIP_WORK_PROJECTION_CANARY_TOKEN");
const host = process.env.HOST?.trim() || "127.0.0.1";
const port = Number(process.env.PORT ?? "3100");
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

const app = createCompanyWorkProjectionCanaryApp({ companyId, fixture, token });
const server = createServer(app);

server.listen(port, host, () => {
  process.stdout.write(`${JSON.stringify({
    event: "work_projection_canary_ready",
    contract: "paperclip.company-work-projection-canary/v1",
    host,
    port,
    companyId,
    fixture,
    databaseConnections: 0,
    persistentFiles: 0,
  })}\n`);
});

function stop(signal: string) {
  server.close((error) => {
    process.stdout.write(`${JSON.stringify({
      event: "work_projection_canary_stopped",
      signal,
      databaseConnections: 0,
      databaseWrites: 0,
      persistentFileWrites: 0,
      providerMutations: 0,
      schedulerTasks: 0,
    })}\n`);
    process.exitCode = error ? 1 : 0;
  });
}

process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));
