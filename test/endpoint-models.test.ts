/** @jest-environment node */
import { fetchEndpointModels } from "../app/client/endpoint-models";
import type { Endpoint } from "../app/utils/endpoints";

const endpoint: Endpoint = {
  id: "1",
  name: "Test",
  protocol: "openai-chat",
  baseUrl: "https://example.test",
  apiKey: "key",
  models: [],
};

test("OpenAI compatible discovery returns distinct model names", async () => {
  let requested = "";
  const models = await fetchEndpointModels(endpoint, async (url) => {
    requested = url;
    return Response.json({ data: [{ id: "a" }, { id: "a" }, { id: "b" }] });
  });
  expect(requested).toBe("https://example.test/v1/models");
  expect(models).toEqual([{ name: "a" }, { name: "b" }]);
});

test("Anthropic discovery follows pagination and retains display names", async () => {
  const urls: string[] = [];
  const models = await fetchEndpointModels(
    { ...endpoint, protocol: "anthropic" },
    async (url, options) => {
      urls.push(url);
      expect(new Headers(options?.headers).get("x-api-key")).toBe("key");
      return Response.json(
        urls.length === 1
          ? {
              data: [{ id: "a", display_name: "Alpha" }],
              has_more: true,
              last_id: "a",
            }
          : { data: [{ id: "b" }], has_more: false },
      );
    },
  );
  expect(models).toEqual([{ name: "a", displayName: "Alpha" }, { name: "b" }]);
  expect(urls[1]).toContain("after_id=a");
});

test("Gemini discovery filters generation-capable models and follows pages", async () => {
  let page = 0;
  const models = await fetchEndpointModels(
    { ...endpoint, protocol: "gemini" },
    async () =>
      Response.json(
        ++page === 1
          ? {
              models: [
                {
                  name: "models/yes",
                  supportedGenerationMethods: ["generateContent"],
                },
                {
                  name: "models/no",
                  supportedGenerationMethods: ["embedContent"],
                },
              ],
              nextPageToken: "next",
            }
          : {
              models: [
                {
                  name: "models/next",
                  supportedGenerationMethods: ["generateContent"],
                },
              ],
            },
      ),
  );
  expect(models).toEqual([{ name: "yes" }, { name: "next" }]);
});

test("discovery surfaces HTTP errors", async () => {
  await expect(
    fetchEndpointModels(
      endpoint,
      async () => new Response("bad key", { status: 401 }),
    ),
  ).rejects.toThrow("HTTP 401: bad key");
});
