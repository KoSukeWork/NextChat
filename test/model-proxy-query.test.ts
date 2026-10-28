/** @jest-environment node */
import { jest } from "@jest/globals";
import { NextRequest } from "next/server";
import { handle as siliconflow } from "../app/api/siliconflow";
import { handle as ai302 } from "../app/api/302ai";

const mockedFetch = jest.mocked(global.fetch);

test.each([
  ["/api/siliconflow/v1/models?sub_type=chat", siliconflow, "sub_type", "chat"],
  ["/api/302ai/v1/models?llm=1", ai302, "llm", "1"],
] as const)(
  "model proxy forwards query for %s",
  async (path, handle, parameter, value) => {
    mockedFetch.mockClear();
    mockedFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const request = new NextRequest(`http://localhost${path}`, {
      headers: { Authorization: "Bearer test-proxy-key" },
    });
    const response = await handle(request, {
      params: { path: ["v1", "models"] },
    });
    expect(response.status).toBe(200);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const upstream = new URL(String(mockedFetch.mock.calls[0][0]));
    expect(upstream.pathname).toBe("/v1/models");
    expect(upstream.searchParams.get(parameter)).toBe(value);
  },
);
