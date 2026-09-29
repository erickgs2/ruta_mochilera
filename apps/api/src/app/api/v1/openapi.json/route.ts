import { buildOpenApiDocument } from '../../../../lib/openapi/registry';

/** Serves the generated OpenAPI document. Consumed by `tools/generate-api-client.ts`, not by end users. */
export async function GET(): Promise<Response> {
  return Response.json(buildOpenApiDocument());
}
