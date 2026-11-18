import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";
import { imageCreditSchema, photoSchema, type Photo } from "./recipes.js";
import { AppError } from "./planner.js";

const openverseResponseSchema = z.object({
  results: z.array(z.object({
    url: z.string().url(),
    thumbnail: z.string().url().optional(),
    foreign_landing_url: z.string().url(),
    creator: z.string().nullable().optional(),
    license: z.string(),
    license_url: z.string().url(),
  })),
});

type PhotoCandidate = z.infer<typeof openverseResponseSchema>["results"][number];
const commonsResponseSchema = z.object({
  error: z.object({ info: z.string() }).optional(),
  query: z.object({
    pages: z.record(z.string(), z.object({
      index: z.number(),
      imageinfo: z.array(z.object({
        url: z.string().url(),
        thumburl: z.string().url().optional(),
        descriptionurl: z.string().url(),
        extmetadata: z.object({
          LicenseShortName: z.object({ value: z.string() }).optional(),
          Artist: z.object({ value: z.string() }).optional(),
        }),
      })).optional(),
    })),
  }).optional(),
});

async function searchOpenverse(phrase: string, fetcher: typeof fetch): Promise<PhotoCandidate[]> {
  const url = new URL("https://api.openverse.org/v1/images/");
  url.search = new URLSearchParams({ q: phrase, license: "cc0", page_size: "1" }).toString();
  const response = await fetcher(url, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`Openverse photo search failed (${response.status}).`);
  return openverseResponseSchema.parse(await response.json()).results.slice(0, 1);
}

async function searchCommons(phrase: string, fetcher: typeof fetch): Promise<PhotoCandidate[]> {
  const url = new URL("https://commons.wikimedia.org/w/api.php");
  url.search = new URLSearchParams({
    action: "query", format: "json", generator: "search",
    gsrsearch: `${phrase} filetype:bitmap incategory:CC-Zero`,
    gsrnamespace: "6", gsrlimit: "5", prop: "imageinfo", iiprop: "url|extmetadata",
    iiurlwidth: "800", iiextmetadatafilter: "LicenseShortName|Artist",
  }).toString();
  const response = await fetcher(url, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`Wikimedia Commons photo search failed (${response.status}).`);
  const search = commonsResponseSchema.parse(await response.json());
  if (search.error) throw new Error(`Wikimedia Commons photo search failed: ${search.error.info}`);
  return Object.values(search.query?.pages ?? {})
    .sort((a, b) => a.index - b.index)
    .flatMap((page) => {
      const image = page.imageinfo?.[0];
      if (!image || image.extmetadata.LicenseShortName?.value !== "CC0") return [];
      return [{
        url: image.url,
        thumbnail: image.thumburl,
        foreign_landing_url: image.descriptionurl,
        creator: image.extmetadata.Artist?.value.replace(/<[^>]*>/g, "").trim().slice(0, 200) || "Wikimedia Commons contributor",
        license: "cc0",
        license_url: "https://creativecommons.org/publicdomain/zero/1.0/",
      }];
    });
}

function isPublicAddress(address: string) {
  const version = isIP(address);
  if (version === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b! >= 64 && b! <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    return !(
      normalized === "::" || normalized === "::1" || normalized.startsWith("::ffff:") ||
      normalized.startsWith("fc") || normalized.startsWith("fd") ||
      /^fe[89ab]/.test(normalized) || normalized.startsWith("ff") ||
      normalized.startsWith("2001:db8:")
    );
  }
  return false;
}

type ResolveAddresses = (hostname: string) => Promise<Array<{ address: string }>>;

async function assertPublicHttpsUrl(value: string, resolve: ResolveAddresses) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || isIP(url.hostname)) {
    throw new Error("The photo source returned an invalid image URL.");
  }
  const addresses = await resolve(url.hostname);
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error("The photo source returned an inaccessible image URL.");
  }
  return url;
}

async function readLimited(response: Response, maxBytes: number) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("The photo source returned an empty image.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new Error("The photo source returned an image that is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
}

export async function searchRecipePhoto(
  query: string | string[],
  approvePhoto: (photo: Photo) => Promise<boolean>,
  dependencies: { fetcher?: typeof fetch; resolve?: ResolveAddresses } = {},
) {
  const sourceFetch = dependencies.fetcher ?? fetch;
  const deadline = AbortSignal.timeout(85_000);
  const fetcher: typeof fetch = (input, init) => sourceFetch(input, {
    ...init,
    signal: AbortSignal.any([deadline, ...(init?.signal ? [init.signal] : [])]),
  });
  const resolve = dependencies.resolve ?? (async (hostname) => lookup(hostname, { all: true, verbatim: true }));
  let lastError: unknown;
  let candidates = 0;
  const seen = new Set<string>();
  sources: for (const source of [searchOpenverse, searchCommons]) {
    for (const phrase of new Set(typeof query === "string" ? [query] : query)) {
      if (candidates >= 5 || deadline.aborted) break sources;
      let results: PhotoCandidate[];
      try {
        results = await source(phrase, fetcher);
      } catch (error) {
        console.error(`[eatplanner.app] ${source.name} failed:`, error instanceof Error ? error.message : "Unexpected search error");
        lastError = error;
        break;
      }
      for (const result of results) {
        if (candidates >= 5 || deadline.aborted) break sources;
        const key = new URL(result.url);
        for (const name of [...key.searchParams.keys()]) {
          if (name.startsWith("utm_")) key.searchParams.delete(name);
        }
        if (seen.has(key.href)) continue;
        seen.add(key.href);
        candidates++;
        let downloaded: Awaited<ReturnType<typeof downloadPhoto>>;
        try {
          downloaded = await downloadPhoto(result, fetcher, resolve);
        } catch (error) {
          console.error("[eatplanner.app] Photo candidate failed:", error instanceof Error ? error.message : "Unexpected download error");
          lastError = error;
          continue;
        }
        if (!await approvePhoto(downloaded.photo)) {
          console.info("[eatplanner.app] Rejected a photo that did not show the recipe without people.");
          continue;
        }
        return {
          image: `data:${downloaded.photo.mimeType};base64,${downloaded.photo.data}`,
          imageCredit: downloaded.imageCredit,
        };
      }
    }
  }
  if (deadline.aborted) {
    throw new AppError(504, "Photo search took too long. Your current image is unchanged. Please try again later.");
  }
  if (lastError) {
    throw new AppError(502, "No suitable photo was found. A photo source is unavailable. Your current image is unchanged. Please try again later.");
  }
  throw new AppError(422, "No suitable public-domain food-only photo was found for this recipe. Photos with people or an uncertain match are not used. Your current image is unchanged.");
}

async function downloadPhoto(
  result: PhotoCandidate,
  fetcher: typeof fetch,
  resolve: ResolveAddresses,
) {
  if (result.license.toLowerCase() !== "cc0") {
    throw new Error("The photo search returned an image without a public-domain licence.");
  }

  const credit = imageCreditSchema.parse({
    creator: result.creator?.trim() || "Openverse contributor",
    sourceUrl: result.foreign_landing_url,
    license: result.license.toUpperCase(),
    licenseUrl: result.license_url,
  });
  let lastError: unknown;
  for (const url of new Set(result.thumbnail ? [result.thumbnail, result.url] : [result.url])) {
    try {
      return { photo: await downloadImage(url, fetcher, resolve), imageCredit: credit };
    } catch (error) {
      console.error("[eatplanner.app] Image source failed:", error instanceof Error ? error.message : "Unexpected download error");
      lastError = error;
    }
  }
  throw lastError;
}

async function downloadImage(url: string, fetcher: typeof fetch, resolve: ResolveAddresses) {
  const imageUrl = await assertPublicHttpsUrl(url, resolve);
  const imageResponse = await fetcher(imageUrl, {
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (!imageResponse.ok) throw new Error(`The photo could not be downloaded (${imageResponse.status}).`);
  const mimeType = imageResponse.headers.get("content-type")?.split(";")[0]?.trim();
  if (!["image/jpeg", "image/png", "image/webp"].includes(mimeType ?? "")) {
    throw new Error("The photo source returned an unsupported image format.");
  }
  const bytes = await readLimited(imageResponse, 2_100_000);
  return photoSchema.parse({ mimeType, data: bytes.toString("base64") });
}
