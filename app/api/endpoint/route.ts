import { handleEndpointRequest } from "../../utils/endpoint-proxy";
import { hasValidAccessCode } from "../auth";

const handle = (request: Request) => {
  if (!hasValidAccessCode(request)) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "x-nextchat-auth-error": "1" },
    });
  }
  return handleEndpointRequest(request);
};
export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const HEAD = handle;
export const runtime = "edge";
