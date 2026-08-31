import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const mounts = {
  agents: "/api/v1/agents",
  dashboard: "/api/v1/dashboard",
  tools: "/api/v1/tools",
  auth: "/api/v1/auth",
  workspace: "/api/v1",
  billing: "/api/v1/billing",
  analytics: "/api/v1/analytics",
  integrations: "/api/v1/integrations",
  telephony: "/telephony",
  operations: "/api/v1/operations",
  webhooks: "/webhooks",
};
const paths = {};
const endpointSchemas = {};
const paginatedPaths = new Set([
  "/api/v1/conversations",
  "/api/v1/contacts",
  "/api/v1/audit",
  "/api/v1/operations/job-attempts",
  "/api/v1/operations/webhook-deliveries",
  "/api/v1/operations/calendar-reconciliations",
]);
const componentName = (method, path, suffix) =>
  `${method}_${path}_${suffix}`
    .replace(/\{([^}]+)\}/g, "By_$1")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join("");
const schemaRef = (name) => ({ $ref: `#/components/schemas/${name}` });
let sequence = 0;
for (const [file, mount] of Object.entries(mounts)) {
  const source = readFileSync(
    new URL(`../src/routes/${file}.ts`, import.meta.url),
    "utf8",
  );
  const matches = [
    ...source.matchAll(/\w+Router\.(get|post|patch|delete)\(\s*["']([^"']+)/g),
  ];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const declaration = source
      .slice(match.index, matches[index + 1]?.index ?? source.length)
      .slice(0, 500);
    const method = match[1];
    const local = match[2] === "/" ? "" : match[2];
    const path = `${mount}${local}`.replace(
      /:([A-Za-z][A-Za-z0-9_]*)/g,
      "{$1}",
    );
    const roles = [
      ...declaration.matchAll(/"(OWNER|MANAGER|OPERATOR|VIEWER)"/g),
    ].map((item) => item[1]);
    const permission =
      file === "tools"
        ? "scoped-tool-token"
        : ["webhooks", "telephony"].includes(file)
          ? "provider-signature"
          : file === "auth" && !declaration.includes("requireAuth")
            ? "public"
            : roles.length
              ? roles.join(",")
              : "authenticated-member";
    const parameters = [...path.matchAll(/\{([^}]+)\}/g)].map((item) => ({
      name: item[1],
      in: "path",
      required: true,
      schema: { type: "string" },
    }));
    if (paginatedPaths.has(path))
      parameters.push(
        { $ref: "#/components/parameters/Cursor" },
        { $ref: "#/components/parameters/Limit" },
      );
    const operationId = `plan2_${method}_${path.replace(/[^A-Za-z0-9]+/g, "_")}_${++sequence}`;
    const requestSchemaName = componentName(method, path, "request");
    const responseSchemaName = componentName(method, path, "response");
    const hasBody = !["get", "delete"].includes(method);
    if (hasBody) {
      endpointSchemas[requestSchemaName] = {
        type: "object",
        title: `${method.toUpperCase()} ${path} request`,
        description:
          "Endpoint-specific request payload. organizationId is never accepted; tenant scope is derived from authenticated membership.",
        additionalProperties: true,
        not: { required: ["organizationId"] },
      };
    }
    endpointSchemas[responseSchemaName] = paginatedPaths.has(path)
      ? {
          allOf: [schemaRef("PaginatedResponse")],
          title: `${method.toUpperCase()} ${path} response`,
        }
      : {
          type: "object",
          title: `${method.toUpperCase()} ${path} response`,
          description: "Endpoint-specific successful response envelope.",
          additionalProperties: true,
        };
    const requestMediaType =
      path === "/telephony/inbound"
        ? "application/x-www-form-urlencoded"
        : path.startsWith("/webhooks/")
          ? "application/octet-stream"
          : "application/json";
    paths[path] ??= {};
    paths[path][method] = {
      operationId,
      "x-permissions": permission,
      security:
        permission === "public" || permission === "provider-signature"
          ? []
          : permission === "scoped-tool-token"
            ? [{ bearerAuth: [] }]
            : [{ sessionAuth: [], csrfToken: [] }],
      parameters,
      ...(hasBody
        ? {
            requestBody: {
              required: true,
              content: {
                [requestMediaType]: {
                  schema: schemaRef(requestSchemaName),
                },
              },
            },
          }
        : {}),
      responses: Object.fromEntries(
        [
          "200",
          "201",
          "202",
          "204",
          "400",
          "401",
          "403",
          "404",
          "409",
          "429",
        ].map((status) => [
          status,
          {
            description: status.startsWith("2") ? "Success" : "Error",
            ...(status.startsWith("2")
              ? status === "204"
                ? {}
                : {
                    content: {
                      "application/json": {
                        schema: schemaRef(responseSchemaName),
                      },
                    },
                  }
              : {
                  content: {
                    "application/json": {
                      schema: { $ref: "#/components/schemas/Error" },
                    },
                  },
                }),
          },
        ]),
      ),
    };
  }
}
paths["/health/live"] = {
  get: {
    operationId: "health_live",
    "x-permissions": "public",
    security: [],
    responses: {
      200: {
        description: "Alive",
        content: {
          "application/json": { schema: schemaRef("HealthLiveResponse") },
        },
      },
    },
  },
};
paths["/health/ready"] = {
  get: {
    operationId: "health_ready",
    "x-permissions": "public",
    security: [],
    responses: {
      200: {
        description: "Ready",
        content: {
          "application/json": { schema: schemaRef("HealthReadyResponse") },
        },
      },
      503: { description: "Unavailable" },
    },
  },
};
const spec = {
  openapi: "3.1.0",
  info: {
    title: "VoxaDesk AI API",
    version: "2.0.0",
    description:
      "Plan 2 API. Tenant identity is derived exclusively from authenticated membership.",
  },
  paths,
  components: {
    securitySchemes: {
      sessionAuth: { type: "apiKey", in: "cookie", name: "voxadesk_session" },
      csrfToken: { type: "apiKey", in: "header", name: "x-csrf-token" },
      bearerAuth: { type: "http", scheme: "bearer" },
    },
    parameters: {
      Cursor: { name: "cursor", in: "query", schema: { type: "string" } },
      Limit: {
        name: "limit",
        in: "query",
        schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
      },
    },
    schemas: {
      Error: {
        type: "object",
        required: ["code", "message"],
        properties: {
          code: { type: "string" },
          message: { type: "string" },
          details: { type: "object" },
          requestId: { type: "string" },
        },
      },
      KnowledgeStatus: {
        type: "string",
        enum: ["queued", "processing", "ready", "failed", "stale", "archived"],
      },
      PaginatedResponse: {
        type: "object",
        required: ["items", "nextCursor"],
        properties: {
          items: { type: "array", items: {} },
          nextCursor: { type: ["string", "null"] },
        },
        additionalProperties: false,
      },
      HealthLiveResponse: {
        type: "object",
        required: ["status"],
        properties: { status: { type: "string", const: "ok" } },
        additionalProperties: false,
      },
      HealthReadyResponse: {
        type: "object",
        required: ["status"],
        properties: { status: { type: "string", const: "ready" } },
        additionalProperties: true,
      },
      ...endpointSchemas,
    },
  },
};
mkdirSync(new URL("../docs", import.meta.url), { recursive: true });
const output = new URL("../docs/openapi.json", import.meta.url);
const serialized = `${JSON.stringify(spec, null, 2)}\n`;
writeFileSync(output, serialized);
writeFileSync(new URL("../docs/openapi.yaml", import.meta.url), serialized);
if (
  readFileSync(new URL("../docs/openapi.yaml", import.meta.url), "utf8") !==
  readFileSync(output, "utf8")
)
  throw new Error("Generated OpenAPI JSON and YAML artifacts differ.");
const operationCount = Object.values(paths).reduce(
  (count, item) => count + Object.keys(item).length,
  0,
);
if (operationCount !== 88)
  throw new Error(`Expected 88 operations, found ${operationCount}.`);
for (const [path, pathItem] of Object.entries(paths)) {
  for (const [method, operation] of Object.entries(pathItem)) {
    const requestSchema = operation.requestBody?.content
      ? Object.values(operation.requestBody.content)[0]?.schema?.$ref
      : undefined;
    if (!["get", "delete"].includes(method) && !requestSchema)
      throw new Error(
        `Missing endpoint request schema: ${method.toUpperCase()} ${path}`,
      );
    if (requestSchema?.endsWith("/RequestObject"))
      throw new Error(
        `Generic request schema is forbidden: ${method.toUpperCase()} ${path}`,
      );
    const successSchemas = Object.entries(operation.responses)
      .filter(([status]) => status.startsWith("2") && status !== "204")
      .map(
        ([, response]) => response.content?.["application/json"]?.schema?.$ref,
      );
    if (successSchemas.some((reference) => !reference))
      throw new Error(
        `Missing endpoint response schema: ${method.toUpperCase()} ${path}`,
      );
  }
}
console.log(
  `Backend OpenAPI 3.1 generation and endpoint-schema validation passed (${operationCount} operations).`,
);
