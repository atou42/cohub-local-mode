import nodeFetch from "node-fetch";
import { Readable } from "node:stream";

export async function compatibleFetch(input, init) {
  const response = await nodeFetch(input, init);
  return new Response(
    response.body ? Readable.toWeb(response.body) : null,
    {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    },
  );
}
