import nodeFetch from "node-fetch";
import { Readable } from "node:stream";

export async function compatibleFetch(input, init) {
  const response = await nodeFetch(input, init);
  const bodyAllowed = ![204, 205, 304].includes(response.status);
  return new Response(
    bodyAllowed && response.body ? Readable.toWeb(response.body) : null,
    {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    },
  );
}
