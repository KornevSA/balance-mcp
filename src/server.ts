import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCustomerTools } from "./tools/customers.js";
import { registerInvoiceTools } from "./tools/invoices.js";
import { registerDocumentTools } from "./tools/documents.js";
import { registerClientFileTools } from "./tools/clientFiles.js";
import { registerMyFileTools } from "./tools/myFiles.js";
import { registerAnalyticsTools } from "./tools/analytics.js";
import { registerOrganizationTools } from "./tools/organizations.js";
import { registerContractTools } from "./tools/contracts.js";

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "balance-mcp", version: "0.1.0" });
  registerCustomerTools(server);
  registerInvoiceTools(server);
  registerDocumentTools(server);
  registerClientFileTools(server);
  registerMyFileTools(server);
  registerAnalyticsTools(server);
  registerOrganizationTools(server);
  registerContractTools(server);
  return server;
}
