import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { searchRecipePhoto } from "./photo-search.js";
import { recipeImageSchema } from "./recipes.js";

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
  const result = await searchRecipePhoto("chicken curry", async () => true, {
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

test("Unsplash photo search hotlinks selected photos, tracks downloads and excludes prior results", async () => {
  const image = await readFile(new URL("../public/images/chicken.jpg", import.meta.url));
  const pages: number[] = [];
  const tracked: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input.toString());
    if (url.hostname === "api.unsplash.com" && url.pathname === "/search/photos") {
      assert.equal(new Headers(init?.headers).get("authorization"), "Client-ID test-key");
      assert.equal(new Headers(init?.headers).get("accept-version"), "v1");
      pages.push(Number(url.searchParams.get("page")));
      return Response.json({
        results: ["photo-one", "photo-two"].map((id) => ({
          id,
          urls: {
            regular: `https://images.unsplash.com/${id}?auto=format&fit=crop&w=800`,
            small: `https://images.unsplash.com/${id}?auto=format&fit=crop&w=300`,
          },
          links: {
            html: `https://unsplash.com/photos/${id}`,
            download_location: `https://api.unsplash.com/photos/${id}/download`,
          },
          user: { name: "Example photographer", links: { html: "https://unsplash.com/@example" } },
        })),
      });
    }
    if (url.hostname === "api.unsplash.com") {
      tracked.push(url.pathname);
      assert.equal(new Headers(init?.headers).get("authorization"), "Client-ID test-key");
      assert.equal(new Headers(init?.headers).get("accept-version"), "v1");
      return new Response(null, { status: 200 });
    }
    return new Response(image, { headers: { "content-type": "image/jpeg" } });
  };
  const dependencies = {
    fetcher,
    unsplashAccessKey: "test-key",
    resolve: async () => [{ address: "93.184.216.34" }],
  };
  const first = await searchRecipePhoto("turkey soup unsplash test", async () => true, dependencies);
  assert.equal(first.image, "https://images.unsplash.com/photo-one?auto=format&fit=crop&w=800");
  assert.equal(recipeImageSchema.safeParse(first.image).success, true);
  assert.equal(recipeImageSchema.safeParse("https://images.example.test/photo.jpg").success, false);
  assert.equal(first.imageCredit.creator, "Example photographer");
  assert.match(first.imageCredit.sourceUrl, /utm_source=eatplanner\.app/);
  assert.match(first.imageCredit.creatorUrl ?? "", /utm_medium=referral/);
  assert.equal(first.imageCredit.license, "Unsplash License");

  const second = await searchRecipePhoto("turkey soup unsplash test", async () => true, {
    ...dependencies, excludeSourceUrls: [first.imageCredit.sourceUrl],
  });
  assert.equal(second.image, "https://images.unsplash.com/photo-two?auto=format&fit=crop&w=800");
  assert.deepEqual(pages, [1, 2]);
  assert.deepEqual(tracked, ["/photos/photo-one/download", "/photos/photo-two/download"]);
});

test("photo search falls back to Openverse when Unsplash is unavailable", async () => {
  const image = await readFile(new URL("../public/images/chicken.jpg", import.meta.url));
  const sources: string[] = [];
  const result = await searchRecipePhoto("beef brisket", async () => true, {
    unsplashAccessKey: "test-key",
    resolve: async () => [{ address: "93.184.216.34" }],
    fetcher: async (input) => {
      const url = new URL(input.toString());
      sources.push(url.hostname);
      if (url.hostname === "api.unsplash.com") return new Response(null, { status: 503 });
      if (url.hostname === "api.openverse.org") {
        return Response.json({ results: [{
          url: "https://images.example.test/beef.jpg",
          foreign_landing_url: "https://example.test/beef",
          creator: "Example photographer",
          license: "cc0",
          license_url: "https://creativecommons.org/publicdomain/zero/1.0/",
        }] });
      }
      return new Response(image, { headers: { "content-type": "image/jpeg" } });
    },
  });
  assert.ok(result.image.startsWith("data:image/jpeg;base64,"));
  assert.deepEqual(sources, ["api.unsplash.com", "api.openverse.org", "images.example.test"]);
});

test("photo search rejects image sources that resolve to private addresses", async () => {
  const fetcher: typeof fetch = async (input) => {
    if (new URL(input.toString()).hostname === "commons.wikimedia.org") {
      return Response.json({ batchcomplete: "" });
    }
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
    searchRecipePhoto("chicken curry", async () => true, {
      fetcher,
      resolve: async () => [{ address: "127.0.0.1" }],
    }),
    /photo source is unavailable/,
  );
});

test("photo search tries a broader query when the first photo is unavailable", async () => {
  const image = await readFile(new URL("../public/images/chicken.jpg", import.meta.url));
  const queries: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(input.toString());
    if (url.hostname === "api.openverse.org") {
      queries.push(url.searchParams.get("q")!);
      return Response.json({
        results: [queries.length === 1 ? "unavailable" : "working"].map((id) => ({
          url: `https://images.example.test/${id}.jpg`,
          foreign_landing_url: "https://example.test/photo",
          creator: "Example photographer",
          license: "cc0",
          license_url: "https://creativecommons.org/publicdomain/zero/1.0/",
        })),
      });
    }
    return url.pathname.includes("unavailable")
      ? new Response(null, { status: 424 })
      : new Response(image, { headers: { "content-type": "image/jpeg" } });
  };
  const result = await searchRecipePhoto(["bean burrito", "burrito"], async () => true, {
    fetcher, resolve: async () => [{ address: "93.184.216.34" }],
  });
  assert.deepEqual(queries, ["bean burrito", "burrito"]);
  assert.ok(result.image.startsWith("data:image/jpeg;base64,"));
});

test("empty photo searches return a helpful error rather than a generic server failure", async () => {
  const queries: string[] = [];
  await assert.rejects(searchRecipePhoto(["bean burrito", "burrito"], async () => true, {
    fetcher: async (input) => {
      if (new URL(input.toString()).hostname === "commons.wikimedia.org") {
        return Response.json({ batchcomplete: "" });
      }
      queries.push(new URL(input.toString()).searchParams.get("q")!);
      return Response.json({ results: [] });
    },
  }), { status: 422, message: /No suitable food-only photo/ });
  assert.deepEqual(queries, ["bean burrito", "burrito"]);
});

test("photo search visually checks the original when its thumbnail is unavailable", async () => {
  const image = await readFile(new URL("../public/images/chicken.jpg", import.meta.url));
  const downloads: string[] = [];
  let assessments = 0;
  await assert.rejects(searchRecipePhoto("burrito", async (photo) => {
    assessments++;
    assert.equal(photo.data, image.toString("base64"));
    return false;
  }, {
    resolve: async () => [{ address: "93.184.216.34" }],
    fetcher: async (input) => {
      const url = new URL(input.toString());
      if (url.hostname === "commons.wikimedia.org") {
        return Response.json({ batchcomplete: "" });
      }
      if (url.hostname === "api.openverse.org") {
        return Response.json({
          results: [{
            url: "https://images.example.test/original.jpg",
            thumbnail: "https://images.example.test/thumbnail.jpg",
            foreign_landing_url: "https://example.test/photo",
            creator: "Example photographer",
            license: "cc0",
            license_url: "https://creativecommons.org/publicdomain/zero/1.0/",
          }],
        });
      }
      downloads.push(url.pathname);
      return url.pathname === "/thumbnail.jpg"
        ? new Response(null, { status: 424 })
        : new Response(image, { headers: { "content-type": "image/jpeg" } });
    },
  }), { status: 422, message: /No suitable food-only photo/ });
  assert.deepEqual(downloads, ["/thumbnail.jpg", "/original.jpg"]);
  assert.equal(assessments, 1);
});

test("photo search only returns a candidate after visual approval", async () => {
  const image = await readFile(new URL("../public/images/chicken.jpg", import.meta.url));
  let assessments = 0;
  const result = await searchRecipePhoto(["bean burrito", "burrito"], async (photo) => {
    assert.equal(photo.mimeType, "image/jpeg");
    assert.equal(photo.data, image.toString("base64"));
    return ++assessments === 2;
  }, {
    resolve: async () => [{ address: "93.184.216.34" }],
    fetcher: async (input) => new URL(input.toString()).hostname === "api.openverse.org"
      ? Response.json({
        results: [assessments === 0 ? "person" : "food-only"].map((id) => ({
          url: `https://images.example.test/${id}.jpg`,
          foreign_landing_url: `https://example.test/${id}`,
          creator: "Example photographer",
          license: "cc0",
          license_url: "https://creativecommons.org/publicdomain/zero/1.0/",
        })),
      })
      : new Response(image, { headers: { "content-type": "image/jpeg" } }),
  });
  assert.equal(assessments, 2);
  assert.equal(result.imageCredit.sourceUrl, "https://example.test/food-only");
});

test("photo search fails closed if visual assessment rejects a photo or fails", async () => {
  const image = await readFile(new URL("../public/images/chicken.jpg", import.meta.url));
  const dependencies = {
    resolve: async () => [{ address: "93.184.216.34" }],
    fetcher: async (input: Parameters<typeof fetch>[0]) => new URL(input.toString()).hostname === "commons.wikimedia.org"
      ? Response.json({ batchcomplete: "" })
      : new URL(input.toString()).hostname === "api.openverse.org"
      ? Response.json({
        results: [{
          url: "https://images.example.test/person.jpg",
          foreign_landing_url: "https://example.test/person",
          creator: "Example photographer",
          license: "cc0",
          license_url: "https://creativecommons.org/publicdomain/zero/1.0/",
        }],
      })
      : new Response(image, { headers: { "content-type": "image/jpeg" } }),
  };
  await assert.rejects(searchRecipePhoto("burrito", async () => false, dependencies),
    { status: 422, message: /No suitable food-only photo/ });
  await assert.rejects(searchRecipePhoto("burrito", async () => {
    throw new Error("Vision model unavailable");
  }, dependencies), /Vision model unavailable/);
});

test("photo search falls back to Commons on Openverse errors without bypassing licence or visual checks", async (t) => {
  const image = await readFile(new URL("../public/images/chicken.jpg", import.meta.url));
  for (const failure of ["504", "timeout"]) {
    await t.test(failure, async () => {
      let searches = 0;
      let assessments = 0;
      const downloads: string[] = [];
      const result = await searchRecipePhoto(["bean burrito", "burrito"], async () => ++assessments === 2, {
        resolve: async () => [{ address: "93.184.216.34" }],
        fetcher: async (input) => {
          const url = new URL(input.toString());
          if (url.hostname === "api.openverse.org") {
            searches++;
            if (failure === "timeout") throw new DOMException("Search timed out", "TimeoutError");
            return new Response(null, { status: 504 });
          }
          if (url.hostname === "commons.wikimedia.org") {
            assert.match(url.searchParams.get("gsrsearch")!, /bean burrito.*incategory:CC-Zero/);
            return Response.json({
              query: {
                pages: Object.fromEntries(["CC BY 4.0", "CC0", "CC0"].map((license, index) => [String(index), {
                  index,
                  imageinfo: [{
                    url: `https://images.example.test/photo-${index}.jpg`,
                    descriptionurl: `https://commons.wikimedia.org/wiki/File:Photo-${index}.jpg`,
                    extmetadata: {
                      LicenseShortName: { value: license },
                      Artist: { value: '<a href="/wiki/User:Example">Example photographer</a>' },
                    },
                  }],
                }])),
              },
            });
          }
          downloads.push(url.pathname);
          return new Response(image, { headers: { "content-type": "image/jpeg" } });
        },
      });
      assert.equal(searches, 1, "an unavailable provider should not be queried again");
      assert.deepEqual(downloads, ["/photo-1.jpg", "/photo-2.jpg"]);
      assert.equal(assessments, 2);
      assert.deepEqual(result.imageCredit, {
        creator: "Example photographer",
        sourceUrl: "https://commons.wikimedia.org/wiki/File:Photo-2.jpg",
        license: "CC0",
        licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
      });
    });
  }
});

test("photo search reports a source outage if both providers fail", async () => {
  const sources: string[] = [];
  await assert.rejects(searchRecipePhoto("burrito", async () => {
    assert.fail("Unavailable sources cannot supply a photo for approval.");
  }, {
    fetcher: async (input) => {
      sources.push(new URL(input.toString()).hostname);
      return new Response(null, { status: 504 });
    },
  }), { status: 502, message: /photo source is unavailable.*current image is unchanged/ });
  assert.deepEqual(sources, ["api.openverse.org", "commons.wikimedia.org"]);
});

test("photo search bounds visual checks and skips photos already assessed through another source", async () => {
  const image = await readFile(new URL("../public/images/chicken.jpg", import.meta.url));
  let assessments = 0;
  const downloads: string[] = [];
  await assert.rejects(searchRecipePhoto("burrito", async () => {
    assessments++;
    return false;
  }, {
    resolve: async () => [{ address: "93.184.216.34" }],
    fetcher: async (input) => {
      const url = new URL(input.toString());
      if (url.hostname === "api.openverse.org") {
        return Response.json({ results: [{
          url: "https://images.example.test/photo-0.jpg",
          foreign_landing_url: "https://example.test/photo-0",
          license: "cc0",
          license_url: "https://creativecommons.org/publicdomain/zero/1.0/",
        }] });
      }
      if (url.hostname === "commons.wikimedia.org") {
        return Response.json({ query: {
          pages: Object.fromEntries(Array.from({ length: 8 }, (_, index) => [String(index), {
            index,
            imageinfo: [{
              url: `https://images.example.test/photo-${index}.jpg?utm_source=commons.wikimedia.org`,
              descriptionurl: `https://commons.wikimedia.org/wiki/File:Photo-${index}.jpg`,
              extmetadata: { LicenseShortName: { value: "CC0" } },
            }],
          }])),
        } });
      }
      downloads.push(url.pathname);
      return new Response(image, { headers: { "content-type": "image/jpeg" } });
    },
  }), { status: 422 });
  assert.equal(assessments, 5);
  assert.deepEqual(downloads, Array.from({ length: 5 }, (_, index) => `/photo-${index}.jpg`));
});

test("photo search stops starting work once its overall time budget expires", async (t) => {
  const image = await readFile(new URL("../public/images/chicken.jpg", import.meta.url));
  const deadline = new AbortController();
  const timeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, "timeout", (milliseconds: number) =>
    milliseconds === 85_000 ? deadline.signal : timeout(milliseconds));
  let searches = 0;
  await assert.rejects(searchRecipePhoto(["bean burrito", "burrito"], async () => {
    deadline.abort();
    return false;
  }, {
    resolve: async () => [{ address: "93.184.216.34" }],
    fetcher: async (input) => {
      if (new URL(input.toString()).hostname === "images.example.test") {
        return new Response(image, { headers: { "content-type": "image/jpeg" } });
      }
      searches++;
      return Response.json({ results: [{
        url: "https://images.example.test/photo.jpg",
        foreign_landing_url: "https://example.test/photo",
        license: "cc0",
        license_url: "https://creativecommons.org/publicdomain/zero/1.0/",
      }] });
    },
  }), { status: 504, message: /Photo search took too long/ });
  assert.equal(searches, 1);
});
