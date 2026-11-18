import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { searchOpenversePhoto } from "./photo-search.js";

test("photo search downloads a CC0 image and retains its source credit", async () => {
  const image = await readFile(new URL("../public/images/chicken.jpg", import.meta.url));
  const urls: URL[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(input.toString());
    urls.push(url);
    if (url.hostname === "api.openverse.org") {
      return Response.json({
        results: [{
          url: "https://images.example.test/photo.jpg",
          thumbnail: "https://images.example.test/thumbnail.jpg",
          foreign_landing_url: "https://example.test/photographer/photo",
          creator: "Example photographer",
          license: "cc0",
          license_url: "https://creativecommons.org/publicdomain/zero/1.0/",
        }],
      });
    }
    return new Response(image, { headers: { "content-type": "image/jpeg" } });
  };
  const result = await searchOpenversePhoto("chicken curry", {
    fetcher,
    resolve: async () => [{ address: "93.184.216.34" }],
  });
  assert.equal(urls[0].searchParams.get("q"), "chicken curry");
  assert.equal(urls[0].searchParams.get("license"), "cc0");
  assert.equal(urls[1].pathname, "/thumbnail.jpg");
  assert.equal(result.image.startsWith("data:image/jpeg;base64,"), true);
  assert.deepEqual(result.imageCredit, {
    creator: "Example photographer",
    sourceUrl: "https://example.test/photographer/photo",
    license: "CC0",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
  });
});

test("photo search rejects image sources that resolve to private addresses", async () => {
  const fetcher: typeof fetch = async (input) => {
    if (new URL(input.toString()).hostname === "api.openverse.org") {
      return Response.json({
        results: [{
          url: "https://images.example.test/photo.jpg",
          foreign_landing_url: "https://example.test/photo",
          creator: "Example photographer",
          license: "cc0",
          license_url: "https://creativecommons.org/publicdomain/zero/1.0/",
        }],
      });
    }
    throw new Error("The untrusted image host must not be fetched.");
  };
  await assert.rejects(
    searchOpenversePhoto("chicken curry", {
      fetcher,
      resolve: async () => [{ address: "127.0.0.1" }],
    }),
    /inaccessible image URL/,
  );
});
